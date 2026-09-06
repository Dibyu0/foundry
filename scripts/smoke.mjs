#!/usr/bin/env node
/**
 * Foundry end-to-end smoke test.
 *
 * Starts the built server (server/dist/index.js) on ephemeral ports with a
 * throwaway FOUNDRY_DATA_DIR, drives a full build lifecycle over HTTPS against
 * the mock provider, and asserts the security-sensitive surface: preview CSP,
 * path-traversal confinement, zip download, key hygiene in /api/config, and
 * the HTTP -> HTTPS redirect.
 *
 * After the base lifecycle it also smokes the wave-2 features: follow-up
 * edits, checkpoints (list + restore), the share page, fixError, the
 * serve-time preview bridge, and that the zip download stays bridge-free.
 *
 * Requires `npm run build` first. Exits non-zero if any step fails.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SERVER_ENTRY = join(ROOT, 'server', 'dist', 'index.js');

// A distinctive canary key: if this string ever shows up in an API response,
// key hygiene has regressed.
const CANARY_KEY = 'foundry-smoke-canary-key-9f8e7d6c5b4a';
const BRIEF = 'a landing page for a coffee subscription startup';

// Markers for the serve-time preview bridge (BRIDGE area: previewInject.ts).
// If the shipped marker differs, align this list — the bridge step and the
// bridge-free-download step both match against it.
const BRIDGE_MARKERS = [
  '__FOUNDRY_PREVIEW_BRIDGE__',
  'foundry-preview-bridge',
  'data-foundry-bridge',
  'foundryPreviewBridge',
];
const BRIDGE_RE = new RegExp(
  BRIDGE_MARKERS.map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
  'i',
);

// Banner signature for the share page (SHARE area: routes/share.ts injects
// <div id="foundry-share-bar"> with a "Built with Foundry" brand). Align with
// the shipped banner markup if it carries a different signature.
const SHARE_BANNER_RE =
  /(foundry[-\s]?share[-\s]?(?:bar|banner)|data-foundry-share|shared (?:with|via) foundry|(?:made|built) with foundry|share-banner)/i;

const CORE_FILES = ['index.html', 'styles.css', 'app.js'];

const results = [];
let child = null;
let dataDir = null;
const streams = [];

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function fail(phase, detail) {
  throw new Error(`${phase}: ${detail}`);
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

// Raw HTTP(S) request. Paths are sent verbatim (no client-side URL
// normalization) so traversal probes reach the server intact. TLS verification
// is disabled per-connection — the dev cert is self-signed on purpose.
function rawRequest({ protocol = 'https:', method = 'GET', port, path, body, headers = {} }) {
  return new Promise((resolve, reject) => {
    const mod = protocol === 'http:' ? http : https;
    const req = mod.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        headers,
        rejectUnauthorized: false,
        agent: false,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
        );
      },
    );
    req.on('error', reject);
    req.setTimeout(15_000, () => req.destroy(new Error(`request timed out: ${method} ${path}`)));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function apiJson({ method = 'GET', port, path, json }) {
  const headers = {};
  let body;
  if (json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(json);
  }
  const res = await rawRequest({ method, port, path, body, headers });
  let parsed = null;
  const text = res.body.toString('utf8');
  try {
    parsed = JSON.parse(text);
  } catch {
    /* non-JSON is fine for some endpoints; callers inspect raw body */
  }
  return { status: res.status, headers: res.headers, text, json: parsed };
}

// Poll `fn` until it returns a truthy value or the deadline passes.
async function waitFor(label, fn, timeoutMs, intervalMs = 400) {
  const deadline = Date.now() + timeoutMs;
  let lastNote = 'no observation yet';
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      lastNote = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  fail(label, `timed out after ${timeoutMs}ms (${lastNote})`);
}

function fileNames(files) {
  if (!Array.isArray(files)) return [];
  return files
    .map((f) => (typeof f === 'string' ? f : (f?.path ?? f?.name ?? '')))
    .filter(Boolean);
}

