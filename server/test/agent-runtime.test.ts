import { describe, expect, it } from 'vitest';
import {
  createKimiProvider,
  createMockProvider,
  createOllamaProvider,
  parseSseLines,
  ProviderError,
} from '../src/agent/provider.js';
import type { ChatMessage, Provider } from '../src/agent/provider.js';
import { createRuntime } from '../src/agent/runtime.js';
import type { AgentEvent } from '../src/agent/runtime.js';
import {
  executeFsTool,
  extractToolCalls,
  validateAskArgs,
  validatePath,
  validatePlanArgs,
  validateReviewNotesArgs,
} from '../src/agent/tools.js';
import {
  byteStreamResponse,
  fetchQueue,
  jsonResponse,
  memoryStore,
  scriptedProvider,
} from './helpers/fakes.js';
import type { CapturedRequest } from './helpers/fakes.js';

function collector(): { events: AgentEvent[]; onEvent: (e: AgentEvent) => void } {
  const events: AgentEvent[] = [];
  return { events, onEvent: (e) => events.push(e) };
}

const toolCall = (tool: string, args: unknown): string => JSON.stringify({ tool, args });

describe('mock provider', () => {
  it('planner asks two questions with options on the first pass', async () => {
    const p = createMockProvider();
    const out = await p.complete([
      { role: 'system', content: 'You plan builds. [role:planner]' },
      { role: 'user', content: 'Build me a site.' },
    ]);
    const { calls } = extractToolCalls(out);
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.name === 'ask')).toBe(true);
    const first = calls[0]!.args;
    expect(typeof first.question).toBe('string');
    expect(Array.isArray(first.options)).toBe(true);
    expect((first.options as string[]).length).toBeGreaterThan(1);
  });

  it('planner emits a 4-step plan once answers are in the transcript', async () => {
    const p = createMockProvider();
    const out = await p.complete([
      { role: 'system', content: '[role:planner]' },
      { role: 'user', content: 'Build me a site.' },
      { role: 'assistant', content: `text ${toolCall('ask', { question: 'Who?', options: ['a', 'b'] })}` },
      { role: 'user', content: 'answer: a small-business landing page' },
    ]);
    const { calls } = extractToolCalls(out);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe('plan');
    const steps = (calls[0]!.args as { steps: Array<{ files: string[] }> }).steps;
    expect(steps).toHaveLength(4);
    const files = steps.flatMap((s) => s.files);
    expect(files).toEqual(expect.arrayContaining(['index.html', 'styles.css', 'app.js', 'README.md']));
  });

  it('design/copy/builder return real site files in the tool convention', async () => {
    const p = createMockProvider();
    const cases: Array<[string, string, string]> = [
      ['design', 'styles.css', '--color-accent'],
      ['copy', 'index.html', '<!doctype html>'],
      ['builder', 'app.js', 'addEventListener'],
    ];
    for (const [role, path, needle] of cases) {
      const out = await p.complete([{ role: 'system', content: `[role:${role}]` }]);
      const { calls } = extractToolCalls(out);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.name).toBe('writeFile');
      expect(calls[0]!.args.path).toBe(path);
      expect(calls[0]!.args.content as string).toContain(needle);
    }
  });

  it('reviewer emits reviewNotes and finish in one response', async () => {
    const p = createMockProvider();
    const out = await p.complete([{ role: 'system', content: '[role:reviewer]' }]);
    const { calls } = extractToolCalls(out);
    expect(calls.map((c) => c.name)).toEqual(['reviewNotes', 'finish']);
  });

  it('finishes honestly when no role marker is present', async () => {
    const p = createMockProvider();
    const out = await p.complete([{ role: 'system', content: 'no marker here' }]);
    const { calls } = extractToolCalls(out);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe('finish');
    expect(calls[0]!.args.summary as string).toContain('no [role:');
  });

  it('streams the canned response as deltas that reassemble exactly', async () => {
    const p = createMockProvider();
    const messages: ChatMessage[] = [{ role: 'system', content: '[role:design]' }];
    const expected = await p.complete(messages);
    const deltas: string[] = [];
    const full = await p.stream(messages, (d) => deltas.push(d));
    expect(full).toBe(expected);
    expect(deltas.join('')).toBe(expected);
    expect(deltas.length).toBeGreaterThan(1);
  });
});

