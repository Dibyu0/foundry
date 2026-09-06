import { describe, expect, it } from 'vitest';
import {
  CONSOLE_FEED_CAP,
  DEVICE_IDS,
  DEVICE_WIDTHS,
  appendConsoleEntry,
  applyVisualChange,
  clearConsoleFeed,
  clearVisualBatch,
  consoleSignature,
  createConsoleFeed,
  createPromptQueue,
  deviceForWidth,
  deviceStageClass,
  deviceWidth,
  drainOnePrompt,
  enqueuePrompt,
  isDeviceId,
  parseMentions,
  removeQueuedPrompt,
  removeVisualChange,
  reorderQueuedPrompt,
  setConsoleFeedPaused,
  setPromptQueuePaused,
  visualBatchToInstruction,
  type ConsoleEntryInput,
  type QueuedPrompt,
  type VisualEditChange,
} from '../../web/src/lib/pure.js';

const qp = (id: string, text = `prompt ${id}`): QueuedPrompt => ({ id, text });

const change = (id: string, over: Partial<VisualEditChange> = {}): VisualEditChange => ({
  id,
  selector: `#sel-${id}`,
  property: 'color',
  value: '#fff',
  ...over,
});

const entry = (id: string, over: Partial<ConsoleEntryInput> = {}): ConsoleEntryInput => ({
  id,
  level: 'log',
  text: `message ${id}`,
  ts: 1,
  ...over,
});

describe('prompt queue', () => {
  it('enqueues in order and never mutates the input', () => {
    const q0 = createPromptQueue();
    const q1 = enqueuePrompt(q0, qp('a'));
    const q2 = enqueuePrompt(q1, qp('b'));
    expect(q0.items).toHaveLength(0);
    expect(q2.items.map((p) => p.id)).toEqual(['a', 'b']);
    expect(q2.paused).toBe(false);
  });

  it('ignores blank text and duplicate ids', () => {
    const q = enqueuePrompt(createPromptQueue(), qp('a'));
    expect(enqueuePrompt(q, qp('  ', '   '))).toBe(q);
    expect(enqueuePrompt(q, { id: 'a', text: 'different text, same id' })).toBe(q);
  });

  it('removes by id and no-ops on unknown ids', () => {
    const q = enqueuePrompt(enqueuePrompt(createPromptQueue(), qp('a')), qp('b'));
    const removed = removeQueuedPrompt(q, 'a');
    expect(removed.items.map((p) => p.id)).toEqual(['b']);
    expect(removeQueuedPrompt(q, 'nope')).toBe(q);
  });

  it('reorders with clamped indices', () => {
    let q = createPromptQueue();
    for (const id of ['a', 'b', 'c']) q = enqueuePrompt(q, qp(id));
    expect(reorderQueuedPrompt(q, 'a', 2).items.map((p) => p.id)).toEqual(['b', 'c', 'a']);
    expect(reorderQueuedPrompt(q, 'c', -5).items.map((p) => p.id)).toEqual(['c', 'a', 'b']);
    expect(reorderQueuedPrompt(q, 'a', 99).items.map((p) => p.id)).toEqual(['b', 'c', 'a']);
    expect(reorderQueuedPrompt(q, 'b', 1)).toBe(q);
    expect(reorderQueuedPrompt(q, 'nope', 0)).toBe(q);
  });

  it('drains one from the head unless paused or empty', () => {
    let q = createPromptQueue();
    for (const id of ['a', 'b']) q = enqueuePrompt(q, qp(id));
    const first = drainOnePrompt(q);
    expect(first.next?.id).toBe('a');
    expect(first.queue.items.map((p) => p.id)).toEqual(['b']);
    expect(q.items).toHaveLength(2);

    const empty = drainOnePrompt(createPromptQueue());
    expect(empty.next).toBeNull();

    const paused = setPromptQueuePaused(q, true);
    const blocked = drainOnePrompt(paused);
    expect(blocked.next).toBeNull();
    expect(blocked.queue).toBe(paused);
    expect(drainOnePrompt(setPromptQueuePaused(paused, false)).next?.id).toBe('a');
  });

  it('pause toggles are no-ops when unchanged, and enqueues still land while paused', () => {
    const q = createPromptQueue();
    expect(setPromptQueuePaused(q, false)).toBe(q);
    const paused = setPromptQueuePaused(q, true);
    expect(paused.paused).toBe(true);
    expect(enqueuePrompt(paused, qp('a')).items).toHaveLength(1);
  });
});

