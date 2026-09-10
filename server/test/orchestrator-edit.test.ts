import { promises as fs } from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ApiError,
  Orchestrator,
  parseErrorLocation,
  partitionRemaining,
  selectEditFiles,
  type BuildState,
} from '../src/agent/orchestrator.js';
import { normalizePlan, type BuildPlan } from '../src/agent/plan.js';
import { createMockProvider, type ChatMessage, type Provider } from '../src/agent/provider.js';
import { createAgentRouter } from '../src/routes/agent.js';
import { SseHub } from '../src/sse.js';
import { listSiteFiles, readSiteFile } from '../src/sites.js';
import {
  collectHub,
  createScriptedProvider,
  eventTypes,
  eventsFor,
  finishJson,
  isResultMessage,
  makeWorld,
  planJson,
  reviewJson,
  waitFor,
  writeJson,
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

function phases(events: ReturnType<typeof eventsFor>): string[] {
  return events
    .filter((e) => e.type === 'phase')
    .map((e) => String((e as unknown as { phase: string }).phase));
}

const EDITED_STYLES = '/* edited by follow-up */\n:root { --color-accent: #b07428; }\n';
const FIXED_APP = '/* fixed */\n(function () {\n  \'use strict\';\n})();\n';

/** Drives a build to DONE with the plain mock provider. */
async function buildToDone(w: World, brief = 'A landing page for a small bakery'): Promise<string> {
  const { id } = w.orchestrator.createBuild(brief);
  await waitFor(() => w.orchestrator.get(id)?.pendingQuestion !== undefined, 'first question');
  w.orchestrator.answer(id, 'q1', 'Sell a subscription');
  w.orchestrator.answer(id, 'q2', 'Dark, metallic, animated');
  await waitFor(() => w.orchestrator.get(id)?.phase === 'PLANNED', 'planned');
  w.orchestrator.approve(id);
  await waitFor(() => w.orchestrator.get(id)?.phase === 'DONE', 'done', 20_000);
  return id;
}

/**
 * The stock mock provider plus two extra branches keyed on the orchestrator's
 * own edit/fix kickoff lines (which stay stable when the roles workstream's
 * targetedEditPrompt replaces the local stand-in prompt).
 */
function editAwareProvider(captured: { editPrompts: string[]; fixPrompts: string[] }): Provider {
  const mock = createMockProvider();
  const complete = async (messages: ChatMessage[]): Promise<string> => {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    if (lastUser.includes('Apply this edit now:')) {
      captured.editPrompts.push(messages[0]?.content ?? '');
      return ['Rewrote styles.css with a warmer copper accent.', writeJson('styles.css', EDITED_STYLES), finishJson].join('\n');
    }
    if (lastUser.includes('Fix this site error now')) {
      captured.fixPrompts.push(messages[0]?.content ?? '');
      return ['Rewrote app.js with the null guard.', writeJson('app.js', FIXED_APP), finishJson].join('\n');
    }
    return mock.complete(messages);
  };
  return {
    complete,
    stream: async (messages, onDelta) => {
      const text = await complete(messages);
      const mid = Math.ceil(text.length / 2);
      onDelta(text.slice(0, mid));
      onDelta(text.slice(mid));
      return text;
    },
  };
}

describe('edit heuristics (pure)', () => {
  it('selectEditFiles ranks named and hinted files, caps at 8, keeps input order on ties', () => {
    const files = ['styles.css', 'animations.css', 'index.html', 'app.js', 'README.md'];
    expect(selectEditFiles(files, 'update styles.css to use more copper')[0]).toBe('styles.css');
    expect(selectEditFiles(files, 'the counter animation in app.js is broken')[0]).toBe('app.js');
    // No file named: "headline"/"hero" hint at html, "bigger" hints at css too.
    const hinted = selectEditFiles(files, 'make the hero headline bigger');
    expect(hinted).toContain('index.html');
    expect(hinted).toContain('styles.css');
    expect(hinted[0]).toBe('index.html');
    // Nothing matches at all: the core trio is the seeded default context.
    expect(selectEditFiles(files, 'make it pop')).toEqual(['styles.css', 'index.html', 'app.js']);
    // Cap: ten equally-scored scripts keep input order and stop at 8.
    const many = Array.from({ length: 10 }, (_, i) => `script-${i}.js`);
    const capped = selectEditFiles(many, 'fix the scripts');
    expect(capped).toHaveLength(8);
    expect(capped[0]).toBe('script-0.js');
    expect(capped[7]).toBe('script-7.js');
  });

  it('partitionRemaining splits only big plans into two contiguous plan-ordered groups', () => {
    const planOf = (files: string[]): BuildPlan => {
      const plan = normalizePlan({ summary: 'p', steps: files.map((f, i) => ({ id: `s${i}`, title: f, files: [f] })) });
      if (plan === null) throw new Error('plan normalization failed');
      return plan;
    };
    const small = planOf(['styles.css', 'index.html', 'app.js', 'README.md']);
    expect(partitionRemaining(small, ['README.md'])).toEqual([['README.md']]);
    const big = planOf(['styles.css', 'animations.css', 'index.html', 'app.js', 'a.js', 'b.js', 'data.json', 'README.md']);
    expect(partitionRemaining(big, ['a.js', 'b.js', 'data.json', 'README.md'])).toEqual([
      ['a.js', 'b.js'],
      ['data.json', 'README.md'],
    ]);
    // A single leftover file never fans out, even in a big plan.
    expect(partitionRemaining(big, ['README.md'])).toEqual([['README.md']]);
  });

  it('parseErrorLocation reads file:line out of console error text', () => {
    expect(parseErrorLocation('Uncaught TypeError: nav is null at app.js:42:10')).toEqual({ file: 'app.js', line: 42 });
    // With a known file list, the first in-site match wins over junk.
    expect(parseErrorLocation('at missing.js:3 then app.js:9', ['app.js'])).toEqual({ file: 'app.js', line: 9 });
    expect(parseErrorLocation('../evil.js:3 is not it', ['app.js'])).toEqual({});
    expect(parseErrorLocation('something broke on line 7')).toEqual({ line: 7 });
    expect(parseErrorLocation('no location at all')).toEqual({});
  });
});

describe('follow-up edits (EDITING)', () => {
  it('runs done -> edit -> done with changed-file events and a checkpoint', { timeout: 30_000 }, async () => {
    const captured = { editPrompts: [] as string[], fixPrompts: [] as string[] };
    const w = await world({ provider: editAwareProvider(captured) });
    const id = await buildToDone(w);

    const before = w.orchestrator.get(id);
    expect(before?.phase).toBe('DONE');
    const eventCountBefore = w.events.length;

    const editing = w.orchestrator.edit(id, 'Warm up the styles: more copper, less steel');
    expect(editing.phase).toBe('EDITING');
    expect(editing.paused).toBe(false);

    await waitFor(() => w.orchestrator.get(id)?.phase === 'DONE', 'edit done', 20_000);
    const done = w.orchestrator.get(id);
    expect(done?.siteUrl).toBe(`/preview/${id}/`);

    // The builder really rewrote styles.css on disk (and only styles.css).
    expect((await readSiteFile(w.sitesRoot, id, 'styles.css')).toString('utf8')).toBe(EDITED_STYLES);
    expect((await readSiteFile(w.sitesRoot, id, 'index.html')).toString('utf8')).toContain('<main');

    // The edit prompt carried the instruction and the preloaded current file.
    expect(captured.editPrompts).toHaveLength(1);
    expect(captured.editPrompts[0]).toContain('Warm up the styles');
    expect(captured.editPrompts[0]).toContain('--- styles.css ---');
    expect(captured.editPrompts[0]).toContain(':root');

    const events = eventsFor(w.events, id).slice(
      eventsFor(w.events, id).findIndex((e) => e.type === 'done') + 1,
    );
    // Phase path: EDITING, then DONE again; the file event is the diff-friendly signal.
    const newPhases = events.filter((e) => e.type === 'phase').map((e) => String((e as { phase?: unknown }).phase));
    expect(newPhases).toEqual(['EDITING', 'DONE']);
    const fileEvents = events
      .filter((e) => e.type === 'file')
      .map((e) => (e as unknown as { file: { path: string } }).file.path);
    expect(fileEvents).toEqual(['styles.css']);
    const checkpoint = events.find((e) => e.type === 'checkpoint') as
      | { checkpoint?: { kind?: unknown; instruction?: unknown; files?: unknown } }
      | undefined;
    expect(checkpoint?.checkpoint?.kind).toBe('edit');
    expect(checkpoint?.checkpoint?.instruction).toBe('Warm up the styles: more copper, less steel');
    expect(checkpoint?.checkpoint?.files).toEqual(['styles.css']);
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
    // A one-file edit does not re-run the reviewer.
    expect(activities(events).some((a) => a.role === 'reviewer')).toBe(false);
    expect(w.events.length).toBeGreaterThan(eventCountBefore);
  });

  it('re-runs the reviewer when an edit touches more than 3 files', { timeout: 30_000 }, async () => {
    let reviewerCalls = 0;
    const provider = createScriptedProvider({
      planner: () => planJson(),
      design: writeThenFinish('styles.css', 'body { margin: 0; }'),
      copy: writeThenFinish('index.html', '<html><body>hi</body></html>'),
      builder: ({ messages }) => {
        const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
        if (lastUser.includes('Apply this edit now:')) {
          const wrote = messages.some((m) => isResultMessage(m) && m.content.includes('ok: wrote about.html'));
          if (wrote) return finishJson;
          return [
            writeJson('index.html', '<html><body>edited home</body></html>'),
            writeJson('styles.css', 'body { color: #222; }'),
            writeJson('app.js', '/* edited */'),
            writeJson('about.html', '<html><body>about</body></html>'),
          ].join('\n');
        }
        return writeThenFinish('app.js', '/* js */')({ role: 'builder', messages });
      },
      reviewer: () => {
        reviewerCalls += 1;
        return `${reviewJson([])}\n${finishJson}`;
      },
    });
    const w = await world({ provider });
    const { id } = w.orchestrator.createBuild('A small site');
    await waitFor(() => w.orchestrator.get(id)?.phase === 'PLANNED', 'planned');
    w.orchestrator.approve(id);
    await waitFor(() => w.orchestrator.get(id)?.phase === 'DONE', 'done', 20_000);
    expect(reviewerCalls).toBe(1);

    w.orchestrator.edit(id, 'Rework the page and add an about page');
    await waitFor(() => w.orchestrator.get(id)?.phase === 'DONE', 'edit done', 20_000);

    // The wide edit (4 files) triggered a second review.
    expect(reviewerCalls).toBe(2);
    const events = eventsFor(w.events, id);
    const editReview = activities(events).filter((a) => a.role === 'reviewer' && a.note === 'reviewing the edit');
    expect(editReview.length).toBe(1);
    const checkpoint = events.filter((e) => e.type === 'checkpoint').pop() as
      | { checkpoint?: { files?: unknown } }
      | undefined;
    // Touched files are reported in plan order, unplanned extras last.
    expect(checkpoint?.checkpoint?.files).toEqual(['styles.css', 'index.html', 'app.js', 'about.html']);
    expect((await readSiteFile(w.sitesRoot, id, 'about.html')).toString('utf8')).toContain('about');
  });

  it('returns the build to DONE with an honest message when the edit round fails', { timeout: 30_000 }, async () => {
    const mock = createMockProvider();
    const provider: Provider = {
      complete: async (messages) => {
        const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
        if (lastUser.includes('Apply this edit now:')) throw new Error('provider exploded');
        return mock.complete(messages);
      },
      stream: async (messages, onDelta) => {
        const text = await (async () => {
          const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
          if (lastUser.includes('Apply this edit now:')) throw new Error('provider exploded');
          return mock.complete(messages);
        })();
        onDelta(text);
        return text;
      },
    };
    const w = await world({ provider });
    const id = await buildToDone(w);

    w.orchestrator.edit(id, 'This edit will fail');
    await waitFor(() => w.orchestrator.get(id)?.phase === 'DONE', 'back to done', 20_000);

    const state = w.orchestrator.get(id);
    expect(state?.phase).toBe('DONE'); // the working site survives a failed edit
    expect(state?.error).toBeUndefined();
    expect(state?.messages.some((m) => m.role === 'system' && m.text.includes('The edit failed: provider exploded'))).toBe(true);
    const types = eventTypes(w.events, id);
    expect(types.filter((t) => t === 'done')).toHaveLength(2); // initial + post-failure settle
    // Nothing was written by the failed edit.
    expect((await readSiteFile(w.sitesRoot, id, 'styles.css')).toString('utf8')).toContain('--color-bg');
  });
});

describe('fix this error', () => {
  it('feeds the error and the implicated file to one builder fix round', { timeout: 30_000 }, async () => {
    const captured = { editPrompts: [] as string[], fixPrompts: [] as string[] };
    const w = await world({ provider: editAwareProvider(captured) });
    const id = await buildToDone(w);

    const editing = w.orchestrator.fixError(id, 'Uncaught TypeError: nav is null at app.js:42');
    expect(editing.phase).toBe('EDITING');
    await waitFor(() => w.orchestrator.get(id)?.phase === 'DONE', 'fix done', 20_000);

    // app.js was rewritten; the activity stream describes the fix location.
    expect((await readSiteFile(w.sitesRoot, id, 'app.js')).toString('utf8')).toBe(FIXED_APP);
    const acts = activities(eventsFor(w.events, id));
    expect(acts.some((a) => a.role === 'builder' && a.state === 'active' && a.note === 'fixing the reported error in app.js:42')).toBe(true);

    // The fix prompt carries the error text and the implicated file's content.
    expect(captured.fixPrompts).toHaveLength(1);
    expect(captured.fixPrompts[0]).toContain('Uncaught TypeError: nav is null');
    expect(captured.fixPrompts[0]).toContain('Location: app.js, line 42');
    expect(captured.fixPrompts[0]).toContain('--- app.js ---');
    expect(captured.fixPrompts[0]).toContain('progressive enhancement'); // the real pre-fix app.js

    const checkpoint = eventsFor(w.events, id).filter((e) => e.type === 'checkpoint').pop() as
      | { checkpoint?: { kind?: unknown; files?: unknown } }
      | undefined;
    expect(checkpoint?.checkpoint?.kind).toBe('fix');
    expect(checkpoint?.checkpoint?.files).toEqual(['app.js']);
  });

  it('accepts an explicit file and line and validates them honestly', { timeout: 30_000 }, async () => {
    const captured = { editPrompts: [] as string[], fixPrompts: [] as string[] };
    const w = await world({ provider: editAwareProvider(captured) });
    const id = await buildToDone(w);

    const editing = w.orchestrator.fixError(id, 'layout collapsed', { file: 'styles.css', line: 12 });
    expect(editing.phase).toBe('EDITING');
    await waitFor(() => w.orchestrator.get(id)?.phase === 'DONE', 'fix done', 20_000);
    expect(captured.fixPrompts[0]).toContain('Location: styles.css, line 12');

    expectApiError(() => w.orchestrator.fixError(id, 'x', { file: '../evil.js' }), 400);
    expectApiError(() => w.orchestrator.fixError(id, 'x', { file: 'ghost.js' }), 400);
    expectApiError(() => w.orchestrator.fixError(id, 'x', { file: 'app.js', line: 0 }), 400);
    expectApiError(() => w.orchestrator.fixError(id, 'x', { file: 'app.js', line: 1.5 }), 400);
    expectApiError(() => w.orchestrator.fixError(id, '   '), 400);
    expectApiError(() => w.orchestrator.fixError(id, 'x'.repeat(4001)), 400);
    expectApiError(() => w.orchestrator.fixError('missing-id', 'x'), 404);
  });
});

describe('pause and resume', () => {
  it('parks between agent rounds mid-build and resumes to DONE', { timeout: 30_000 }, async () => {
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let builderCalls = 0;
    let reviewerCalls = 0;
    const provider = createScriptedProvider({
      planner: () => planJson(),
      design: writeThenFinish('styles.css', 'body { margin: 0; }'),
      copy: writeThenFinish('index.html', '<html><body>hi</body></html>'),
      builder: async () => {
        builderCalls += 1;
        if (builderCalls === 1) {
          await gate;
          return writeJson('app.js', '/* js */');
        }
        return finishJson;
      },
      reviewer: () => {
        reviewerCalls += 1;
        return `${reviewJson([])}\n${finishJson}`;
      },
    });
    const w = await world({ provider });
    const { id } = w.orchestrator.createBuild('pause me');
    await waitFor(() => w.orchestrator.get(id)?.phase === 'PLANNED', 'planned');
    w.orchestrator.approve(id);
    await waitFor(() => builderCalls === 1, 'builder round in flight');

    // A round is in flight: the pause is acknowledged as pending.
    const paused = w.orchestrator.pause(id);
    expect(paused.paused).toBe(true);
    expect(paused.phase).toBe('BUILDING');
    const pauseEvent = eventsFor(w.events, id).find((e) => e.type === 'pause') as
      | { paused?: unknown; pending?: unknown }
      | undefined;
    expect(pauseEvent?.paused).toBe(true);
    expect(pauseEvent?.pending).toBe(true);

    // The in-flight round finishes (never interrupted mid-tool-call)...
    releaseGate();
    await waitFor(() => (w.orchestrator.get(id)?.files ?? []).some((f) => f.path === 'app.js'), 'app.js written');
    await w.orchestrator.whenSettled(id);

    // ...then the machine parks before the next round: reviewer never ran.
    expect(w.orchestrator.get(id)?.phase).toBe('BUILDING');
    expect(w.orchestrator.get(id)?.paused).toBe(true);
    expect(reviewerCalls).toBe(0);

    // The paused state is on disk.
    await w.orchestrator.flush();
    const snap = JSON.parse(await fs.readFile(path.join(w.dataDir, 'builds', `${id}.json`), 'utf8')) as {
      phase: string;
      paused?: boolean;
    };
    expect(snap.phase).toBe('BUILDING');
    expect(snap.paused).toBe(true);

    const resumed = w.orchestrator.resume(id);
    expect(resumed.paused).toBe(false);
    await waitFor(() => w.orchestrator.get(id)?.phase === 'DONE', 'done', 20_000);
    expect(reviewerCalls).toBe(1);
    const onDisk = (await listSiteFiles(w.sitesRoot, id)).map((e) => e.path).sort();
    expect(onDisk).toEqual(['app.js', 'index.html', 'styles.css']);
    expect(eventTypes(w.events, id)).not.toContain('error');
  });

  it('keeps a paused build resumable across a server restart', { timeout: 30_000 }, async () => {
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let builderCalls = 0;
    const provider = createScriptedProvider({
      planner: () => planJson(),
      design: writeThenFinish('styles.css', 'body { margin: 0; }'),
      copy: writeThenFinish('index.html', '<html><body>hi</body></html>'),
      builder: async ({ messages }) => {
        builderCalls += 1;
        if (builderCalls === 1) {
          await gate;
          return writeJson('app.js', '/* js */');
        }
        const wrote = messages.some((m) => isResultMessage(m) && m.content.includes('ok: wrote app.js'));
        return wrote ? finishJson : writeJson('app.js', '/* js */');
      },
      reviewer: () => `${reviewJson([])}\n${finishJson}`,
    });
    const w = await world({ provider });
    const { id } = w.orchestrator.createBuild('pause then restart');
    await waitFor(() => w.orchestrator.get(id)?.phase === 'PLANNED', 'planned');
    w.orchestrator.approve(id);
    await waitFor(() => builderCalls === 1, 'builder in flight');
    w.orchestrator.pause(id);
    releaseGate();
    await w.orchestrator.whenSettled(id);
    await w.orchestrator.flush();
    expect(w.orchestrator.get(id)?.paused).toBe(true);

    // Simulated restart: a new orchestrator over the same directories keeps
    // the build paused (not "interrupted") and resume() drives it to DONE.
    const hub2 = new SseHub({ heartbeatMs: 600_000 });
    const events2 = collectHub(hub2);
    try {
      const orch2 = await Orchestrator.open({
        sitesRoot: w.sitesRoot,
        dataDir: w.dataDir,
        hub: hub2,
        getProvider: () => provider,
      });
      const revived = orch2.get(id);
      expect(revived?.phase).toBe('BUILDING');
      expect(revived?.paused).toBe(true);
      expect(revived?.error).toBeUndefined();

      orch2.resume(id);
      await waitFor(() => orch2.get(id)?.phase === 'DONE', 'done after restart', 20_000);
      expect(orch2.get(id)?.siteUrl).toBe(`/preview/${id}/`);
      expect(eventsFor(events2, id).some((e) => e.type === 'done')).toBe(true);
      await orch2.flush();
    } finally {
      hub2.shutdown();
    }
  });

  it('rejects pause/resume in the wrong phases with 409', { timeout: 30_000 }, async () => {
    const w = await world();
    const { id } = w.orchestrator.createBuild('not pausable yet');
    await waitFor(() => w.orchestrator.get(id)?.pendingQuestion !== undefined, 'question');
    // INTAKE parks for user input already; pausing it is meaningless.
    expectApiError(() => w.orchestrator.pause(id), 409);
    expectApiError(() => w.orchestrator.resume(id), 409);
    expectApiError(() => w.orchestrator.pause('missing-id'), 404);
    expectApiError(() => w.orchestrator.resume('missing-id'), 404);

    w.orchestrator.answer(id, 'q1', 'a portfolio');
    w.orchestrator.answer(id, 'q2', 'minimal');
    await waitFor(() => w.orchestrator.get(id)?.phase === 'PLANNED', 'planned');
    // PLANNED parks for approval; still not agent work.
    expectApiError(() => w.orchestrator.pause(id), 409);

    w.orchestrator.approve(id);
    await waitFor(() => w.orchestrator.get(id)?.phase === 'DONE', 'done', 20_000);
    expectApiError(() => w.orchestrator.pause(id), 409);
    expectApiError(() => w.orchestrator.resume(id), 409);
  });
});

describe('builder fan-out', () => {
  it('splits the remaining files of a >6-file plan into two parallel plan-ordered rounds', { timeout: 30_000 }, async () => {
    const remainingKickoffs: string[] = [];
    const provider = createScriptedProvider({
      planner: () =>
        planJson(['styles.css', 'animations.css', 'index.html', 'app.js', 'extra-a.js', 'extra-b.js', 'data.json', 'README.md']),
      design: writeThenFinish('styles.css', 'body{}'),
      copy: writeThenFinish('index.html', '<html></html>'),
      builder: ({ messages }) => {
        const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
        if (lastUser.includes('Write the remaining planned files now:')) {
          remainingKickoffs.push(lastUser);
          if (lastUser.includes('animations.css, extra-a.js, extra-b.js')) {
            const wrote = messages.some((m) => isResultMessage(m) && m.content.includes('ok: wrote extra-b.js'));
            return wrote
              ? finishJson
              : [writeJson('animations.css', '/* anim */'), writeJson('extra-a.js', '// a'), writeJson('extra-b.js', '// b')].join('\n');
          }
          if (lastUser.includes('data.json, README.md')) {
            const wrote = messages.some((m) => isResultMessage(m) && m.content.includes('ok: wrote README.md'));
            return wrote ? finishJson : [writeJson('data.json', '{}'), writeJson('README.md', '# readme')].join('\n');
          }
          return finishJson;
        }
        return writeThenFinish('app.js', '/* js */')({ role: 'builder', messages });
      },
      reviewer: () => `${reviewJson([])}\n${finishJson}`,
    });
    const w = await world({ provider });
    const { id } = w.orchestrator.createBuild('A big eight-file site');
    await waitFor(() => w.orchestrator.get(id)?.phase === 'PLANNED', 'planned');
    w.orchestrator.approve(id);
    await waitFor(() => w.orchestrator.get(id)?.phase === 'DONE', 'done', 20_000);

    // Two fan-out rounds, partitioned as contiguous plan-ordered groups.
    expect(remainingKickoffs).toHaveLength(2);
    expect(remainingKickoffs[0]).toContain('animations.css, extra-a.js, extra-b.js');
    expect(remainingKickoffs[1]).toContain('data.json, README.md');

    const onDisk = (await listSiteFiles(w.sitesRoot, id)).map((e) => e.path).sort();
    expect(onDisk).toEqual(['README.md', 'animations.css', 'app.js', 'data.json', 'extra-a.js', 'extra-b.js', 'index.html', 'styles.css']);

    // File events keep plan order inside each fan-out group.
    const filePaths = eventsFor(w.events, id)
      .filter((e) => e.type === 'file')
      .map((e) => (e as unknown as { file: { path: string } }).file.path);
    const idx = (p: string): number => filePaths.indexOf(p);
    expect(idx('animations.css')).toBeLessThan(idx('extra-a.js'));
    expect(idx('extra-a.js')).toBeLessThan(idx('extra-b.js'));
    expect(idx('data.json')).toBeLessThan(idx('README.md'));

    const acts = activities(eventsFor(w.events, id));
    expect(acts.filter((a) => a.role === 'builder' && a.note?.startsWith('writing remaining files:'))).toHaveLength(2);
  });
});

describe('edit and fix phase guards', () => {
  it('rejects wrong-phase edits/fixes with 409 and bad payloads with 400', { timeout: 30_000 }, async () => {
    const captured = { editPrompts: [] as string[], fixPrompts: [] as string[] };
    const w = await world({ provider: editAwareProvider(captured) });
    const { id } = w.orchestrator.createBuild('guard me');

    await waitFor(() => w.orchestrator.get(id)?.pendingQuestion !== undefined, 'question');
    expectApiError(() => w.orchestrator.edit(id, 'change something'), 409);
    expectApiError(() => w.orchestrator.fixError(id, 'some error'), 409);
    expectApiError(() => w.orchestrator.edit(id, '   '), 400);
    expectApiError(() => w.orchestrator.edit(id, 'x'.repeat(4001)), 400);
    expectApiError(() => w.orchestrator.edit('missing-id', 'x'), 404);

    w.orchestrator.answer(id, 'q1', 'a portfolio');
    w.orchestrator.answer(id, 'q2', 'minimal');
    await waitFor(() => w.orchestrator.get(id)?.phase === 'PLANNED', 'planned');
    expectApiError(() => w.orchestrator.edit(id, 'change something'), 409);
    expectApiError(() => w.orchestrator.fixError(id, 'some error'), 409);

    w.orchestrator.approve(id);
    await waitFor(() => w.orchestrator.get(id)?.phase === 'DONE', 'done', 20_000);

    // One edit at a time: while EDITING, a second edit or a fix conflicts.
    const editing = w.orchestrator.edit(id, 'first edit');
    expect(editing.phase).toBe('EDITING');
    expectApiError(() => w.orchestrator.edit(id, 'second edit'), 409);
    expectApiError(() => w.orchestrator.fixError(id, 'some error'), 409);
    await waitFor(() => w.orchestrator.get(id)?.phase === 'DONE', 'edit done', 20_000);

    // Back at DONE the next edit is accepted again.
    const again = w.orchestrator.edit(id, 'second edit now');
    expect(again.phase).toBe('EDITING');
    await waitFor(() => w.orchestrator.get(id)?.phase === 'DONE', 'second edit done', 20_000);
  });
});

describe('edit/fix/pause routes', () => {
  it('wires the four new endpoints with the same validation contract', { timeout: 30_000 }, async () => {
    const captured = { editPrompts: [] as string[], fixPrompts: [] as string[] };
    const w = await world({ provider: editAwareProvider(captured) });
    const app = express();
    app.use(express.json());
    app.use('/api/builds', createAgentRouter({ orchestrator: w.orchestrator, hub: w.hub }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const { port } = (server.address() as AddressInfo) ?? { port: 0 };
    const base = `http://127.0.0.1:${port}`;
    const post = (p: string, body: unknown): Promise<Response> =>
      fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

    try {
      const created = await post('/api/builds', { brief: 'A docs page for an API' });
      const { id } = (await created.json()) as { id: string };

      await waitFor(() => w.orchestrator.get(id)?.pendingQuestion !== undefined, 'question');
      // Wrong phase and payload validation before the build is DONE.
      expect((await post(`/api/builds/${id}/edit`, { instruction: 'x' })).status).toBe(409);
      expect((await post(`/api/builds/${id}/edit`, {})).status).toBe(400);
      expect((await post(`/api/builds/${id}/edit`, { instruction: 42 })).status).toBe(400);
      expect((await post(`/api/builds/${id}/fixError`, {})).status).toBe(400);
      expect((await post(`/api/builds/${id}/fixError`, { message: 'x', file: 7 })).status).toBe(400);
      expect((await post(`/api/builds/${id}/fixError`, { message: 'x', line: 'nine' })).status).toBe(400);
      expect((await post(`/api/builds/${id}/pause`, {})).status).toBe(409);
      expect((await post(`/api/builds/${id}/resume`, {})).status).toBe(409);
      expect((await post(`/api/builds/nope/edit`, { instruction: 'x' })).status).toBe(404);

      await post(`/api/builds/${id}/answer`, { questionId: 'q1', answer: 'A product or docs page' });
      await post(`/api/builds/${id}/answer`, { questionId: 'q2', answer: 'Dark and technical' });
      await waitFor(() => w.orchestrator.get(id)?.phase === 'PLANNED', 'planned');
      await post(`/api/builds/${id}/approve`, {});
      await waitFor(() => w.orchestrator.get(id)?.phase === 'DONE', 'done', 20_000);

      // Follow-up edit over HTTP.
      const editRes = await post(`/api/builds/${id}/edit`, { instruction: 'Make the docs sidebar sticky' });
      expect(editRes.status).toBe(200);
      expect(((await editRes.json()) as BuildState).phase).toBe('EDITING');
      await waitFor(() => w.orchestrator.get(id)?.phase === 'DONE', 'edit done', 20_000);
      expect((await readSiteFile(w.sitesRoot, id, 'styles.css')).toString('utf8')).toBe(EDITED_STYLES);

      // Fix-this-error over HTTP.
      const fixRes = await post(`/api/builds/${id}/fixError`, { message: 'Uncaught ReferenceError: boot is not defined at app.js:3' });
      expect(fixRes.status).toBe(200);
      expect(((await fixRes.json()) as BuildState).phase).toBe('EDITING');
      await waitFor(() => w.orchestrator.get(id)?.phase === 'DONE', 'fix done', 20_000);
      expect((await readSiteFile(w.sitesRoot, id, 'app.js')).toString('utf8')).toBe(FIXED_APP);

      // Pause/resume stay honest on a DONE build.
      expect((await post(`/api/builds/${id}/pause`, {})).status).toBe(409);
      expect((await post(`/api/builds/${id}/resume`, {})).status).toBe(409);
    } finally {
      (server as unknown as { closeIdleConnections?: () => void }).closeIdleConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