function planSteps(plan) {
  if (!plan) return [];
  if (Array.isArray(plan)) return plan;
  if (Array.isArray(plan.steps)) return plan.steps;
  return [];
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Minimal SSE client for /api/builds/:id/events. The hub drops a build's
// channel when a run reaches DONE, so a stream opened after DONE carries only
// what the next run (edit / fixError / restore) emits. Callers still drain
// briefly and mark() before triggering work, in case a previous run re-emitted
// into a fresh channel that would otherwise replay here and false-pass the
// "a file event fired" assertions.
// ?raw=1 asks the hub for the verbatim stream (sse.ts coalesces same-type
// runs of file/activity into {type:'batch'} frames by default); batch frames
// are also unwrapped defensively so file events can never hide inside one.
function openEventStream(port, id) {
  const events = [];
  const req = https.request(
    {
      host: '127.0.0.1',
      port,
      path: `/api/builds/${id}/events?raw=1`,
      method: 'GET',
      headers: { accept: 'text/event-stream' },
      rejectUnauthorized: false,
      agent: false,
    },
    (res) => {
      let pending = '';
      res.on('data', (chunk) => {
        pending += chunk.toString('utf8');
        let cut;
        while ((cut = pending.indexOf('\n\n')) !== -1) {
          const block = pending.slice(0, cut);
          pending = pending.slice(cut + 2);
          for (const line of block.split('\n')) {
            if (!line.startsWith('data:')) continue;
            try {
              const parsed = JSON.parse(line.slice(5).trim());
              if (parsed?.type === 'batch' && Array.isArray(parsed?.events)) events.push(...parsed.events);
              else events.push(parsed);
            } catch {
              /* heartbeat/comment lines carry no data payload */
            }
          }
        }
      });
      res.on('error', () => {});
    },
  );
  req.on('error', () => {}); // destroyed deliberately during teardown
  req.end();
  return {
    mark: () => events.length,
    since: (mark) => events.slice(mark),
    close: () => req.destroy(),
  };
}

// Strips injected bridge tags so content comparisons test the site itself,
// never the serve-time injection.
function stripBridge(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, (tag) => (BRIDGE_RE.test(tag) ? '' : tag))
    .replace(/<link\b[^>]*>/gi, (tag) => (BRIDGE_RE.test(tag) ? '' : tag));
}

// Fetches the core site files through the preview route, bridge-stripped.
async function fetchSiteContents(port, id) {
  const out = {};
  for (const name of CORE_FILES) {
    const res = await rawRequest({ port, path: `/preview/${id}/${name}` });
    if (res.status !== 200) fail('site snapshot', `GET /preview/${id}/${name} -> ${res.status}`);
    const text = res.body.toString('utf8');
    out[name] = name.endsWith('.html') ? stripBridge(text) : text;
  }
  return out;
}

// Minimal zip reader (EOCD -> central directory -> local header -> inflate) so
// the smoke can inspect index.html inside the download without a dependency.
function unzipEntry(buf, wanted) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0 || eocd + 22 > buf.length) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i += 1) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) return null;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    if (name === wanted) {
      if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== 0x04034b50) return null;
      const dataStart = localOff + 30 + buf.readUInt16LE(localOff + 26) + buf.readUInt16LE(localOff + 28);
      const data = buf.subarray(dataStart, dataStart + compSize);
      if (method === 0) return Buffer.from(data);
      if (method === 8) {
        try {
          return inflateRawSync(data);
        } catch {
          return null;
        }
      }
      return null;
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

function checkpointList(json) {
  if (Array.isArray(json)) return json;
  if (json && Array.isArray(json.checkpoints)) return json.checkpoints;
  return [];
}

// Checkpoint identity on the wire (routes/checkpoints.ts) is the 1-based
// sequence number `n`; id/checkpointId/name are tolerated alternate shapes.
function checkpointIdOf(cp) {
  return cp?.n ?? cp?.id ?? cp?.checkpointId ?? cp?.name;
}

function checkpointTsOf(cp) {
  const n = Number(cp?.createdAt ?? cp?.ts ?? cp?.time ?? cp?.created ?? 0);
  return Number.isFinite(n) ? n : 0;
}

