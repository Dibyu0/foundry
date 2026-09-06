import { promises as fs } from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError, Orchestrator, type BuildState } from '../src/agent/orchestrator.js';
import {
  applyPlanEdits,
  isWritableSiteFile,
  normalizePlan,
  planFiles,
  sanitizeSitePath,
  type BuildPlan,
} from '../src/agent/plan.js';
import { createMockProvider } from '../src/agent/provider.js';
import { createAgentRouter } from '../src/routes/agent.js';
import { SseHub } from '../src/sse.js';
import { listSiteFiles, readSiteFile } from '../src/sites.js';
import {
  askJson,
  collectHub,
  createScriptedProvider,
  eventTypes,
  eventsFor,
  finishJson,
  hangUntilAbort,
  isResultMessage,
  makeWorld,
  planJson,
  reviewJson,
  waitFor,
  writeThenFinish,
  type World,
} from './helpers.js';

const worlds: World[] = [];

async function world(opts: Parameters<typeof makeWorld>[0] = {}): Promise<World> {
  const w = await makeWorld(opts);
  worlds.push(w);
  return w;
}

afterEach(async () => {
  while (worlds.length > 0) {
    const w = worlds.pop();
    if (w === undefined) break;
    w.hub.shutdown();
    await w.orchestrator.flush();
    await fs.rm(w.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

function expectApiError(fn: () => unknown, status: number): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(status);
    return;
  }
  throw new Error(`expected ApiError with status ${status}`);
}

interface ActivityPayload {
  role: string;
  state: string;
  note?: string;
}

function activities(events: ReturnType<typeof eventsFor>): ActivityPayload[] {
  return events
    .filter((e) => e.type === 'activity')
    .map((e) => (e as unknown as { activity: ActivityPayload }).activity);
}

describe('plan model', () => {
  it('normalizePlan drops junk steps/files and enforces caps', () => {
    const raw = {
      summary: '  A real summary  ',
      designDirection: 'bold and dark',
      steps: [
        null,
        'junk',
        { title: '', files: [] },
        {
          id: 'core',
          title: 'Core files',
          detail: 'the important ones',
          files: ['styles.css', '../evil.js', 'C:/abs.js', '/root.js', './index.html', 'styles.css', 'script.sh', 'docs/guide.md'],
        },
        ...Array.from({ length: 15 }, (_, i) => ({ title: `Step ${i}`, files: [`file-${i}.js`] })),
      ],
    };
    const plan = normalizePlan(raw);
    expect(plan).not.toBeNull();
    expect(plan?.summary).toBe('A real summary');
    expect(plan?.designNotes).toBe('bold and dark');
    expect(plan?.steps.length).toBe(12);
    const files = planFiles(plan ?? { summary: '', steps: [] });
    expect(files).toContain('styles.css');
    expect(files).toContain('index.html');
    expect(files).toContain('docs/guide.md');
    expect(files.filter((f) => f === 'styles.css').length).toBe(1);
    expect(files.some((f) => f.includes('..'))).toBe(false);
    expect(files).not.toContain('script.sh');
    expect(files.length).toBeLessThanOrEqual(40);
  });

  it('normalizePlan returns null for unusable input', () => {
    expect(normalizePlan(null)).toBeNull();
    expect(normalizePlan('plan')).toBeNull();
    expect(normalizePlan({})).toBeNull();
    expect(normalizePlan({ steps: [] })).toBeNull();
    expect(normalizePlan({ summary: 'x', steps: [{}, { files: ['../x.js'] }] })).toBeNull();
  });

  it('applyPlanEdits sanitizes edits and falls back to the current plan', () => {
    const current: BuildPlan = {
      summary: 'current summary',
      designNotes: 'dark',
      steps: [{ id: 's1', title: 'One', detail: 'd', files: ['index.html'] }],
    };
    const edited = applyPlanEdits(current, {
      steps: [{ title: 'Edited step', files: ['app.js', '../evil.js'] }, { junk: true }],
      designDirection: 'light',
    });
    expect(edited.summary).toBe('current summary');
    expect(edited.designNotes).toBe('light');
    expect(edited.steps).toEqual([{ id: 'step-1', title: 'Edited step', detail: 'Edited step', files: ['app.js'] }]);
    expect(applyPlanEdits(current, null)).toBe(current);
    expect(applyPlanEdits(current, { steps: 'nope' }).steps).toBe(current.steps);
  });

  it('sanitizeSitePath rejects traversal; isWritableSiteFile gates extensions', () => {
    expect(sanitizeSitePath('a/b/app.js')).toBe('a/b/app.js');
    expect(sanitizeSitePath('./styles.css')).toBe('styles.css');
    expect(sanitizeSitePath('..\\evil.js')).toBeNull();
    expect(sanitizeSitePath('../evil.js')).toBeNull();
    expect(sanitizeSitePath('C:/x.js')).toBeNull();
    expect(sanitizeSitePath('/abs.js')).toBeNull();
    expect(sanitizeSitePath('')).toBeNull();
    expect(isWritableSiteFile('index.html')).toBe(true);
    expect(isWritableSiteFile('docs/guide.md')).toBe(true);
    expect(isWritableSiteFile('x.sh')).toBe(false);
    expect(isWritableSiteFile('noextension')).toBe(false);
  });
});

describe('orchestrator lifecycle (real mock provider, real store, real hub)', () => {
  it('runs brief -> questions -> plan -> approve -> files -> review -> done', { timeout: 30_000 }, async () => {
    const w = await world();
    const { id } = w.orchestrator.createBuild('A landing page for a small bakery');

    await waitFor(() => w.orchestrator.get(id)?.pendingQuestion !== undefined, 'first question');
    const q1 = w.orchestrator.get(id)?.pendingQuestion;
    expect(q1?.id).toBe('q1');
    expect(q1?.options.length ?? 0).toBeGreaterThanOrEqual(2);

    // The mock asked two questions in one response; the second is served
    // from the queue without another model round-trip.
    w.orchestrator.answer(id, 'q1', 'A small-business landing page');
    expect(w.orchestrator.get(id)?.pendingQuestion?.id).toBe('q2');

    w.orchestrator.answer(id, 'q2', 'Clean and minimal');
    await waitFor(() => w.orchestrator.get(id)?.phase === 'PLANNED', 'plan');
    const planned = w.orchestrator.get(id);
    expect(typeof planned?.plan?.summary).toBe('string');
    expect((planned?.plan?.steps as unknown[] | undefined)?.length).toBe(4);

    w.orchestrator.approve(id);
    await waitFor(() => w.orchestrator.get(id)?.phase === 'DONE', 'done', 20_000);

    const state = w.orchestrator.get(id);
    expect(state?.siteUrl).toBe(`/preview/${id}/`);
    expect(state?.files.map((f) => f.path).sort()).toEqual(['app.js', 'index.html', 'styles.css']);

    // Files really landed in the confined store on disk.
    const onDisk = (await listSiteFiles(w.sitesRoot, id)).map((e) => e.path).sort();
    expect(onDisk).toEqual(['app.js', 'index.html', 'styles.css']);
    expect((await readSiteFile(w.sitesRoot, id, 'styles.css')).toString('utf8')).toContain(':root');
    expect((await readSiteFile(w.sitesRoot, id, 'index.html')).toString('utf8')).toContain('<main');

    // The mock reviewer reported one issue, so the builder made a fix pass.
    expect(state?.issues?.length).toBe(1);
    expect(state?.issues?.[0]?.severity).toBe('warn');
    const acts = activities(eventsFor(w.events, id));
    expect(acts.some((a) => a.role === 'builder' && a.state === 'active' && a.note?.includes('fixing'))).toBe(true);

    const types = eventTypes(w.events, id);
    expect(types.filter((t) => t === 'question').length).toBe(2);
    expect(types.filter((t) => t === 'file').length).toBeGreaterThanOrEqual(3);
    const idx = (t: string): number => types.indexOf(t);
    expect(idx('question')).toBeLessThan(idx('plan'));
    expect(idx('plan')).toBeLessThan(idx('file'));
    expect(idx('file')).toBeLessThan(idx('review'));
    expect(idx('review')).toBeLessThan(idx('done'));

    // Snapshot persisted and says DONE.
    await w.orchestrator.flush();
    const snap = JSON.parse(
      await fs.readFile(path.join(w.dataDir, 'builds', `${id}.json`), 'utf8'),
    ) as { phase: string; siteUrl: string };
    expect(snap.phase).toBe('DONE');
    expect(snap.siteUrl).toBe(`/preview/${id}/`);
  });

  it('forces a plan after two question rounds', { timeout: 30_000 }, async () => {
    const provider = createScriptedProvider({
      planner: ({ messages }) => {
        const limited = messages.some((m) => isResultMessage(m) && m.content.includes('question limit reached'));
        return limited ? planJson() : askJson('What matters most?', ['Speed', 'Beauty']);
      },
    });
    const w = await world({ provider });
    const { id } = w.orchestrator.createBuild('A site that keeps getting asked about');

    await waitFor(() => w.orchestrator.get(id)?.pendingQuestion !== undefined, 'question 1');
    const q1 = w.orchestrator.get(id)?.pendingQuestion;
    w.orchestrator.answer(id, q1?.id ?? '', 'Speed');
    await waitFor(() => w.orchestrator.get(id)?.pendingQuestion !== undefined, 'question 2');
    const q2 = w.orchestrator.get(id)?.pendingQuestion;
    w.orchestrator.answer(id, q2?.id ?? '', 'Beauty');

    await waitFor(() => w.orchestrator.get(id)?.phase === 'PLANNED', 'planned');
    expect(eventTypes(w.events, id).filter((t) => t === 'question').length).toBe(2);
    expect(w.orchestrator.get(id)?.plan?.summary).toBe('Scripted test plan');
  });

  it('rejects wrong-phase answers/approvals with 409 and bad payloads with 400', async () => {
    const w = await world();
    const { id } = w.orchestrator.createBuild('portfolio site');
    await waitFor(() => w.orchestrator.get(id)?.pendingQuestion !== undefined, 'question');

    expectApiError(() => w.orchestrator.approve(id), 409);
    expectApiError(() => w.orchestrator.answer(id, 'not-the-question', 'x'), 409);
    expectApiError(() => w.orchestrator.answer(id, 'q1', '   '), 400);
    expectApiError(() => w.orchestrator.answer(id, 'q1', 'x'.repeat(2001)), 400);
    expectApiError(() => w.orchestrator.createBuild('   '), 400);
    expectApiError(() => w.orchestrator.createBuild('x'.repeat(4001)), 400);
    expectApiError(() => w.orchestrator.answer('missing-id', 'q1', 'x'), 404);
    expectApiError(() => w.orchestrator.cancel('missing-id'), 404);

    w.orchestrator.answer(id, 'q1', 'a portfolio');
    w.orchestrator.answer(id, 'q2', 'minimal');
    await waitFor(() => w.orchestrator.get(id)?.phase === 'PLANNED', 'planned');
    w.orchestrator.cancel(id);
    expect(w.orchestrator.get(id)?.phase).toBe('CANCELLED');
    expectApiError(() => w.orchestrator.approve(id), 409);
  });

  it('cancel mid-build stops the drive and no further files are written', { timeout: 30_000 }, async () => {
    const provider = createScriptedProvider({
      planner: () => planJson(),
      design: writeThenFinish('styles.css', 'body { margin: 0; }'),
      copy: writeThenFinish('index.html', '<html><body>hi</body></html>'),
      builder: hangUntilAbort(),
    });
    const w = await world({ provider });
    const { id } = w.orchestrator.createBuild('cancel me');
    await waitFor(() => w.orchestrator.get(id)?.phase === 'PLANNED', 'planned');

    w.orchestrator.approve(id);
    await waitFor(
      () =>
        eventsFor(w.events, id).some(
          (e) => e.type === 'activity' && (e as { activity?: ActivityPayload }).activity?.role === 'builder',
        ),
      'builder active',
    );
    await waitFor(
      () => (w.orchestrator.get(id)?.files ?? []).some((f) => f.path === 'styles.css'),
      'styles.css written',
    );

    const cancelled = w.orchestrator.cancel(id);
    expect(cancelled.phase).toBe('CANCELLED');
    await w.orchestrator.whenSettled(id);

    const diskFiles = (await listSiteFiles(w.sitesRoot, id)).map((e) => e.path);
    expect(diskFiles).toContain('styles.css');
    expect(diskFiles).toContain('index.html');
    expect(diskFiles).not.toContain('app.js');
    expect(eventTypes(w.events, id)).not.toContain('done');

    // Nothing more is written once the drive has stopped.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const later = (await listSiteFiles(w.sitesRoot, id)).map((e) => e.path);
    expect(later).toEqual(diskFiles);
  });

  it('resumes parked builds and marks mid-flight builds interrupted after a restart', { timeout: 30_000 }, async () => {
    const provider = createScriptedProvider({
      planner: ({ messages }) => {
        const sys = messages[0]?.content ?? '';
        const answered = messages.some((m) => isResultMessage(m) && m.content.includes('The user answered'));
        if (sys.includes('B2') || sys.includes('B3') || sys.includes('B4') || answered) return planJson();
        return askJson('Pick a direction', ['Direction A', 'Direction B']);
      },
      design: writeThenFinish('styles.css', 'body{}'),
      copy: writeThenFinish('index.html', '<html></html>'),
      builder: ({ messages }) => {
        const sys = messages[0]?.content ?? '';
        if (sys.includes('B3')) return hangUntilAbort()({ role: 'builder', messages });
        return writeThenFinish('app.js', '/* js */')({ role: 'builder', messages });
      },
      reviewer: () => `${reviewJson([])}\n${finishJson}`,
    });
    const w1 = await world({ provider });

    const b1 = w1.orchestrator.createBuild('B1 brief').id;
    await waitFor(() => w1.orchestrator.get(b1)?.pendingQuestion !== undefined, 'b1 question');

    const b2 = w1.orchestrator.createBuild('B2 brief').id;
    await waitFor(() => w1.orchestrator.get(b2)?.phase === 'PLANNED', 'b2 planned');

    const b3 = w1.orchestrator.createBuild('B3 brief').id;
    await waitFor(() => w1.orchestrator.get(b3)?.phase === 'PLANNED', 'b3 planned');
    w1.orchestrator.approve(b3);
    await waitFor(
      () => (w1.orchestrator.get(b3)?.files ?? []).some((f) => f.path === 'styles.css'),
      'b3 building',
    );
    expect(w1.orchestrator.get(b3)?.phase).toBe('BUILDING');

    const b4 = w1.orchestrator.createBuild('B4 brief').id;
    await waitFor(() => w1.orchestrator.get(b4)?.phase === 'PLANNED', 'b4 planned');
    w1.orchestrator.approve(b4);
    await waitFor(() => w1.orchestrator.get(b4)?.phase === 'DONE', 'b4 done', 15_000);
    await w1.orchestrator.flush();

    // Simulated restart: a brand-new orchestrator over the same directories.
    const hub2 = new SseHub({ heartbeatMs: 600_000 });
    try {
      const orch2 = await Orchestrator.open({
        sitesRoot: w1.sitesRoot,
        dataDir: w1.dataDir,
        hub: hub2,
        getProvider: () => createMockProvider(),
      });

      expect(orch2.get(b3)?.phase).toBe('ERROR');
      expect(orch2.get(b3)?.error).toBe('interrupted by server restart');
      expect(orch2.get(b1)?.phase).toBe('INTAKE');
      expect(orch2.get(b1)?.pendingQuestion).toBeDefined();
      expect(orch2.get(b2)?.phase).toBe('PLANNED');
      expect(orch2.get(b2)?.plan).toBeDefined();
      expect(orch2.get(b4)?.phase).toBe('DONE');
      expect(orch2.get(b4)?.siteUrl).toBe(`/preview/${b4}/`);

      // The parked intake build resumes cleanly on the new orchestrator,
      // now driven by the real mock provider.
      const pending = orch2.get(b1)?.pendingQuestion;
      orch2.answer(b1, pending?.id ?? '', 'Direction A');
      await waitFor(() => orch2.get(b1)?.phase === 'PLANNED', 'b1 planned after restart');
    } finally {
      hub2.shutdown();
    }
  });

  it('caps concurrent builds and honestly queues the rest', { timeout: 30_000 }, async () => {
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const provider = createScriptedProvider({
      planner: async ({ messages }) => {
        const sys = messages[0]?.content ?? '';
        const answered = messages.some((m) => isResultMessage(m) && m.content.includes('The user answered'));
        if (answered) return planJson();
        if (sys.includes('GATED')) await gate;
        return askJson('Pick one', ['x', 'y']);
      },
    });
    const w = await world({ provider, maxConcurrent: 2 });

    const b1 = w.orchestrator.createBuild('GATED build one').id;
    const b2 = w.orchestrator.createBuild('GATED build two').id;
    const b3 = w.orchestrator.createBuild('build three').id;

    await waitFor(() => w.orchestrator.get(b3)?.queued === true, 'b3 queued');
    expect(w.orchestrator.get(b1)?.queued).toBe(false);
    expect(eventTypes(w.events, b3)).not.toContain('question');
    expect(
      w.orchestrator.get(b3)?.messages.some((m) => m.role === 'system' && m.text.includes('Queued')),
    ).toBe(true);

    releaseGate();
    await waitFor(() => w.orchestrator.get(b1)?.pendingQuestion !== undefined, 'b1 question');
    await waitFor(() => w.orchestrator.get(b2)?.pendingQuestion !== undefined, 'b2 question');
    await waitFor(() => w.orchestrator.get(b3)?.pendingQuestion !== undefined, 'b3 question');
    expect(w.orchestrator.get(b3)?.queued).toBe(false);

    const all = w.events;
    const idx1 = all.findIndex((e) => e.id === b1 && e.event.type === 'question');
    const idx3 = all.findIndex((e) => e.id === b3 && e.event.type === 'question');
    expect(idx1).toBeGreaterThanOrEqual(0);
    expect(idx3).toBeGreaterThan(idx1);

    expect(w.orchestrator.list().length).toBe(3);
  });
});

describe('agent routes', () => {
  it('serves the REST + SSE contract end to end', { timeout: 30_000 }, async () => {
    const w = await world();
    const app = express();
    app.use(express.json());
    app.use('/api/builds', createAgentRouter({ orchestrator: w.orchestrator, hub: w.hub }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const { port } = (server.address() as AddressInfo) ?? { port: 0 };
    const base = `http://127.0.0.1:${port}`;
    const jsonHeaders = { 'Content-Type': 'application/json' };
    const post = (p: string, body: unknown): Promise<Response> =>
      fetch(`${base}${p}`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify(body) });

    try {
      // Payload validation.
      expect((await post('/api/builds', {})).status).toBe(400);
      expect((await post('/api/builds', { brief: 42 })).status).toBe(400);
      expect((await post('/api/builds', { brief: 'x'.repeat(4001) })).status).toBe(400);
      expect((await fetch(`${base}/api/builds/nope`)).status).toBe(404);
      expect((await fetch(`${base}/api/builds/nope/events`)).status).toBe(404);

      const created = await post('/api/builds', { brief: 'A docs page for an API' });
      expect(created.status).toBe(202);
      const { id } = (await created.json()) as { id: string; queued: boolean };
      expect(typeof id).toBe('string');

      const list = (await (await fetch(`${base}/api/builds`)).json()) as Array<{ id: string; phase: string }>;
      expect(list.some((b) => b.id === id)).toBe(true);

      await waitFor(() => w.orchestrator.get(id)?.pendingQuestion !== undefined, 'question');
      const state1 = (await (await fetch(`${base}/api/builds/${id}`)).json()) as BuildState;
      expect(state1.phase).toBe('INTAKE');
      expect(state1.pendingQuestion?.id).toBe('q1');

      expect((await post(`/api/builds/${id}/approve`, {})).status).toBe(409);
      expect((await post(`/api/builds/${id}/answer`, { questionId: 'zzz', answer: 'x' })).status).toBe(409);
      expect((await post(`/api/builds/${id}/answer`, { questionId: 'q1' })).status).toBe(400);

      // SSE: replay first, then live events as answers arrive.
      const sse = await fetch(`${base}/api/builds/${id}/events`);
      expect(sse.status).toBe(200);
      expect(sse.headers.get('content-type') ?? '').toContain('text/event-stream');
      if (sse.body === null) throw new Error('SSE response has no body');
      const reader = sse.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      const readUntil = async (needle: string): Promise<void> => {
        const deadline = Date.now() + 5000;
        while (!buf.includes(needle)) {
          if (Date.now() > deadline) throw new Error(`SSE stream never delivered ${needle}`);
          const { done, value } = await reader.read();
          if (done) throw new Error('SSE stream closed early');
          buf += decoder.decode(value, { stream: true });
        }
      };
      await readUntil('"type":"question"');

      expect((await post(`/api/builds/${id}/answer`, { questionId: 'q1', answer: 'A product or docs page' })).status).toBe(200);
      await readUntil('"q2"');
      expect((await post(`/api/builds/${id}/answer`, { questionId: 'q2', answer: 'Dark and technical' })).status).toBe(200);
      await waitFor(() => w.orchestrator.get(id)?.phase === 'PLANNED', 'planned');

      // Approve with an edited plan: junk entries are sanitized server-side.
      const approve = await post(`/api/builds/${id}/approve`, {
        plan: {
          summary: 'Edited summary',
          steps: [
            { title: 'Core', files: ['index.html', '../evil.js', 'styles.css'] },
            { title: 'Behavior', files: ['app.js'] },
          ],
        },
      });
      expect(approve.status).toBe(200);
      const approvedState = (await approve.json()) as BuildState;
      expect(approvedState.plan?.summary).toBe('Edited summary');
      const approvedFiles = ((approvedState.plan?.steps ?? []) as Array<{ files: string[] }>).flatMap((s) => s.files);
      expect(approvedFiles).not.toContain('../evil.js');

      await waitFor(() => w.orchestrator.get(id)?.phase === 'DONE', 'done', 20_000);
      await readUntil('"type":"done"');
      await reader.cancel();

      const doneState = (await (await fetch(`${base}/api/builds/${id}`)).json()) as BuildState;
      expect(doneState.phase).toBe('DONE');
      expect(doneState.siteUrl).toBe(`/preview/${id}/`);
      expect(doneState.files.map((f) => f.path).sort()).toEqual(['app.js', 'index.html', 'styles.css']);

      const cancelRes = await post(`/api/builds/${id}/cancel`, {});
      expect(cancelRes.status).toBe(200);
      expect(((await cancelRes.json()) as BuildState).phase).toBe('DONE');
    } finally {
      (server as unknown as { closeIdleConnections?: () => void }).closeIdleConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
