import { promises as fs } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { listSiteFiles, readSiteFile } from '../src/sites.js';
import { eventsFor, eventTypes, makeWorld, waitFor, type World } from './helpers.js';

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

/** Plan order: design files first, then markup, behavior, docs. */
const PREMIUM_FILES = ['styles.css', 'animations.css', 'index.html', 'app.js', 'README.md'];

interface FileEventPayload {
  path: string;
  bytes: number;
}

function fileEvents(events: ReturnType<typeof eventsFor>): FileEventPayload[] {
  return events
    .filter((e) => e.type === 'file')
    .map((e) => (e as unknown as { file: FileEventPayload }).file);
}

describe('premium mock build (real orchestrator, real mock provider, real store)', () => {
  it('runs the full Aurora Coffee recipe to DONE with five real files', { timeout: 30_000 }, async () => {
    const w = await world();
    const brief = 'a landing page for a coffee subscription startup';
    const { id } = w.orchestrator.createBuild(brief);

    // Intake: two sharp questions, served one at a time from the queue.
    await waitFor(() => w.orchestrator.get(id)?.pendingQuestion !== undefined, 'first question');
    const q1 = w.orchestrator.get(id)?.pendingQuestion;
    expect(q1?.id).toBe('q1');
    expect(q1?.options.length ?? 0).toBeGreaterThanOrEqual(2);
    w.orchestrator.answer(id, 'q1', 'Sell a subscription');
    expect(w.orchestrator.get(id)?.pendingQuestion?.id).toBe('q2');
    w.orchestrator.answer(id, 'q2', 'Dark, metallic, animated');

    // Plan: six steps, five files in plan order, summary references the brief.
    await waitFor(() => w.orchestrator.get(id)?.phase === 'PLANNED', 'plan');
    const planned = w.orchestrator.get(id);
    const steps = (planned?.plan?.steps ?? []) as Array<{ files: string[] }>;
    expect(steps).toHaveLength(6);
    expect(steps.flatMap((s) => s.files)).toEqual(PREMIUM_FILES);
    const summary = String(planned?.plan?.summary ?? '');
    expect(summary).toContain('Aurora Coffee');
    expect(summary).toContain('coffee subscription');

    w.orchestrator.approve(id);
    await waitFor(() => w.orchestrator.get(id)?.phase === 'DONE', 'done', 20_000);

    const state = w.orchestrator.get(id);
    expect(state?.siteUrl).toBe(`/preview/${id}/`);
    expect(state?.files.map((f) => f.path).sort()).toEqual([...PREMIUM_FILES].sort());

    // The reviewer acknowledged the recipe with 0-1 issues; here one real
    // finding went back and the fix pass rewrote index.html. Findings are
    // cleared on completion (resolved issues are not open at DONE).
    expect(state?.issues).toBeUndefined();

    // All five files really landed in the confined store on disk.
    const diskEntries = await listSiteFiles(w.sitesRoot, id);
    expect(diskEntries.map((e) => e.path).sort()).toEqual([...PREMIUM_FILES].sort());

    const contents = new Map<string, string>();
    for (const p of PREMIUM_FILES) {
      contents.set(p, (await readSiteFile(w.sitesRoot, id, p)).toString('utf8'));
    }

    // Every file is non-trivial (README is the only small one).
    for (const p of ['styles.css', 'animations.css', 'index.html', 'app.js']) {
      expect(Buffer.byteLength(contents.get(p) ?? '', 'utf8'), `${p} should exceed 2KB`).toBeGreaterThan(2048);
    }
    expect(Buffer.byteLength(contents.get('README.md') ?? '', 'utf8')).toBeGreaterThan(400);

    // Blueprint markers in the markup.
    const html = contents.get('index.html') ?? '';
    for (const marker of ['class="nav"', 'hero', 'marquee', 'id="pricing"', 'faq-item', 'Aurora']) {
      expect(html, `index.html missing ${marker}`).toContain(marker);
    }
    // Proof the fix pass shipped: the nav toggle gained an accessible name.
    expect(html).toContain('aria-label="Toggle navigation"');

    const styles = contents.get('styles.css') ?? '';
    expect(styles).toContain('backdrop-filter');
    expect(styles).toContain('--gradient-aurora');
    expect(styles).toContain('--color-accent');

    const animations = contents.get('animations.css') ?? '';
    expect(animations).toContain('@keyframes');
    expect(animations).toContain('prefers-reduced-motion');

    expect(contents.get('app.js') ?? '').toContain('IntersectionObserver');

    // No lorem anywhere, case-insensitive.
    for (const [p, text] of contents) {
      expect(/lorem/i.test(text), `${p} contains lorem`).toBe(false);
    }

    // SSE: file events carry path + bytes for every file, in plan order of
    // first appearance (index.html re-appears once after the fix pass).
    const fevents = fileEvents(eventsFor(w.events, id));
    for (const f of fevents) {
      expect(typeof f.path).toBe('string');
      expect(typeof f.bytes).toBe('number');
      expect(f.bytes).toBeGreaterThan(0);
    }
    const firstAppearance: string[] = [];
    for (const f of fevents) {
      if (!firstAppearance.includes(f.path)) firstAppearance.push(f.path);
    }
    expect(new Set(firstAppearance)).toEqual(new Set(PREMIUM_FILES));
    expect(firstAppearance.slice(0, 2)).toEqual(['styles.css', 'animations.css']);
    expect(firstAppearance[firstAppearance.length - 1]).toBe('README.md');
    expect(fevents.filter((f) => f.path === 'index.html').length).toBeGreaterThanOrEqual(2);

    // Final event bytes per file match the bytes on disk.
    const diskSizes = new Map(diskEntries.map((e) => [e.path, e.size]));
    const lastBytes = new Map<string, number>();
    for (const f of fevents) lastBytes.set(f.path, f.bytes);
    for (const p of PREMIUM_FILES) {
      expect(lastBytes.get(p), `file event bytes for ${p}`).toBe(diskSizes.get(p));
    }

    // Lifecycle ordering: question -> plan -> files -> review -> done.
    const types = eventTypes(w.events, id);
    expect(types.filter((t) => t === 'question')).toHaveLength(2);
    const idx = (t: string): number => types.indexOf(t);
    expect(idx('question')).toBeLessThan(idx('plan'));
    expect(idx('plan')).toBeLessThan(idx('file'));
    expect(idx('file')).toBeLessThan(idx('review'));
    expect(idx('review')).toBeLessThan(idx('done'));
  });
});