async function main() {
  if (!existsSync(SERVER_ENTRY)) {
    fail('prerequisite', `${SERVER_ENTRY} not found — run \`npm run build\` first`);
  }

  const httpsPort = await getFreePort();
  const httpPort = await getFreePort();

  dataDir = mkdtempSync(join(tmpdir(), 'foundry-smoke-'));
  mkdirSync(dataDir, { recursive: true });
  // Pre-seed the mock provider and a canary secret before the server boots.
  writeFileSync(
    join(dataDir, 'foundry.config.json'),
    JSON.stringify({ provider: 'mock', endpoint: '', model: 'mock' }, null, 2),
  );
  writeFileSync(join(dataDir, 'secrets.json'), JSON.stringify({ apiKey: CANARY_KEY }), {
    mode: 0o600,
  });

  console.log(`smoke: httpsPort=${httpsPort} httpPort=${httpPort} dataDir=${dataDir}`);

  child = spawn(process.execPath, [SERVER_ENTRY], {
    env: {
      ...process.env,
      FOUNDRY_HTTPS_PORT: String(httpsPort),
      FOUNDRY_HTTP_PORT: String(httpPort),
      FOUNDRY_DATA_DIR: dataDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  child.stdout.on('data', (d) => (serverLog += d));
  child.stderr.on('data', (d) => (serverLog += d));
  child.on('exit', (code, signal) => {
    if (code !== null && code !== 0) {
      console.error(`smoke: server exited early (code=${code} signal=${signal})\n${serverLog}`);
    }
  });

  try {
    // --- boot -------------------------------------------------------------
    const cfg = await waitFor(
      'server boot',
      async () => {
        const res = await apiJson({ port: httpsPort, path: '/api/config' });
        return res.status === 200 ? res : null;
      },
      20_000,
    );
    record('server boots and serves /api/config over HTTPS', true);

    // --- key hygiene ------------------------------------------------------
    const cfgText = cfg.text;
    if (cfgText.includes(CANARY_KEY)) {
      fail('key hygiene', '/api/config response contains the apiKey value');
    }
    if (cfg.json && typeof cfg.json === 'object' && 'apiKey' in cfg.json) {
      fail('key hygiene', '/api/config response has an apiKey property');
    }
    if (!cfg.json || cfg.json.provider !== 'mock') {
      fail('key hygiene', `expected provider=mock from seeded config, got: ${cfgText.slice(0, 200)}`);
    }
    record('/api/config never exposes the apiKey', true, `hasKey=${cfg.json.hasKey}`);

    // --- build lifecycle --------------------------------------------------
    const created = await apiJson({
      method: 'POST',
      port: httpsPort,
      path: '/api/builds',
      json: { brief: BRIEF },
    });
    if (created.status !== 202 || !created.json?.id) {
      fail('create build', `expected 202 {id}, got ${created.status}: ${created.text.slice(0, 200)}`);
    }
    const id = created.json.id;
    record('POST /api/builds returns 202 + id', true, `id=${id}`);

    const getState = async () => {
      const res = await apiJson({ port: httpsPort, path: `/api/builds/${id}` });
      if (res.status !== 200) fail('state poll', `GET /api/builds/${id} -> ${res.status}`);
      if (res.json?.phase === 'ERROR') fail('build', `server reported ERROR: ${res.json.error ?? 'unknown'}`);
      return res.json;
    };

    const questionState = await waitFor(
      'clarifying question',
      async () => {
        const s = await getState();
        return s.pendingQuestion ? s : null;
      },
      30_000,
    );
    const firstQuestion = questionState.pendingQuestion;
    record('agent asks a clarifying question', true, JSON.stringify(firstQuestion).slice(0, 120));

    // Answer every question the agents raise (the mock planner asks two)
    // until a plan shows up; the orchestrator may surface them one at a time.
    const answers = [
      'We roast small-batch single-origin beans and ship monthly.',
      'Clean and minimal, warm earth tones.',
      'Focus on the subscription call-to-action.',
    ];
    const answeredIds = new Set();
    let answersSent = 0;
    const planState = await waitFor(
      'plan',
      async () => {
        const s = await getState();
        if (s.plan) return s;
        const q = s.pendingQuestion;
        const qid = q && (q.id ?? q.questionId);
        if (q && qid && !answeredIds.has(qid)) {
          const res = await apiJson({
            method: 'POST',
            port: httpsPort,
            path: `/api/builds/${id}/answer`,
            json: { questionId: qid, answer: answers[answersSent % answers.length] },
          });
          if (res.status < 200 || res.status >= 300) {
            fail('answer', `POST answer -> ${res.status}: ${res.text.slice(0, 200)}`);
          }
          answeredIds.add(qid);
          answersSent += 1;
        }
        return null;
      },
      45_000,
    );
    record('answers accepted', true, `${answersSent} question(s) answered`);
    const steps = planSteps(planState.plan);
    if (steps.length < 3) {
      fail('plan', `expected >= 3 plan steps, got ${steps.length}: ${JSON.stringify(planState.plan).slice(0, 300)}`);
    }
    record('plan produced with >= 3 steps', true, `${steps.length} steps`);

    const approved = await apiJson({
      method: 'POST',
      port: httpsPort,
      path: `/api/builds/${id}/approve`,
      json: {},
    });
    if (approved.status < 200 || approved.status >= 300) {
      fail('approve', `POST approve -> ${approved.status}: ${approved.text.slice(0, 200)}`);
    }
    record('plan approved', true);

    const doneState = await waitFor(
      'build completion',
      async () => {
        const s = await getState();
        return s.phase === 'DONE' ? s : null;
      },
      60_000,
    );
    record('build reaches DONE', true);

    // --- site output ------------------------------------------------------
    const names = fileNames(doneState.files);
    const missing = ['index.html', 'styles.css', 'app.js'].filter((n) => !names.includes(n));
    if (missing.length > 0) {
      fail('site files', `missing ${missing.join(', ')} — files: ${names.join(', ') || '(none)'}`);
    }
    record('site contains index.html, styles.css, app.js', true, `${names.length} files`);

    // --- preview: CSP + traversal ----------------------------------------
    const preview = await rawRequest({ port: httpsPort, path: `/preview/${id}/` });
    const ctype = String(preview.headers['content-type'] ?? '');
    if (preview.status !== 200 || !ctype.includes('text/html')) {
      fail('preview', `GET /preview/${id}/ -> ${preview.status} content-type=${ctype}`);
    }
    if (!preview.headers['content-security-policy']) {
      fail('preview', 'preview response has no Content-Security-Policy header');
    }
    record('GET /preview/<id>/ serves HTML with CSP', true, preview.headers['content-security-policy']);

    for (const probe of [
      `/preview/${id}/../package.json`,
      `/preview/${id}/..%2f..%2fpackage.json`,
    ]) {
      const res = await rawRequest({ port: httpsPort, path: probe });
      if (res.status !== 403 && res.status !== 404) {
        fail('traversal', `${probe} -> ${res.status} (expected 403/404)\n${res.body.toString('utf8').slice(0, 200)}`);
      }
    }
    record('path traversal outside the site root is refused', true);

    // --- download ---------------------------------------------------------
    const zip = await rawRequest({ port: httpsPort, path: `/api/builds/${id}/download` });
    if (zip.status !== 200 || zip.body.length < 4 || zip.body[0] !== 0x50 || zip.body[1] !== 0x4b) {
      fail('download', `expected 200 zip starting with PK, got ${zip.status} len=${zip.body.length}`);
    }
    record('GET /api/builds/<id>/download returns a zip', true, `${zip.body.length} bytes`);

    // --- HTTP -> HTTPS redirect -------------------------------------------
    const redir = await rawRequest({ protocol: 'http:', port: httpPort, path: '/' });
    const location = String(redir.headers['location'] ?? '');
    if (redir.status !== 301 || !location.startsWith('https://')) {
      fail('redirect', `GET http port -> ${redir.status} location=${location} (expected 301 to https://…)`);
    }
    record('HTTP port 301-redirects to HTTPS', true, location);

    // === wave-2 features ==================================================
    // Baseline snapshot of the finished site, taken before any follow-up
    // work; the checkpoint restore below must reproduce exactly these bytes
    // (compared bridge-stripped, since the bridge is serve-time only).
    const preEdit = await fetchSiteContents(httpsPort, id);
    const indexNow = await rawRequest({ port: httpsPort, path: `/preview/${id}/` });
    const titleMatch = /<title[^>]*>([^<]+)<\/title>/i.exec(indexNow.body.toString('utf8'));
    if (!titleMatch) fail('site snapshot', 'index.html has no <title> to check the share page against');
    const siteTitle = titleMatch[1].trim();

    // (a) follow-up edit: DONE -> edit run -> DONE again, with a file event.
    const editStream = openEventStream(httpsPort, id);
    streams.push(editStream);
    await sleep(400); // drain any replay before marking
    const editMark = editStream.mark();
    const edit = await apiJson({
      method: 'POST',
      port: httpsPort,
      path: `/api/builds/${id}/edit`,
      json: { instruction: 'Make the hero headline punchier and add a FAQ entry about delivery areas.' },
    });
    if (edit.status < 200 || edit.status >= 300) {
      fail('follow-up edit', `POST edit -> ${edit.status}: ${edit.text.slice(0, 200)}`);
    }
    const editRun = await waitFor(
      'follow-up edit',
      async () => {
        const s = await getState();
        const live = editStream.since(editMark);
        const sawFile = live.some((e) => e?.type === 'file');
        const sawDone = live.some((e) => (e?.type === 'phase' && e?.phase === 'DONE') || e?.type === 'done');
        return s.phase === 'DONE' && sawFile && sawDone ? { s, live } : null;
      },
      60_000,
      600,
    );
    const afterEdit = await fetchSiteContents(httpsPort, id);
    const editChanged = CORE_FILES.filter((n) => afterEdit[n] !== preEdit[n]);
    // An edit may also prove itself by adding a brand-new file (reported by a
    // file event whose path was not in the pre-edit core set).
    const added = editRun.live
      .filter((e) => e?.type === 'file' && typeof e?.file?.path === 'string')
      .map((e) => e.file.path)
      .filter((p) => !CORE_FILES.includes(p));
    if (editChanged.length === 0 && added.length === 0) {
      fail('follow-up edit', 'DONE + file event observed, but the site contents did not change');
    }
    const editDetail = [...editChanged.map((n) => `changed ${n}`), ...added.map((n) => `added ${n}`)];
    record('follow-up edit returns to DONE with a file event', true, editDetail.join(', '));

    // (b) checkpoints: the list shows >= 1 entry after DONE, and restoring
    // the pre-edit snapshot brings the site back to the baseline. The
    // pre-edit checkpoint is the one labeled 'build' (routes/checkpoints.ts
    // sorts by ascending n, so the earliest entry is the fallback).
    const cps = await apiJson({ port: httpsPort, path: `/api/builds/${id}/checkpoints` });
    if (cps.status !== 200) {
      fail('checkpoints', `GET checkpoints -> ${cps.status}: ${cps.text.slice(0, 200)}`);
    }
    const cpList = checkpointList(cps.json);
    if (cpList.length < 1) fail('checkpoints', 'expected >= 1 checkpoint after DONE, got 0');
    record('checkpoints list shows >= 1 checkpoint after DONE', true, `${cpList.length} checkpoint(s)`);
    const oldest =
      cpList.find((cp) => cp?.label === 'build') ??
      [...cpList].sort((a, b) => checkpointTsOf(a) - checkpointTsOf(b))[0];
    const cpId = checkpointIdOf(oldest);
    if (cpId === undefined || cpId === null || cpId === '') {
      fail('checkpoints', `checkpoint entry carries no id: ${JSON.stringify(oldest).slice(0, 200)}`);
    }
    let restored = await apiJson({
      method: 'POST',
      port: httpsPort,
      path: `/api/builds/${id}/checkpoints/${encodeURIComponent(String(cpId))}/restore`,
      json: {},
    });
    if (restored.status === 404) {
      // Alternate contract shape: checkpoint id in the body, not the path.
      restored = await apiJson({
        method: 'POST',
        port: httpsPort,
        path: `/api/builds/${id}/checkpoints/restore`,
        json: { checkpointId: cpId },
      });
    }
    if (restored.status !== 200) {
      fail('checkpoints', `restore -> ${restored.status}: ${restored.text.slice(0, 200)}`);
    }
    const afterRestore = await fetchSiteContents(httpsPort, id);
    const mismatch = CORE_FILES.filter((n) => afterRestore[n] !== preEdit[n]);
    if (mismatch.length > 0) {
      fail('checkpoints', `restored files differ from the checkpoint snapshot: ${mismatch.join(', ')}`);
    }
    record('checkpoint restore returns 200 and files match the snapshot', true, `id=${String(cpId).slice(0, 16)}`);

    // (c) share page: the banner plus the site's original <title>.
    const share = await rawRequest({ port: httpsPort, path: `/p/${id}/` });
    const shareHtml = share.body.toString('utf8');
    const shareCtype = String(share.headers['content-type'] ?? '');
    if (share.status !== 200 || !shareCtype.includes('text/html')) {
      fail('share', `GET /p/${id}/ -> ${share.status} content-type=${shareCtype}`);
    }
    if (!SHARE_BANNER_RE.test(shareHtml)) {
      fail('share', 'no Foundry banner marker in the share page — align SHARE_BANNER_RE with routes/share.ts');
    }
    if (!shareHtml.includes(siteTitle)) {
      fail('share', `share page lost the original title ${JSON.stringify(siteTitle)}`);
    }
    record('GET /p/<id>/ serves the banner + original title', true, `title=${JSON.stringify(siteTitle).slice(0, 70)}`);

    // (d) fixError: an accepted response, then the build reaches DONE again.
    const fixStream = openEventStream(httpsPort, id);
    streams.push(fixStream);
    await sleep(400);
    const fixMark = fixStream.mark();
    const fix = await apiJson({
      method: 'POST',
      port: httpsPort,
      path: `/api/builds/${id}/fixError`,
      json: {
        message: "Uncaught TypeError: Cannot read properties of null (reading 'classList')",
        file: 'app.js',
        line: 87,
      },
    });
    if (fix.status < 200 || fix.status >= 300) {
      fail('fixError', `POST fixError -> ${fix.status}: ${fix.text.slice(0, 200)}`);
    }
    await waitFor(
      'fixError',
      async () => {
        const s = await getState();
        const sawDone = fixStream
          .since(fixMark)
          .some((e) => (e?.type === 'phase' && e?.phase === 'DONE') || e?.type === 'done');
        return s.phase === 'DONE' && sawDone ? s : null;
      },
      60_000,
      600,
    );
    record('POST fixError is accepted and the build reaches DONE', true, `status=${fix.status}`);

    // (e) preview bridge: the served HTML carries the injected marker.
    const bridged = await rawRequest({ port: httpsPort, path: `/preview/${id}/` });
    if (bridged.status !== 200) fail('preview bridge', `GET /preview/${id}/ -> ${bridged.status}`);
    if (!BRIDGE_RE.test(bridged.body.toString('utf8'))) {
      fail('preview bridge', `no bridge marker in served HTML (looked for ${BRIDGE_MARKERS.join(', ')})`);
    }
    record('GET /preview/<id>/ contains the injected bridge marker', true);

    // (f) the zip download stays clean: bridge injection is serve-time only.
    const zip2 = await rawRequest({ port: httpsPort, path: `/api/builds/${id}/download` });
    if (zip2.status !== 200) fail('download', `GET download (post-edit) -> ${zip2.status}`);
    const zipIndex = unzipEntry(zip2.body, 'index.html');
    if (zipIndex === null) fail('download', 'index.html not readable inside the downloaded zip');
    if (BRIDGE_RE.test(zipIndex.toString('utf8'))) {
      fail('download', 'downloaded index.html contains the bridge script — injection must be serve-time only');
    }
    record('downloaded index.html is bridge-free (serve-time injection only)', true, `${zipIndex.length} bytes`);
  } catch (err) {
    record(err instanceof Error ? err.message.split(':')[0] : 'smoke', false, err instanceof Error ? err.message : String(err));
    if (serverLog.trim()) {
      console.error('\n----- server log -----\n' + serverLog.trimEnd() + '\n----------------------');
    }
  } finally {
    for (const s of streams) s.close();
    if (child && !child.killed) child.kill();
    if (dataDir) {
      try {
        rmSync(dataDir, { recursive: true, force: true });
      } catch {
        /* temp cleanup best-effort on win32 */
      }
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} steps passed`);
  if (failed.length > 0) {
    console.error('SMOKE FAILED');
    process.exit(1);
  }
  console.log('SMOKE OK');
}

process.on('SIGINT', () => {
  if (child && !child.killed) child.kill();
  process.exit(130);
});

main().catch((err) => {
  console.error(err);
  if (child && !child.killed) child.kill();
  process.exit(1);
});
