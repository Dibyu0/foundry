# Foundry

**A self-hosted agentic website builder.** Describe the site you want in one
sentence and a five-role AI team — planner, designer, copywriter, builder,
reviewer — takes it from there, steered by a shared premium design recipe: it
asks you a few sharp questions, drafts a plan you can edit, then writes a
complete website on this machine while you watch every file land in real
time. The result is not a wireframe and not a framework project with a
toolchain to babysit: it is a self-contained static site with award-tier
aesthetics — metallic dark palettes, glass surfaces, a real motion system —
that previews instantly in a sandboxed frame and downloads as a zip you can
deploy anywhere. The cloud is this box.

Foundry is a single-user, Replit-class builder you run yourself. Every build
flows through a visible pipeline — intake, planning, build, review — and you
stay in the loop: answer the agents' questions, approve or edit the plan, then
watch the files appear in real time.

## Architecture

```
                        this machine ("the cloud is this box")
  ┌──────────────────────────────────────────────────────────────────────┐
  │                                                                      │
  │   ┌──────────┐   HTTPS + SSE   ┌────────────────────────────────┐    │
  │   │ browser  │ ◄─────────────► │ express server                 │    │
  │   │ (React   │                 │  HTTPS everywhere, security    │    │
  │   │  SPA)    │                 │  headers, rate limits          │    │
  │   └──────────┘                 │                                │    │
  │                                │  /api/* ──► orchestrator ────► │─┐  │
  │                                │    (phase machine: INTAKE ►    │ │  │
  │                                │     PLANNED ► BUILDING ►       │ │  │
  │                                │     REVIEW ► DONE)             │ │  │
  │                                │        │                       │ │  │
  │                                │        ▼                       ▼ ▼  │
  │                                │   ┌──────────┐        ┌────────────┐│
  │                                │   │ site     │ ◄───── │ agent team ││
  │                                │   │ store    │ files  │ planner    ││
  │                                │   │ data/    │        │ designer   ││
  │                                │   │ sites/id │        │ copywriter ││
  │                                │   └────┬─────┘        │ builder    ││
  │                                │        │              │ reviewer   ││
  │                                │        ▼              └─────┬──────┘│
  │                                │   /preview/<id>/*           │ tool  │
  │                                │   (sandboxed static,        ▼ JSON  │
  │                                │    CSP, no sniff)                    │
  │                                │                      ┌────────────┐ │
  │                                │                      │ LLM        │ │
  │                                │                      │ provider   │ │
  │                                │                      │ kimi /     │ │
  │                                │                      │ openai /   │ │
  │                                │                      │ ollama /   │ │
  │                                │                      │ mock       │ │
  │                                │                      └────────────┘ │
  └──────────────────────────────────────────────────────────────────────┘
```

The browser talks to one HTTPS express server. Builds are driven by an
orchestrator that walks a fixed phase machine and prompts a team of role
agents; each agent replies with a small JSON tool vocabulary
(`ask`, `plan`, `writeFile`, `readFile`, `listFiles`, `reviewNotes`, `finish`)
that the server interprets. Files land in a realpath-confined per-build store
and are served back — sandboxed — under `/preview/<id>/`.

## Quickstart

Requires Node.js 22 or newer.

```sh
npm install
npm --prefix server install
npm --prefix web install
npm run build
npm start
```

