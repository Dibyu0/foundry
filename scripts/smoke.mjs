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

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SERVER_ENTRY = join(ROOT, 'server', 'dist', 'index.js');

// A distinctive canary key: if this string ever shows up in an API response,
// key hygiene has regressed.
const CANARY_KEY = 'foundry-smoke-canary-key-9f8e7d6c5b4a';
const BRIEF = 'a landing page for a coffee subscription startup';

const results = [];
let child = null;
let dataDir = null;

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
  } catch (err) {
    record(err instanceof Error ? err.message.split(':')[0] : 'smoke', false, err instanceof Error ? err.message : String(err));
    if (serverLog.trim()) {
      console.error('\n----- server log -----\n' + serverLog.trimEnd() + '\n----------------------');
    }
  } finally {
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