describe('tool extraction', () => {
  it('extracts bare and fenced calls and strips them from the prose', () => {
    const res = extractToolCalls(
      'Intro.\n'
        + `${toolCall('listFiles', {})}\n`
        + 'Middle.\n'
        + '```json\n'
        + `${toolCall('finish', { summary: 'done' })}\n`
        + '```\n'
        + 'After.',
    );
    expect(res.calls.map((c) => c.name)).toEqual(['listFiles', 'finish']);
    expect(res.notes).toEqual([]);
    expect(res.text).toContain('Intro.');
    expect(res.text).toContain('Middle.');
    expect(res.text).toContain('After.');
    expect(res.text).not.toContain('listFiles');
    expect(res.text).not.toContain('finish');
  });

  it('extracts several calls from one fenced block', () => {
    const res = extractToolCalls(
      `\`\`\`json\n${toolCall('writeFile', { path: 'a.txt', content: 'x' })}\n${toolCall('finish', { summary: 's' })}\n\`\`\``,
    );
    expect(res.calls.map((c) => c.name)).toEqual(['writeFile', 'finish']);
    expect(res.text).toBe('');
  });

  it('skips malformed fenced tool JSON with a note and keeps it as prose', () => {
    const broken = '{"tool":"writeFile","args":{"path":"a.txt", BROKEN}}';
    const res = extractToolCalls(`\`\`\`json\n${broken}\n\`\`\``);
    expect(res.calls).toEqual([]);
    expect(res.notes).toHaveLength(1);
    expect(res.notes[0]).toContain('skipped malformed tool JSON');
    expect(res.text).toContain('BROKEN');
  });

  it('notes unbalanced trailing tool JSON', () => {
    const res = extractToolCalls('partial: {"tool":"finish","args":{');
    expect(res.calls).toEqual([]);
    expect(res.notes).toHaveLength(1);
    expect(res.notes[0]).toContain('unbalanced braces');
  });

  it('ignores prose braces that are not tool calls', () => {
    const res = extractToolCalls('Use a { b } block and {"not":"a tool"} here.');
    expect(res.calls).toEqual([]);
    expect(res.notes).toEqual([]);
  });
});

describe('argument validation', () => {
  it('validatePath accepts relative POSIX paths', () => {
    for (const good of ['index.html', 'css/styles.css', 'a/b/c-1_2.txt']) {
      const v = validatePath(good);
      expect(v.ok).toBe(true);
    }
  });

  it('validatePath rejects escapes, absolutes, backslashes and empties', () => {
    const cases: Array<[unknown, string]> = [
      ['../secret', 'path escapes site root'],
      ['a/../../b', 'path escapes site root'],
      ['/etc/passwd', 'absolute paths are not allowed'],
      ['C:/temp/x', 'absolute paths are not allowed'],
      ['a\\b', 'POSIX separators'],
      ['', 'non-empty string'],
      [42, 'non-empty string'],
      ['a//b', 'empty segment'],
      ['./a', '"." segment'],
    ];
    for (const [input, needle] of cases) {
      const v = validatePath(input);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.error).toContain(needle);
    }
  });

  it('validateAskArgs enforces shape and derives a stable id', () => {
    expect(validateAskArgs({}).ok).toBe(false);
    const v = validateAskArgs({ question: 'Pick one?', options: ['a', 'b'] });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.value.id).toMatch(/^q-/);
      expect(v.value.options).toEqual(['a', 'b']);
    }
    const again = validateAskArgs({ question: 'Pick one?' });
    if (v.ok && again.ok) expect(again.value.id).toBe(v.value.id);
    expect(validateAskArgs({ question: 'q', options: [''] }).ok).toBe(false);
    const explicit = validateAskArgs({ id: 'q7', question: 'q' });
    expect(explicit.ok && explicit.value.id === 'q7').toBe(true);
  });

  it('validatePlanArgs requires steps with valid files', () => {
    expect(validatePlanArgs({ summary: 's' }).ok).toBe(false);
    expect(validatePlanArgs({ summary: 's', steps: [] }).ok).toBe(false);
    const bad = validatePlanArgs({
      summary: 's',
      steps: [{ id: 's1', title: 't', detail: 'd', files: ['../x'] }],
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain('path escapes site root');
    const good = validatePlanArgs({
      summary: 's',
      steps: [{ id: 's1', title: 't', files: ['index.html'] }],
    });
    expect(good.ok).toBe(true);
    if (good.ok) {
      expect(good.value.steps[0]!.detail).toBe('');
      expect(good.value.steps[0]!.files).toEqual(['index.html']);
    }
  });

  it('validateReviewNotesArgs normalizes severity and allows empty issues', () => {
    const empty = validateReviewNotesArgs({ issues: [] });
    expect(empty.ok).toBe(true);
    const v = validateReviewNotesArgs({ issues: [{ severity: 'warning', detail: 'd' }] });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.value[0]!.severity).toBe('warn');
    expect(validateReviewNotesArgs({ issues: [{ severity: 'fatal', detail: 'd' }] }).ok).toBe(false);
    expect(validateReviewNotesArgs({ issues: [{ severity: 'warn', file: '/abs', detail: 'd' }] }).ok).toBe(false);
  });
});