describe('mention parsing', () => {
  it('passes plain text through untouched', () => {
    expect(parseMentions('make me a landing page')).toEqual({
      mentions: [],
      restText: 'make me a landing page',
    });
  });

  it('extracts mentions at the start or after whitespace', () => {
    expect(parseMentions('@builder make the header sticky')).toEqual({
      mentions: ['builder'],
      restText: 'make the header sticky',
    });
    expect(parseMentions('hey @design more contrast please')).toEqual({
      mentions: ['design'],
      restText: 'hey more contrast please',
    });
  });

  it('supports file-like tokens and strips trailing punctuation', () => {
    expect(parseMentions('edit @styles.css. and @app.js')).toEqual({
      mentions: ['styles.css', 'app.js'],
      restText: 'edit and',
    });
  });

  it('dedupes mentions case-insensitively, keeping the first form', () => {
    const r = parseMentions('@Builder then @builder again');
    expect(r.mentions).toEqual(['Builder']);
    expect(r.restText).toBe('then again');
  });

  it('leaves emails and bare @ signs alone', () => {
    expect(parseMentions('contact foo@bar.com now').mentions).toEqual([]);
    expect(parseMentions('contact foo@bar.com now').restText).toBe('contact foo@bar.com now');
    expect(parseMentions('@ alone').mentions).toEqual([]);
    expect(parseMentions('@@double').mentions).toEqual([]);
  });

  it('collapses the whitespace mentions leave behind', () => {
    expect(parseMentions('@a   @b   go').restText).toBe('go');
  });
});

describe('visual edit batch', () => {
  it('appends distinct changes', () => {
    let batch = clearVisualBatch();
    batch = applyVisualChange(batch, change('c1'));
    batch = applyVisualChange(batch, change('c2', { selector: '.btn', property: 'background' }));
    expect(batch.map((c) => c.id)).toEqual(['c1', 'c2']);
  });

  it('latest change wins per (selector, property) and keeps its slot', () => {
    let batch = clearVisualBatch();
    batch = applyVisualChange(batch, change('c1', { selector: 'h1', value: 'red' }));
    batch = applyVisualChange(batch, change('c2', { selector: 'p' }));
    batch = applyVisualChange(batch, change('c3', { selector: 'h1', value: 'blue' }));
    expect(batch.map((c) => c.id)).toEqual(['c3', 'c2']);
    expect(batch[0]?.value).toBe('blue');
  });

  it('replaces in place when the same id is applied again', () => {
    let batch = clearVisualBatch();
    batch = applyVisualChange(batch, change('c1', { value: 'red' }));
    batch = applyVisualChange(batch, change('c1', { value: 'green' }));
    expect(batch).toHaveLength(1);
    expect(batch[0]?.value).toBe('green');
  });

  it('removes by id, no-ops on unknown ids, and clears', () => {
    let batch = clearVisualBatch();
    batch = applyVisualChange(batch, change('c1'));
    batch = applyVisualChange(batch, change('c2'));
    expect(removeVisualChange(batch, 'c1').map((c) => c.id)).toEqual(['c2']);
    expect(removeVisualChange(batch, 'nope')).toBe(batch);
    expect(clearVisualBatch()).toEqual([]);
  });

  it('renders an empty batch as an empty instruction', () => {
    expect(visualBatchToInstruction([])).toBe('');
  });

  it('renders a numbered instruction with labels, values and previous values', () => {
    const batch = applyVisualChange(
      clearVisualBatch(),
      change('c1', {
        selector: 'h1.hero',
        label: 'Hero title',
        property: 'text',
        value: 'Welcome',
        previousValue: 'Hello',
      }),
    );
    const withStyle = applyVisualChange(batch, change('c2', { selector: '.btn', property: 'background-color', value: '#000' }));
    expect(visualBatchToInstruction(withStyle)).toBe(
      [
        'Apply these visual edits to the site:',
        '1. Hero title (h1.hero): set text to "Welcome" (was "Hello").',
        '2. .btn: set background-color to "#000".',
      ].join('\n'),
    );
  });
});