Then open **https://localhost:8443** and accept the self-signed certificate
warning once (see [Security model](#security-model) for why it exists and how
to use your own certificate).

## Provider setup

Foundry is provider-agnostic: agents speak a prompt-based JSON tool
convention, so any chat-completions-style endpoint works. It boots with the
**mock provider enabled** so the whole pipeline works out of the box;
connect a real model in Settings (or with `PUT /api/config`) to build real
sites.

| Provider | `provider` | Notes |
| --- | --- | --- |
| **Mock** (default) | `mock` | Canned deterministic responses — for demos and tests. No network. |
| **Kimi** | `kimi` | Kimi/Moonshot API (`https://api.moonshot.ai/v1`). Set your API key in Settings. |
| **OpenAI-compatible** | `openai-compatible` | Any OpenAI-compatible endpoint; set `endpoint` and `model`. |
| **Ollama (local)** | `ollama` | Local models, no key needed; default endpoint `http://localhost:11434`. |

**Where keys live:** API keys are stored server-side in
`data/secrets.json`, written with mode `0600` on POSIX systems. The key is
write-only over the API: `GET /api/config` returns
`{provider, endpoint, model, hasKey}` — never the key itself.

## What a build looks like

Five role agents collaborate on every build, driven by an orchestrator that
runs the phase machine, persists snapshots, and broadcasts live events. Each
role is prompted with `[role:<name>]` so providers (including the mock) can
specialize:

| Role | What it owns |
| --- | --- |
| **Planner** | Intake *and* planning: asks sharp clarifying questions (at most 2 rounds), then turns brief + answers into an explicit, ordered build plan — committing to brand voice and hero concept — that you approve before any file is written. |
| **Designer** | `styles.css`: the token system, metallic dark surfaces, real glass, fluid typography, the CSS half of the motion system, AA-checked contrast, mobile-first layout and print styles. |
| **Copywriter** | `index.html`: every blueprint section in order with premium conversion copy (no lorem ipsum), inline SVG icons, and the DOM hooks the motion system needs. |
| **Builder** | `app.js`: the JS half of the motion system (scroll reveals, stat count-ups, cursor glow, logo marquee) plus the mobile nav — progressive enhancement throughout — then fixes whatever the reviewer flags. |
| **Reviewer** | A pull-request-style audit of the finished site against the brief and a hard recipe checklist; sends the builder back to fix what misses. |

**The premium design recipe.** Every role is steered by one shared recipe,
injected into its prompt, with a single bar: a site that looks designed, not
generated.

- **Metallic dark** — layered near-black surfaces with blue/steel tints,
  brushed-metal gradient accents and one high-sheen accent color, kept
  AA-legible across the whole palette.
- **Glass** — frosted panels (translucent fill, backdrop blur, hairline
  gradient borders) and layered elevation shadows, so the page has real depth.
- **Motion system** — an aurora background layer, an animated gradient
  headline, hover lift and border-glow on cards, scroll-triggered reveals,
  counting stats, a cursor-following hero glow and a logo marquee; transform
  and opacity only, all of it instant or disabled under
  `prefers-reduced-motion`, and the page stays complete with JS disabled.
- **Blueprint sections** — a proven landing skeleton the team fills with
  brief-specific content: sticky glass nav, hero, logo marquee, features
  grid, stats band, showcase split, testimonials, pricing, FAQ, closing CTA
  and footer.

The constraints stay hard: self-contained static HTML/CSS/JS with zero build
step, no external scripts or frameworks, AA contrast on the dark palette, and
fully responsive pages with a working mobile nav.

Pipeline phases, visible live in the UI and over the SSE stream:

```
INTAKE ──► PLANNED ──► BUILDING ──► REVIEW ──► DONE
   │           │          │           │
   └───────────┴──────────┴───────────┴──► ERROR   (or CANCELLED, anytime)
```

## Security model

Foundry is built to be safe to run on your own machine and network:

- **HTTPS everywhere.** The app only serves over TLS; a sidecar HTTP port
  exists solely to 301-redirect to HTTPS. HSTS is enabled.
- **Security headers** on every response: a restrictive
  `Content-Security-Policy`, `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: SAMEORIGIN` plus `frame-ancestors 'none'`, HSTS, and
  `Referrer-Policy: no-referrer`. Preview pages get their own CSP
  (`default-src 'self' 'unsafe-inline'; img-src 'self' data: https:;
  font-src 'self' data:`) so generated sites can style themselves and load
  CDN images/fonts, but can only make network connections back to this
  origin.
- **Rate limiting** on API routes to blunt abuse and runaway clients.
- **Realpath confinement** for the site store: every file the agents write,
  and every preview path served, is resolved to its real path and verified to
  stay inside `data/sites/<id>/`. `..` segments, absolute paths, and symlink
  escapes are refused.
- **Hard output caps:** at most 40 files per site, at most 256 KB per file,
  static html/css/js only, no build step, no external scripts.
- **No shell execution anywhere.** Agents can only write files through the
  tool vocabulary; there is no `exec`, no eval of generated code, no template
  execution.
- **Key hygiene:** keys live only in `data/secrets.json` (mode `0600` on
  POSIX), are never logged, and are never serialized back to clients.
- **Self-signed by default, your cert if you want:** on first run Foundry
  generates a self-signed certificate into `data/certs/`. Your browser will
  warn once — verify you're on `localhost` (or your own host) and accept, or
  add the cert to your OS trust store. To use a real certificate (e.g. from
  your internal CA or Let's Encrypt), drop `cert.pem` and `key.pem` into
  `data/certs/` and restart.

### Known limitations of the current model

Honest list, ranked by impact — these are deliberate scope cuts, not
oversights:

1. **Self-signed default certificate** is vulnerable to first-connect MITM
   on untrusted networks. On a LAN, prefer dropping your own CA-signed
   `cert.pem`/`key.pem` into `data/certs/`.
2. **No authentication.** Foundry assumes a single trusted user; anyone who
   can reach the port can drive builds. Bind to localhost or put it behind
   your own auth proxy. (Auth is a hook away — see roadmap.)
3. **Preview CSP allows inline scripts and styles** (`'unsafe-inline'`)
   because generated sites ship inline `<script>`/`<style>` blocks. Inside
   the app the preview runs in a `sandbox="allow-scripts"` iframe (opaque
   origin), so generated JS cannot reach the Foundry API from there — but
   the "open in new tab" path serves the site unsandboxed from the *same
   origin* as the API. Acceptable only because the current model is
   single-user with no auth (limitation 2); before auth lands, previews
   should move to a separate origin. Outbound connections from generated
   sites are still limited to `connect-src 'self'`, so exfiltration to
   third parties is blocked.
4. **In-memory rate limiting** is per-process and resets on restart; it
   throttles accidents and casual abuse, not determined attackers.
5. **SSE replay buffers are bounded per build** (last 200 events) but the
   number of channels is unbounded — the registry is in-memory with JSON
   snapshots, so a crash mid-build loses live progress, and a very long
   session accumulates channels until the process restarts.
6. **Zip download** archives the confined site directory; the archive itself
   is built from realpath-verified files, but always extract zips with tools
   that sanitize entry names (defense in depth on the client side).
7. **Realpath checks have an inherent TOCTOU window** between the confinement
   check and the file read/write. Exploiting it requires local filesystem
   access to race a symlink swap, at which point the machine is already
   compromised — noted for completeness.
8. **The HTTP redirect port trusts the `Host` header** when building the
   HTTPS `Location`. Browsers always send the real host, so this is only
   reachable by clients that chose their own `Host` — self-referential and
   low risk, but it means the redirect is not a canonicalizing one.

## Ports and environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `FOUNDRY_HTTPS_PORT` | `8443` | TLS port for the app and API. |
| `FOUNDRY_HTTP_PORT` | `8080` | Plain-HTTP port; only 301-redirects to HTTPS. |
| `FOUNDRY_DATA_DIR` | `./data` | Where config, secrets, certs, and built sites live. |

## Development

```sh
npm run dev        # build the web UI, then start the server
npm run build      # build server (tsc) and web (vite)
npm test           # server unit/integration tests (vitest; mock provider only)
npm run smoke      # end-to-end smoke test: real server, full lifecycle, HTTPS
```

`scripts/smoke.mjs` boots the built server on ephemeral ports with a
throwaway data dir, drives a full build (question ► answer ► plan ► approve ►
done) against the mock provider, and asserts the security surface: preview
CSP, traversal confinement, zip download, key hygiene, and the HTTP ► HTTPS
redirect. It prints a PASS/FAIL summary and exits non-zero on any failure.

## Current limitations

- **Single-user.** No accounts, no multi-tenancy, no per-user isolation.
- **In-memory build registry** with JSON snapshots: fine for a personal
  tool, not for durability guarantees.
- **Output is static html/css/js only.** Builds are self-contained sites
  with premium aesthetics and zero build step, but there are no frameworks,
  no build tools and no external scripts. Fonts and images from CDNs are
  allowed.
- **Mock provider is for demos.** It proves the pipeline end-to-end without
  network access, but it doesn't write real sites.

## Roadmap hooks

- **Zip export exists** — `GET /api/builds/:id/download` already hands you
  the whole site.
- **Auth is a hook away** — the middleware seam is there; wire your SSO,
  basic auth, or proxy-level auth in front of `/api/*`.
- **React/Next.js project output is a future option** — it needs a sandboxed
  build runner, which is out of scope for the static-preview model: generated
  sites are served, never executed on this box.
- **Container sandboxing for running generated apps** (servers, databases)
  is **out of scope by design**: Foundry builds static sites, and static
  sites never execute on this box.