describe('filesystem tool execution', () => {
  it('writes within caps and reports byte counts', async () => {
    const store = memoryStore();
    const res = await executeFsTool(store, { name: 'writeFile', args: { path: 'a.txt', content: 'hi' } });
    expect(res).toBe('ok: wrote a.txt (2 bytes)');
    expect(store.files.get('a.txt')).toBe('hi');
  });

  it('rejects escaping paths before the store is touched', async () => {
    const store = memoryStore();
    const res = await executeFsTool(store, { name: 'writeFile', args: { path: '../evil.ts', content: 'x' } });
    expect(res).toBe('error: path escapes site root');
    expect(store.files.size).toBe(0);
    expect(store.writes).toEqual([]);
  });

  it('enforces the 256KB content cap', async () => {
    const store = memoryStore();
    const res = await executeFsTool(store, {
      name: 'writeFile',
      args: { path: 'big.txt', content: 'a'.repeat(256 * 1024 + 1) },
    });
    expect(res).toContain('error: content exceeds the 256KB per-file limit');
    expect(store.files.size).toBe(0);
  });

  it('surfaces store read errors as result strings', async () => {
    const store = memoryStore();
    const res = await executeFsTool(store, { name: 'readFile', args: { path: 'missing.txt' } });
    expect(res).toBe('error: no such file: missing.txt');
  });

  it('truncates oversized reads with a note', async () => {
    const store = memoryStore();
    store.files.set('big.txt', 'z'.repeat(70_000));
    const res = await executeFsTool(store, { name: 'readFile', args: { path: 'big.txt' } });
    expect(res).toContain('truncated at 65536 chars');
    expect(res.length).toBeLessThan(70_000);
  });

  it('lists files honestly', async () => {
    const store = memoryStore();
    expect(await executeFsTool(store, { name: 'listFiles', args: {} })).toBe('(no files yet)');
    store.files.set('a.txt', '1');
    store.files.set('b.txt', '2');
    expect(await executeFsTool(store, { name: 'listFiles', args: {} })).toBe('a.txt\nb.txt');
  });

  it('rejects unknown tools', async () => {
    const store = memoryStore();
    const res = await executeFsTool(store, { name: 'nuke', args: {} });
    expect(res).toBe('error: unknown tool "nuke"');
  });
});

