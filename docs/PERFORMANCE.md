# Performance Budget

Foundry is a local single-user tool, so the budget targets *felt* latency:
the UI should never stall on the server, and long agent runs should cost
provider latency only — not server overhead. The numbers below are hard
budgets on a mid-range dev machine (Node >= 22, localhost HTTPS).

| # | Metric | Budget | Enforcement | Measured by |
|---|--------|--------|-------------|-------------|
| 1 | Server boot (warm, certs present) | < 1 s | `createServer` does no network or provider work at startup; the orchestrator/provider initialize lazily on first `/api/builds` request (see `server/src/routes/agent.ts` default wiring); cert generation is one-time (~0.5 s, `server/src/certs.ts`) and cached in `<dataDir>/certs/` | `perf.mjs` row `boot` |
| 2 | `GET /api/config` latency (p50) | < 10 ms | Config and API key are served from in-memory caches (`configCache`/`keyCache` in `server/src/config.ts`), invalidated on write — no disk read per request | `perf.mjs` row `config p50` |
| 3 | Build round-trip per agent round | provider latency + < 50 ms overhead | The orchestrator runs rounds sequentially with no artificial sleeps; between provider calls it only mutates in-memory state, appends to the SSE ring buffer and persists JSON snapshots. Mock provider (~0 ms latency) is the reference: a full mock build is the overhead ceiling | `perf.mjs` rows `build N` (informational) |
| 4 | SSE fan-out | < 5 ms / event / subscriber | `SseHub.send` (`server/src/sse.ts`) is a synchronous loop of `res.write` over the channel's subscriber set — no queuing, no per-event allocation beyond one `JSON.stringify`; ring buffer is capped at 200 events so replay stays O(200) | `perf.mjs` row `sse events` (informational); to measure precisely, time `hub.send` with N subscribed responses |
| 5 | Zip of a 2 MB site | < 300 ms | `GET /api/builds/:id/download` (`server/src/routes/download.ts`) streams via archiver at zlib level 6 — no full-buffer read, response starts before compression finishes | `perf.mjs` row `zip 2MB` |
| 6 | Preview TTFB | < 20 ms | `GET /preview/:id/…` (`server/src/routes/preview.ts`) is one confined path resolve + one `fs.readFile` + headers; sites are capped at 2 MB total / 256 KB per file (`server/src/sites.ts`), so the read is bounded | `perf.mjs` row `preview ttfb p50` |
| 7 | Memory ceiling | < 300 MB RSS after 50 builds | Site writes are capped per-site (`MAX_FILES`, `MAX_FILE_BYTES`, `MAX_TOTAL_BYTES` in `server/src/sites.ts`); SSE channels hold at most 200 buffered events per build and are dropped when a build ends; build state is plain JSON | `perf.mjs` rows `rss before` / `rss after` (5 builds; see note) |

## How each budget is enforced

- **Boot (1).** Startup only creates data dirs, reads one small JSON config,
  installs middleware and binds ports. Anything expensive — provider client,
  TLS cert generation — is either lazy or cached on disk. A cold boot (first
  ever run, generating the self-signed cert) is allowed to exceed 1 s once;
  the budget covers warm boots.
- **Config latency (2).** Reads hit the in-memory cache; writes go through an
  atomic temp-file rename and then replace the cache entry. The API key never
  leaves the server, so no per-request secret scrubbing cost either.
- **Round-trip overhead (3).** The budget is stated relative to provider
  latency because that dominates (seconds per round vs milliseconds of
  server work). Enforcement = no sleeps, no polling loops on the hot path,
  no disk I/O beyond the per-round state snapshot.
- **SSE fan-out (4).** One hub, one channel per build, `Set<Response>` per
  channel. `send` stringifies once and writes to every subscriber inline;
  slow clients back-pressure only their own socket.
- **Zip (5).** Streaming pipeline (`archive.directory(...)` + `pipe(res)`);
  level 6 is the default size/speed trade-off. The probe uses *random*
  (incompressible) 2 MB padding — the worst case for deflate.
- **Preview TTFB (6).** No templating, no DB: resolve-confine-read-send.
  Path confinement (`resolveSitePath`) is a realpath check, microseconds
  against the OS cache after the first hit.
- **Memory (7).** Bounded inputs (site caps), bounded buffers (SSE ring),
  no per-build caches that outlive the build. Node's baseline RSS for this
  server is ~60–90 MB; 50 builds of bounded state must not grow it past
  300 MB.

## Re-measuring

```sh
npm run build          # probe drives the built server (server/dist/index.js)
node scripts/perf.mjs  # or `npm run perf` once the script entry is wired
```

The probe spawns the server on ephemeral ports against a throwaway
`FOUNDRY_DATA_DIR` with the mock provider (zero provider latency, so every
measured millisecond is server overhead), then prints one row per budget:

- `boot` — cold boot (with one-time cert generation, informational) and
  warm boot (gated vs 1 s).
- `config p50` — 50 sequential `GET /api/config` calls on a keep-alive
  TLS connection, p50 (gated vs 10 ms).
- `build 1..5` — wall time of five full mock builds (informational;
  covers budget row 3 end-to-end).
- `rss before` / `rss after` — server process RSS around those 5 builds
  (gated vs the 300 MB ceiling; the budget is stated for 50 builds, so a
  pass at 5 builds is necessary-but-not-sufficient — run with
  `PERF_BUILDS=50 node scripts/perf.mjs` for the full check).
- `zip 2MB` — the last build's site is padded to ~2 MB with incompressible
  random bytes, then `GET /api/builds/:id/download` is timed to the last
  byte (gated vs 300 ms).
- `preview ttfb p50` — p50 time-to-first-byte of `GET /preview/:id/` over
  15 keep-alive requests (gated vs 20 ms).
- `sse events` — live event count observed on build #1's event stream
  (informational).

Each gated row prints `ok` when within budget, `WARN` when over budget but
under 2x, and `FAIL` when over 2x. Any `FAIL` exits the probe non-zero, so
it can run in CI. Environment overrides: `PERF_BUILDS` (default 5),
`PERF_KEEP_DATA=1` (keep the temp data dir for inspection).