describe('console feed', () => {
  it('appends entries with count 1 and a signature', () => {
    const feed = appendConsoleEntry(createConsoleFeed(), entry('e1'));
    expect(feed.entries).toHaveLength(1);
    expect(feed.entries[0]?.count).toBe(1);
    expect(feed.entries[0]?.signature).toBe(consoleSignature('log', 'message e1', undefined, undefined));
    expect(feed.truncated).toBe(0);
  });

  it('dedupes repeats by signature: bumps count, refreshes ts, keeps id, moves to end', () => {
    let feed = createConsoleFeed();
    feed = appendConsoleEntry(feed, entry('e1', { ts: 1 }));
    feed = appendConsoleEntry(feed, entry('e2', { text: 'other', ts: 2 }));
    feed = appendConsoleEntry(feed, entry('e3', { text: 'message e1', ts: 3 }));
    expect(feed.entries.map((e) => e.id)).toEqual(['e2', 'e1']);
    const bumped = feed.entries[1];
    expect(bumped?.count).toBe(2);
    expect(bumped?.ts).toBe(3);
    expect(bumped?.id).toBe('e1');
  });

  it('does not dedupe across levels, sources or lines', () => {
    let feed = createConsoleFeed();
    feed = appendConsoleEntry(feed, entry('e1', { level: 'warn' }));
    feed = appendConsoleEntry(feed, entry('e2', { level: 'error' }));
    feed = appendConsoleEntry(feed, entry('e3', { source: 'app.js', line: 4 }));
    expect(feed.entries).toHaveLength(3);
    expect(consoleSignature('log', 'x', 'a.js', 1)).not.toBe(consoleSignature('log', 'x', 'a.js', 2));
  });

  it('drops entries while paused and resumes cleanly', () => {
    let feed = appendConsoleEntry(createConsoleFeed(), entry('e1'));
    const paused = setConsoleFeedPaused(feed, true);
    expect(appendConsoleEntry(paused, entry('e2'))).toBe(paused);
    feed = appendConsoleEntry(setConsoleFeedPaused(paused, false), entry('e2'));
    expect(feed.entries.map((e) => e.id)).toEqual(['e1', 'e2']);
  });

  it('clear empties entries and the truncated counter but keeps the pause state', () => {
    let feed = appendConsoleEntry(createConsoleFeed(), entry('e1'));
    feed = setConsoleFeedPaused(feed, true);
    const cleared = clearConsoleFeed(feed);
    expect(cleared.entries).toHaveLength(0);
    expect(cleared.truncated).toBe(0);
    expect(cleared.paused).toBe(true);
    const fresh = createConsoleFeed();
    expect(clearConsoleFeed(fresh)).toBe(fresh);
  });

  it('caps at 500 entries, dropping the oldest and counting them honestly', () => {
    let feed = createConsoleFeed();
    for (let i = 0; i < CONSOLE_FEED_CAP; i += 1) feed = appendConsoleEntry(feed, entry(`e${i}`));
    expect(feed.entries).toHaveLength(CONSOLE_FEED_CAP);
    feed = appendConsoleEntry(feed, entry('new'));
    expect(feed.entries).toHaveLength(CONSOLE_FEED_CAP);
    expect(feed.truncated).toBe(1);
    expect(feed.entries[0]?.id).toBe('e1');
    expect(feed.entries[CONSOLE_FEED_CAP - 1]?.id).toBe('new');
  });

  it('a repeat inside a full feed does not truncate', () => {
    let feed = createConsoleFeed();
    for (let i = 0; i < CONSOLE_FEED_CAP; i += 1) feed = appendConsoleEntry(feed, entry(`e${i}`));
    feed = appendConsoleEntry(feed, entry('repeat', { text: 'message e0' }));
    expect(feed.entries).toHaveLength(CONSOLE_FEED_CAP);
    expect(feed.truncated).toBe(0);
    expect(feed.entries[CONSOLE_FEED_CAP - 1]?.count).toBe(2);
  });
});

describe('device widths', () => {
  it('mirrors the styles.css stage widths, with desktop fluid', () => {
    expect(DEVICE_IDS).toEqual(['mobile', 'tablet', 'desktop']);
    expect(deviceWidth('mobile')).toBe(390);
    expect(deviceWidth('tablet')).toBe(768);
    expect(deviceWidth('desktop')).toBeNull();
    expect(DEVICE_WIDTHS.desktop).toBeNull();
  });

  it('maps ids to stage classes and guards unknown ids', () => {
    expect(deviceStageClass('mobile')).toBe('w--mobile');
    expect(deviceStageClass('tablet')).toBe('w--tablet');
    expect(deviceStageClass('desktop')).toBe('w--desktop');
    expect(isDeviceId('mobile')).toBe(true);
    expect(isDeviceId('watch')).toBe(false);
    expect(isDeviceId(undefined)).toBe(false);
  });

  it('classifies viewport widths into the nearest preset', () => {
    expect(deviceForWidth(390)).toBe('mobile');
    expect(deviceForWidth(639)).toBe('mobile');
    expect(deviceForWidth(640)).toBe('tablet');
    expect(deviceForWidth(768)).toBe('tablet');
    expect(deviceForWidth(1099)).toBe('tablet');
    expect(deviceForWidth(1100)).toBe('desktop');
    expect(deviceForWidth(1440)).toBe('desktop');
    expect(deviceForWidth(Number.NaN)).toBe('mobile');
    expect(deviceForWidth(-1)).toBe('mobile');
  });
});