describe('agent runtime', () => {
  it('drives the planner flow: ask -> answers appended -> plan', async () => {
    const store = memoryStore();
    const rt = createRuntime({ provider: createMockProvider(), store });
    const messages: ChatMessage[] = [
      { role: 'system', content: 'You are the planner. [role:planner]' },
      { role: 'user', content: 'Build a landing page for my bakery.' },
    ];
    const { events, onEvent } = collector();

    const r1 = await rt.run(messages, { onEvent });
    expect(r1.status).toBe('awaiting-answer');
    expect(r1.questions).toHaveLength(2);
    expect(r1.questions[0]!.options.length).toBeGreaterThan(1);
    expect(events.filter((e) => e.type === 'question')).toHaveLength(2);

    messages.push({ role: 'user', content: 'answers: q1 = small-business landing page; q2 = clean and minimal' });
    const r2 = await rt.run(messages, { onEvent });
    expect(r2.status).toBe('awaiting-approval');
    expect(r2.plan).not.toBeNull();
    expect(r2.plan!.steps).toHaveLength(4);
    const files = r2.plan!.steps.flatMap((s) => s.files);
    expect(files).toEqual(expect.arrayContaining(['index.html', 'styles.css', 'app.js', 'README.md']));
    expect(events.some((e) => e.type === 'plan')).toBe(true);
  });

  it('runs reviewer notes into a finished status', async () => {
    const rt = createRuntime({ provider: createMockProvider(), store: memoryStore() });
    const { events, onEvent } = collector();
    const r = await rt.run(
      [
        { role: 'system', content: '[role:reviewer]' },
        { role: 'user', content: 'Review the site.' },
      ],
      { onEvent },
    );
    expect(r.status).toBe('finished');
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]!.severity).toBe('warn');
    expect(r.summary).toContain('reviewed');
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['review', 'finish']));
  });

  it('executes writes and finishes across iterations', async () => {
    const store = memoryStore();
    const provider = scriptedProvider([
      toolCall('writeFile', { path: 'index.html', content: '<h1>hi</h1>' }),
      toolCall('finish', { summary: 'built' }),
    ]);
    const rt = createRuntime({ provider, store });
    const r = await rt.run([{ role: 'user', content: 'build' }]);
    expect(r.status).toBe('finished');
    expect(r.summary).toBe('built');
    expect(store.files.get('index.html')).toBe('<h1>hi</h1>');
    const toolMessages = r.messages.filter((m) => m.role === 'tool');
    expect(toolMessages[0]!.content).toContain('[writeFile] ok: wrote index.html');
  });

  it('surfaces path-validation errors to the model without touching the store', async () => {
    const store = memoryStore();
    const provider = scriptedProvider([
      `${toolCall('writeFile', { path: '../evil.ts', content: 'x' })}\n${toolCall('finish', { summary: 's' })}`,
    ]);
    const { events, onEvent } = collector();
    const rt = createRuntime({ provider, store });
    const r = await rt.run([{ role: 'user', content: 'build' }], { onEvent });
    expect(r.status).toBe('finished');
    expect(store.files.size).toBe(0);
    expect(r.messages.some((m) => m.role === 'tool' && m.content.includes('error: path escapes site root'))).toBe(true);
    expect(events.some((e) => e.type === 'tool' && e.result.includes('path escapes site root'))).toBe(true);
  });

  it('skips malformed tool JSON with a note appended to the transcript', async () => {
    const store = memoryStore();
    const provider = scriptedProvider([
      'Here you go.\n'
        + `${toolCall('writeFile', { path: 'ok.txt', content: 'hi' })}\n`
        + '{"tool":"writeFile","args":{"path":"bad.txt","content":OOPS}}\n'
        + toolCall('finish', { summary: 'done' }),
    ]);
    const { events, onEvent } = collector();
    const rt = createRuntime({ provider, store });
    const r = await rt.run([{ role: 'user', content: 'build' }], { onEvent });
    expect(r.status).toBe('finished');
    expect(store.files.has('ok.txt')).toBe(true);
    expect(store.files.has('bad.txt')).toBe(false);
    expect(r.messages.some((m) => m.role === 'tool' && m.content.startsWith('note: skipped malformed tool JSON'))).toBe(true);
    expect(events.some((e) => e.type === 'note' && e.message.includes('malformed'))).toBe(true);
  });

  it('rejects with an aborted error when aborted mid-run', async () => {
    const hanging: Provider = {
      complete: () => new Promise<string>(() => undefined),
      stream: () => new Promise<string>(() => undefined),
    };
    const rt = createRuntime({ provider: hanging, store: memoryStore() });
    const { events, onEvent } = collector();
    const controller = new AbortController();
    const pending = rt.run([{ role: 'user', content: 'x' }], { signal: controller.signal, onEvent });
    setTimeout(() => controller.abort(), 10);
    await expect(pending).rejects.toThrow(/aborted/i);
    expect(events.some((e) => e.type === 'error' && /aborted/i.test(e.message))).toBe(true);
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const provider = scriptedProvider(['never']);
    const rt = createRuntime({ provider, store: memoryStore() });
    const controller = new AbortController();
    controller.abort();
    await expect(rt.run([{ role: 'user', content: 'x' }], { signal: controller.signal })).rejects.toThrow(/aborted/i);
    expect(provider.calls).toHaveLength(0);
  });

  it('stops with an error when the model repeats itself 3 times', async () => {
    const store = memoryStore();
    const provider = scriptedProvider([toolCall('listFiles', {})]);
    const rt = createRuntime({ provider, store });
    await expect(rt.run([{ role: 'user', content: 'x' }])).rejects.toThrow(/repeated the same response 3 times/i);
    expect(store.listCount).toBe(2);
  });

  it('retries an empty response once, then succeeds', async () => {
    const provider = scriptedProvider(['', toolCall('finish', { summary: 'recovered' })]);
    const { events, onEvent } = collector();
    const rt = createRuntime({ provider, store: memoryStore() });
    const r = await rt.run([{ role: 'user', content: 'x' }], { onEvent });
    expect(r.status).toBe('finished');
    expect(events.some((e) => e.type === 'note' && e.message.includes('empty response'))).toBe(true);
  });

  it('rejects when the response stays empty after the retry', async () => {
    const provider = scriptedProvider(['', '   ']);
    const rt = createRuntime({ provider, store: memoryStore() });
    await expect(rt.run([{ role: 'user', content: 'x' }])).rejects.toThrow(/empty response twice/i);
  });

  it('stops at max iterations with an honest status', async () => {
    const store = memoryStore();
    let n = 0;
    const provider = scriptedProvider([() => `checking ${(n += 1)}\n${toolCall('listFiles', {})}`]);
    const { events, onEvent } = collector();
    const rt = createRuntime({ provider, store });
    const r = await rt.run([{ role: 'user', content: 'x' }], { maxIterations: 3, onEvent });
    expect(r.status).toBe('max-iterations');
    expect(store.listCount).toBe(3);
    expect(events.some((e) => e.type === 'error' && e.message.includes('max iterations'))).toBe(true);
  });

  it('stops with no-tools when the model answers in prose', async () => {
    const provider = scriptedProvider(['Just prose, nothing to do.']);
    const { events, onEvent } = collector();
    const rt = createRuntime({ provider, store: memoryStore() });
    const messages: ChatMessage[] = [{ role: 'user', content: 'x' }];
    const r = await rt.run(messages, { onEvent });
    expect(r.status).toBe('no-tools');
    expect(events.some((e) => e.type === 'text' && e.text.includes('Just prose'))).toBe(true);
    expect(messages.at(-1)).toEqual({ role: 'assistant', content: 'Just prose, nothing to do.' });
  });

  it('reports unknown tools to the model and keeps going', async () => {
    const provider = scriptedProvider([
      `${toolCall('nuke', {})}\n${toolCall('finish', { summary: 'x' })}`,
    ]);
    const { events, onEvent } = collector();
    const rt = createRuntime({ provider, store: memoryStore() });
    const r = await rt.run([{ role: 'user', content: 'x' }], { onEvent });
    expect(r.status).toBe('finished');
    expect(events.some((e) => e.type === 'tool' && e.result === 'error: unknown tool "nuke"')).toBe(true);
  });
});

