#!/usr/bin/env node
/**
 * Foundry performance probe.
 *
 * Starts the built server (server/dist/index.js) on ephemeral ports with a
 * throwaway FOUNDRY_DATA_DIR and the mock provider (zero provider latency,
 * so every measured millisecond is server overhead), then measures the
 * budget rows from docs/PERFORMANCE.md:
 *
 *   - boot (cold with one-time cert generation, then warm)
 *   - GET /api/config p50 over 50 keep-alive calls
 *   - RSS of the server process before/after 5 full mock builds
 *     (override the build count with PERF_BUILDS=50 for the full budget run)
 *   - zip download time for a ~2MB site (incompressible random padding)
 *   - GET /preview/<id>/ time-to-first-byte p50 over 15 keep-alive calls
 *
 * Each gated row is ok within budget, WARN above it, FAIL above 2x; any
 * FAIL exits non-zero. Requires `npm run build` first.
 */
import { spawn, execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SERVER_ENTRY = join(ROOT, 'server', 'dist', 'index.js');

const BUILD_COUNT = Math.max(1, Number(process.env.PERF_BUILDS ?? 5) || 5);
const KEEP_DATA = process.env.PERF_KEEP_DATA === '1';

// Budgets from docs/PERFORMANCE.md. FAIL threshold is always 2x the budget.
const BUDGET = {
  bootMs: 1000,
  configP50Ms: 10,
  zip2mbMs: 300,
  previewTtfbMs: 20,
  rssCeilingMb: 300,
};

const results = [];
let child = null;
let dataDir = null;
let httpsPort = 0;
let httpPort = 0;

// Keep-alive agent for latency rows: the budgets cover server handling,
// not the per-connection TLS handshake.
const agent = new https.Agent({ keepAlive: true, rejectUnauthorized: false });

function row(name, value, budgetMs, unit = 'ms') {
  const over = budgetMs !== null && value > budgetMs;
  const fail = budgetMs !== null && value > budgetMs * 2;
  const status = fail ? 'FAIL' : over ? 'WARN' : 'ok';
  results.push({ name, value, budget: budgetMs, unit, status });
  const budgetText = budgetMs === null ? 'info' : `budget ${budgetMs}${unit}`;
  console.log(`${status.padEnd(4)}  ${name.padEnd(18)} ${value.toFixed(1)}${unit}  (${budgetText})`);
  return !fail;
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

function request({ method = 'GET', path, json, keepAlive = false, onResponse }) {
  return new Promise((resolve, reject) => {
    const headers = {};
    let body;
    if (json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(json);
    }
    const start = performance.now();
    const req = https.request(
      {
        host: '127.0.0.1',
        port: httpsPort,
        path,
        method,
        headers,
        agent: keepAlive ? agent : false,
        rejectUnauthorized: false,
      },
      (res) => {
        const chunks = [];
        let firstByteMs = null;
        res.on('data', (c) => {
          if (firstByteMs === null) firstByteMs = performance.now() - start;
          chunks.push(c);
        });
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          let parsed = null;
          try {
            parsed = JSON.parse(buf.toString('utf8'));
          } catch {
            /* binary or non-JSON body */
          }
          if (onResponse) onResponse(res);
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: buf,
            json: parsed,
            ttfbMs: firstByteMs ?? performance.now() - start,
          });
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(30_000, () => req.destroy(new Error(`request timed out: ${method} ${path}`)));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function waitFor(label, fn, timeoutMs, intervalMs = 300) {
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
  throw new Error(`${label}: timed out after ${timeoutMs}ms (${lastNote})`);
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

function startServer() {
  const startedAt = performance.now();
  child = spawn(process.execPath, [SERVER_ENTRY], {
    env: {
      ...process.env,
      FOUNDRY_HTTPS_PORT: String(httpsPort),
      FOUNDRY_HTTP_PORT: String(httpPort), // redirect port unused by the probe
      FOUNDRY_DATA_DIR: dataDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  child.stdout.on('data', (d) => (serverLog += d));
  child.stderr.on('data', (d) => (serverLog += d));
  child.on('exit', (code, signal) => {
    if (code !== null && code !== 0) {
      console.error(`perf: server exited early (code=${code} signal=${signal})\n${serverLog}`);
    }
  });
  return { startedAt, log: () => serverLog };
}

async function stopServer() {
  if (!child || child.killed) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill();
  await exited;
  child = null;
}

async function waitBoot(startedAt) {
  await waitFor(
    'server boot',
    async () => {
      const res = await request({ path: '/api/config' });
      return res.status === 200 ? res : null;
    },
    30_000,
    100,
  );
  return performance.now() - startedAt;
}

// RSS of the server child, in MB. Windows: tasklist CSV ("85,432 K");
// POSIX: ps rss in KB.
function serverRssMb() {
  const pid = child?.pid;
  if (!pid) return Promise.resolve(0);
  const cmd = process.platform === 'win32' ? 'tasklist' : 'ps';
  const args =
    process.platform === 'win32'
      ? ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']
      : ['-o', 'rss=', '-p', String(pid)];
  return new Promise((resolve) => {
    execFile(cmd, args, (err, stdout) => {
      if (err) {
        resolve(0);
        return;
      }
      let kb = 0;
      if (process.platform === 'win32') {
        const match = stdout.match(/"([0-9][0-9.,]*)\s*K"/i);
        if (match) kb = Number(match[1].replace(/[.,](?=\d{3}\b)/g, '').replace(',', '.'));
      } else {
        kb = Number(stdout.trim());
      }
      resolve(Number.isFinite(kb) ? kb / 1024 : 0);
    });
  });
}

// Drives one full mock build: create, answer questions, approve, wait DONE.
// Returns wall time in ms and the build id. onCreated fires right after the
// build exists so callers can attach SSE observers before work starts.
async function runBuild(index, onCreated) {
  const startedAt = performance.now();
  const created = await request({
    method: 'POST',
    path: '/api/builds',
    json: { brief: `perf probe build ${index}: a landing page for a coffee subscription startup` },
  });
  if (created.status !== 202 || !created.json?.id) {
    throw new Error(`create build: expected 202 {id}, got ${created.status}: ${created.body.toString('utf8').slice(0, 200)}`);
  }
  const id = created.json.id;
  if (onCreated) onCreated(id);

  const getState = async () => {
    const res = await request({ path: `/api/builds/${id}` });
    if (res.status !== 200) throw new Error(`state poll: GET /api/builds/${id} -> ${res.status}`);
    if (res.json?.phase === 'ERROR') throw new Error(`build: server reported ERROR: ${res.json.error ?? 'unknown'}`);
    return res.json;
  };

  const answeredIds = new Set();
  const answers = [
    'We roast small-batch single-origin beans and ship monthly.',
    'Clean and minimal, warm earth tones.',
    'Focus on the subscription call-to-action.',
  ];
  let answersSent = 0;
  await waitFor(
    'plan',
    async () => {
      const s = await getState();
      if (s.plan) return s;
      const q = s.pendingQuestion;
      const qid = q && (q.id ?? q.questionId);
      if (q && qid && !answeredIds.has(qid)) {
        const res = await request({
          method: 'POST',
          path: `/api/builds/${id}/answer`,
          json: { questionId: qid, answer: answers[answersSent % answers.length] },
        });
        if (res.status < 200 || res.status >= 300) {
          throw new Error(`answer: POST -> ${res.status}: ${res.body.toString('utf8').slice(0, 200)}`);
        }
        answeredIds.add(qid);
        answersSent += 1;
      }
      return null;
    },
    60_000,
  );

  const approved = await request({ method: 'POST', path: `/api/builds/${id}/approve`, json: {} });
  if (approved.status < 200 || approved.status >= 300) {
    throw new Error(`approve: POST -> ${approved.status}: ${approved.body.toString('utf8').slice(0, 200)}`);
  }

  await waitFor(
    'build completion',
    async () => {
      const s = await getState();
      return s.phase === 'DONE' ? s : null;
    },
    120_000,
  );
  return { id, wallMs: performance.now() - startedAt };
}

// Subscribes to a build's SSE stream and counts events until stop() is
// called. Informational companion to the fan-out budget row: fan-out cost
// per event per subscriber is bounded by one JSON.stringify + res.write.
function observeSse(id) {
  const state = { events: 0, startedAt: performance.now(), windowMs: 0 };
  const req = https.request(
    {
      host: '127.0.0.1',
      port: httpsPort,
      path: `/api/builds/${id}/events`,
      method: 'GET',
      headers: { accept: 'text/event-stream' },
      rejectUnauthorized: false,
      agent: false,
    },
    (res) => {
      res.on('data', (chunk) => {
        const text = chunk.toString('utf8');
        state.events += text.split('\n\n').filter((part) => part.startsWith('data:')).length;
      });
      res.on('error', () => {});
    },
  );
  req.on('error', () => {});
  req.end();
  state.stop = () => {
    req.destroy();
    state.windowMs = performance.now() - state.startedAt;
    return state;
  };
  return state;
}

async function main() {
  if (!existsSync(SERVER_ENTRY)) {
    throw new Error(`prerequisite: ${SERVER_ENTRY} not found — run \`npm run build\` first`);
  }

  httpsPort = await getFreePort();
  httpPort = await getFreePort();
  dataDir = mkdtempSync(join(tmpdir(), 'foundry-perf-'));
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    join(dataDir, 'foundry.config.json'),
    JSON.stringify({ provider: 'mock', endpoint: '', model: 'mock' }, null, 2),
  );

  console.log(
    `perf: node=${process.version} platform=${process.platform} port=${httpsPort} builds=${BUILD_COUNT}`,
  );
  console.log(`perf: dataDir=${dataDir}${KEEP_DATA ? ' (kept)' : ''}`);

  try {
    // --- boot: cold (one-time cert generation), then warm (gated) --------
    let boot = startServer();
    const coldMs = await waitBoot(boot.startedAt);
    row('boot cold', coldMs, null);
    await stopServer();

    boot = startServer();
    const warmMs = await waitBoot(boot.startedAt);
    row('boot warm', warmMs, BUDGET.bootMs);

    // --- config latency: p50 over 50 keep-alive calls ---------------------
    await request({ path: '/api/config', keepAlive: true }); // warm the TLS session
    const configSamples = [];
    for (let i = 0; i < 50; i += 1) {
      const start = performance.now();
      const res = await request({ path: '/api/config', keepAlive: true });
      if (res.status !== 200) throw new Error(`config latency: GET /api/config -> ${res.status}`);
      configSamples.push(performance.now() - start);
    }
    configSamples.sort((a, b) => a - b);
    row('config p50', percentile(configSamples, 50), BUDGET.configP50Ms);

    // --- builds + RSS ------------------------------------------------------
    const rssBefore = await serverRssMb();
    row('rss before builds', rssBefore, null, 'MB');

    let lastId = null;
    let sseObs = null;
    for (let i = 1; i <= BUILD_COUNT; i += 1) {
      const { id, wallMs } = await runBuild(i, (buildId) => {
        if (i === 1) sseObs = observeSse(buildId);
      });
      lastId = id;
      row(`build ${i} round-trip`, wallMs, null);
      if (sseObs) {
        const s = sseObs.stop();
        row('sse events (build 1)', s.events, null, ' events');
        sseObs = null;
      }
    }

    const rssAfter = await serverRssMb();
    row('rss after builds', rssAfter, BUDGET.rssCeilingMb, 'MB');
    row('rss delta', rssAfter - rssBefore, null, 'MB');

    // --- zip of a 2MB site --------------------------------------------------
    // Pad the last build's site to ~2MB with incompressible random bytes
    // (worst case for deflate). Written straight to disk: download streams
    // the raw directory and does not apply the per-file write caps.
    const sitePath = join(dataDir, 'sites', lastId);
    mkdirSync(join(sitePath, 'assets'), { recursive: true });
    writeFileSync(join(sitePath, 'assets', 'perf-pad-1.bin'), randomBytes(1024 * 1024));
    writeFileSync(join(sitePath, 'assets', 'perf-pad-2.bin'), randomBytes(1024 * 1024));

    const zipStart = performance.now();
    const zip = await request({ path: `/api/builds/${lastId}/download` });
    const zipMs = performance.now() - zipStart;
    if (zip.status !== 200 || zip.body.length < 4 || zip.body[0] !== 0x50 || zip.body[1] !== 0x4b) {
      throw new Error(`zip: expected 200 PK zip, got ${zip.status} len=${zip.body.length}`);
    }
    console.log(`      zip payload ${(zip.body.length / (1024 * 1024)).toFixed(2)}MB on the wire`);
    row('zip 2MB', zipMs, BUDGET.zip2mbMs);

    // --- preview TTFB p50 ---------------------------------------------------
    await request({ path: `/preview/${lastId}/`, keepAlive: true }); // warm
    const ttfbSamples = [];
    for (let i = 0; i < 15; i += 1) {
      const res = await request({ path: `/preview/${lastId}/`, keepAlive: true });
      if (res.status !== 200) throw new Error(`preview: GET /preview/${lastId}/ -> ${res.status}`);
      ttfbSamples.push(res.ttfbMs);
    }
    ttfbSamples.sort((a, b) => a - b);
    row('preview ttfb p50', percentile(ttfbSamples, 50), BUDGET.previewTtfbMs);
  } finally {
    agent.destroy();
    await stopServer();
    if (dataDir && !KEEP_DATA) {
      try {
        rmSync(dataDir, { recursive: true, force: true });
      } catch {
        /* temp cleanup best-effort on win32 */
      }
    }
  }

  const failed = results.filter((r) => r.status === 'FAIL');
  const warned = results.filter((r) => r.status === 'WARN');
  console.log(
    `\n${results.length - failed.length - warned.length} ok, ${warned.length} warn, ${failed.length} fail`,
  );
  if (warned.length > 0) {
    console.log(`over budget (under 2x): ${warned.map((r) => r.name).join(', ')}`);
  }
  if (failed.length > 0) {
    console.error(`PERF FAIL — over 2x budget: ${failed.map((r) => r.name).join(', ')}`);
    process.exit(1);
  }
  console.log('PERF OK');
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