describe('SSE line parser', () => {
  it('handles byte-wise chunks, CRLF splits and multi-byte characters', async () => {
    const payload = 'data: a\r\ndata: b\ndata: caf\u00e9 \u2603 \u{1f600}\n\n';
    const res = byteStreamResponse(payload);
    const lines: string[] = [];
    await parseSseLines(res.body!, (line) => lines.push(line));
    expect(lines).toEqual(['data: a', 'data: b', 'data: caf\u00e9 \u2603 \u{1f600}', '']);
  });

  it('delivers a trailing unterminated line at end of stream', async () => {
    const res = byteStreamResponse('data: tail');
    const lines: string[] = [];
    await parseSseLines(res.body!, (line) => lines.push(line));
    expect(lines).toEqual(['data: tail']);
  });
});

describe('kimi (openai-compatible) provider', () => {
  const userOnly: ChatMessage[] = [{ role: 'user', content: 'x' }];

  it('posts chat completions with auth, model and tool-role mapping', async () => {
    const captured: CapturedRequest[] = [];
    const fetchImpl = fetchQueue(
      [jsonResponse(200, { choices: [{ message: { role: 'assistant', content: 'hi there' } }] })],
      captured,
    );
    const provider = createKimiProvider({ fetchImpl, getKey: () => 'sk-test', random: () => 0 });
    const out = await provider.complete([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hello' },
      { role: 'tool', content: '[listFiles] a.txt' },
    ]);
    expect(out).toBe('hi there');
    expect(captured).toHaveLength(1);
    const req = captured[0]!;
    expect(req.url).toBe('https://api.moonshot.ai/v1/chat/completions');
    expect(req.method).toBe('POST');
    expect(req.headers.authorization).toBe('Bearer sk-test');
    const body = req.body as { model: string; stream: boolean; messages: Array<{ role: string }> };
    expect(body.model).toBe('kimi-k2-0711-preview');
    expect(body.stream).toBe(false);
    expect(body.messages[2]!.role).toBe('user');
  });

  it('normalizes endpoint trailing slashes and existing suffixes', async () => {
    for (const [endpoint, expected] of [
      ['http://x.test/v1/', 'http://x.test/v1/chat/completions'],
      ['http://x.test/v1/chat/completions', 'http://x.test/v1/chat/completions'],
    ] as const) {
      const captured: CapturedRequest[] = [];
      const fetchImpl = fetchQueue(
        [jsonResponse(200, { choices: [{ message: { content: 'ok' } }] })],
        captured,
      );
      const provider = createKimiProvider({ endpoint, fetchImpl, getKey: () => 'k' });
      await provider.complete(userOnly);
      expect(captured[0]!.url).toBe(expected);
    }
  });

  it('parses streamed deltas fed byte-wise with a [DONE] sentinel', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"role":"assistant"}}]}',
      '',
      'data: {"choices":[{"delta":{"content":"Hel"}}]}',
      '',
      'data: {"choices":[{"delta":{"content":"lo \u2603"}}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\r\n');
    const provider = createKimiProvider({
      fetchImpl: fetchQueue([byteStreamResponse(sse)], []),
      getKey: () => 'k',
    });
    const deltas: string[] = [];
    const full = await provider.stream(userOnly, (d) => deltas.push(d));
    expect(full).toBe('Hello \u2603');
    expect(deltas).toEqual(['Hel', 'lo \u2603']);
  });

  it('honors Retry-After below the cap', async () => {
    const sleeps: number[] = [];
    const captured: CapturedRequest[] = [];
    const fetchImpl = fetchQueue(
      [
        jsonResponse(429, { error: 'slow down' }, { 'retry-after': '2' }),
        jsonResponse(200, { choices: [{ message: { content: 'ok' } }] }),
      ],
      captured,
    );
    const provider = createKimiProvider({
      fetchImpl,
      getKey: () => 'k',
      sleep: async (ms) => { sleeps.push(ms); },
      random: () => 0,
    });
    const out = await provider.complete(userOnly);
    expect(out).toBe('ok');
    expect(sleeps).toEqual([2000]);
    expect(captured).toHaveLength(2);
  });

  it('ignores Retry-After above the cap and uses bounded backoff', async () => {
    const sleeps: number[] = [];
    const fetchImpl = fetchQueue(
      [
        jsonResponse(429, { error: 'slow down' }, { 'retry-after': '9999' }),
        jsonResponse(200, { choices: [{ message: { content: 'ok' } }] }),
      ],
      [],
    );
    const provider = createKimiProvider({
      fetchImpl,
      getKey: () => 'k',
      sleep: async (ms) => { sleeps.push(ms); },
      random: () => 0,
    });
    await provider.complete(userOnly);
    expect(sleeps).toEqual([500]);
  });

  it('backs off exponentially on 5xx and gives up after 2 retries', async () => {
    const sleeps: number[] = [];
    const fetchImpl = fetchQueue(
      [
        jsonResponse(500, { error: 'boom' }),
        jsonResponse(502, { error: 'boom' }),
        jsonResponse(503, { error: 'boom' }),
      ],
      [],
    );
    const provider = createKimiProvider({
      fetchImpl,
      getKey: () => 'k',
      sleep: async (ms) => { sleeps.push(ms); },
      random: () => 0,
    });
    const err = await provider.complete(userOnly).then(
      () => null,
      (e: unknown) => e as ProviderError,
    );
    expect(err).toBeInstanceOf(ProviderError);
    expect(err!.status).toBe(503);
    expect(err!.message).toContain('status 503');
    expect(sleeps).toEqual([500, 1000]);
  });

  it('does not retry 4xx and truncates the error body at 300 chars', async () => {
    const captured: CapturedRequest[] = [];
    const fetchImpl = fetchQueue([new Response('x'.repeat(400), { status: 400 })], captured);
    const provider = createKimiProvider({ fetchImpl, getKey: () => 'k' });
    const err = await provider.complete(userOnly).then(
      () => null,
      (e: unknown) => e as ProviderError,
    );
    expect(err!.status).toBe(400);
    expect(err!.message).toContain('status 400');
    expect(err!.message).toContain('x'.repeat(300));
    expect(err!.message).not.toContain('x'.repeat(301));
    expect(captured).toHaveLength(1);
  });

  it('never leaks the API key in error messages', async () => {
    const key = 'sk-secret-123';
    const captured: CapturedRequest[] = [];
    const fetchImpl = fetchQueue(
      [new Response(`{"error":"invalid key ${key} provided"}`, { status: 401 })],
      captured,
    );
    const provider = createKimiProvider({ fetchImpl, getKey: () => key });
    const err = await provider.complete(userOnly).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(captured[0]!.headers.authorization).toBe(`Bearer ${key}`);
    expect(err!.message).not.toContain(key);
    expect(err!.message).toContain('***');
    expect(err!.message).toContain('status 401');
  });

  it('scrubs the key even from network-layer error messages', async () => {
    const key = 'sk-secret-xyz';
    const fetchImpl = () => Promise.reject(new Error(`authorization Bearer ${key} refused`));
    const provider = createKimiProvider({ fetchImpl, getKey: () => key, maxRetries: 0 });
    const err = await provider.complete(userOnly).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err!.message).not.toContain(key);
    expect(err!.message).toContain('network error');
  });

  it('times out honestly and retries the timeout', async () => {
    const sleeps: number[] = [];
    const hangingFetch = (_input: string | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('stopped', 'AbortError')));
      });
    const provider = createKimiProvider({
      fetchImpl: hangingFetch,
      getKey: () => 'k',
      timeoutMs: 20,
      maxRetries: 1,
      sleep: async (ms) => { sleeps.push(ms); },
      random: () => 0,
    });
    const err = await provider.complete(userOnly).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err!.message).toContain('timed out after 20ms');
    expect(sleeps).toEqual([500]);
  });

  it('fails honestly when no API key is configured', async () => {
    const provider = createKimiProvider({ getKey: () => null, fetchImpl: fetchQueue([], []) });
    await expect(provider.complete(userOnly)).rejects.toThrow(/no API key configured/i);
  });
});

describe('ollama provider', () => {
  const userOnly: ChatMessage[] = [{ role: 'user', content: 'x' }];

  it('posts to /api/chat with stream:false and parses the message', async () => {
    const captured: CapturedRequest[] = [];
    const fetchImpl = fetchQueue(
      [jsonResponse(200, { message: { role: 'assistant', content: 'local hi' }, done: true })],
      captured,
    );
    const provider = createOllamaProvider({ fetchImpl });
    const out = await provider.complete(userOnly);
    expect(out).toBe('local hi');
    const req = captured[0]!;
    expect(req.url).toBe('http://localhost:11434/api/chat');
    expect(req.headers.authorization).toBeUndefined();
    const body = req.body as { model: string; stream: boolean };
    expect(body.stream).toBe(false);
    expect(typeof body.model).toBe('string');
  });

  it('parses NDJSON streaming fed byte-wise', async () => {
    const ndjson = '{"message":{"content":"ab"},"done":false}\n'
      + '{"message":{"content":"cd \u2603"},"done":false}\n'
      + '{"message":{"content":""},"done":true}\n';
    const provider = createOllamaProvider({ fetchImpl: fetchQueue([byteStreamResponse(ndjson)], []) });
    const deltas: string[] = [];
    const full = await provider.stream(userOnly, (d) => deltas.push(d));
    expect(full).toBe('abcd \u2603');
    expect(deltas).toEqual(['ab', 'cd \u2603']);
  });

  it('surfaces ollama error payloads honestly', async () => {
    const fetchImpl = fetchQueue([jsonResponse(200, { error: 'model "nope" not found' })], []);
    const provider = createOllamaProvider({ fetchImpl });
    await expect(provider.complete(userOnly)).rejects.toThrow(/ollama error: model "nope" not found/);
  });

  it('retries 5xx like any other provider', async () => {
    const sleeps: number[] = [];
    const fetchImpl = fetchQueue(
      [jsonResponse(500, { error: 'boom' }), jsonResponse(200, { message: { content: 'ok' } })],
      [],
    );
    const provider = createOllamaProvider({
      fetchImpl,
      sleep: async (ms) => { sleeps.push(ms); },
      random: () => 0,
    });
    const out = await provider.complete(userOnly);
    expect(out).toBe('ok');
    expect(sleeps).toEqual([500]);
  });
});
