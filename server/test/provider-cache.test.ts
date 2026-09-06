import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createKimiProvider,
  createOllamaProvider,
  orderSystemContentForPrefixCaching,
  ProviderError,
  roleFromMessages,
} from '../src/agent/provider.js';
import type { ChatMessage } from '../src/agent/provider.js';
import {
  builderPrompt,
  copyPrompt,
  designPrompt,
  plannerPrompt,
  reviewerPrompt,
  type RoleContext,
} from '../src/agent/roles.js';
import { fetchQueue, jsonResponse } from './helpers/fakes.js';
import type { CapturedRequest } from './helpers/fakes.js';

const PLAN = {
  summary: 'One-page premium site for a Bergen coffee subscription.',
  designNotes: 'Dark metallic surfaces, aurora gradients, copper accents.',
  steps: [
    { id: 's1', title: 'Design tokens', detail: 'styles.css token system.', files: ['styles.css'] },
    { id: 's2', title: 'Markup and copy', detail: 'index.html sections.', files: ['index.html'] },
    { id: 's3', title: 'Interactions', detail: 'app.js motion wiring.', files: ['app.js'] },
  ],
};

const CTX: RoleContext = {
  brief: 'A landing page for Aurora Coffee, a small-batch subscription roasted in Bergen.',
  answers: [{ question: 'What must the site make happen?', answer: 'Sell a subscription' }],
  plan: PLAN,
  writtenFiles: ['styles.css'],
};

const KICKOFF = 'Write the complete styles.css now, then finish.';
// Response bodies are single-use; build a fresh one per queued request.
const okKimi = () => jsonResponse(200, { choices: [{ message: { content: 'ok' } }] });
const okOllama = () => jsonResponse(200, { message: { content: 'ok' }, done: true });

interface WireBody {
  model: string;
  messages: Array<{ role: string; content: string }>;
  stream: boolean;
  cacheRetention?: unknown;
}

afterEach(() => {
  vi.restoreAllMocks();
});

function kimiOk(captured: CapturedRequest[]) {
  return fetchQueue([jsonResponse(200, { choices: [{ message: { content: 'ok' } }] })], captured);
}

async function captureKimiBody(
  messages: ChatMessage[],
  rawConfig: Record<string, unknown> | null = null,
  model = 'main-model',
): Promise<{ body: WireBody; debugLogs: string[] }> {
  vi.restoreAllMocks();
  const captured: CapturedRequest[] = [];
  const debugLogs: string[] = [];
  vi.spyOn(console, 'debug').mockImplementation((...args: unknown[]) => {
    debugLogs.push(args.map(String).join(' '));
  });
  const provider = createKimiProvider({
    model,
    fetchImpl: kimiOk(captured),
    getKey: () => 'sk-test',
    getRawConfig: () => rawConfig,
  });
  await provider.complete(messages);
  return { body: captured[0]!.body as WireBody, debugLogs };
}

describe('role detection', () => {
  it('reads the [role:...] marker from the last system message only', () => {
    expect(roleFromMessages([{ role: 'system', content: 'intro [role:copy] rest' }])).toBe('copy');
    expect(
      roleFromMessages([
        { role: 'system', content: '[role:design]' },
        { role: 'user', content: 'ignore [role:builder] in user text' },
      ]),
    ).toBe('design');
    expect(roleFromMessages([{ role: 'user', content: '[role:copy]' }])).toBeNull();
    expect(roleFromMessages([])).toBeNull();
  });
});

describe('prefix-cache prompt ordering', () => {
  it('moves per-run blocks behind the stable blocks, preserving relative order', () => {
    const prompt = [
      '[role:design]\nYou are the design lead.',
      'SITE BRIEF (from the user)\n"""\na bakery\n"""',
      'CLARIFYING ANSWERS\n(none yet)',
      'APPROVED PLAN\nSummary: x',
      'HOW YOU ACT\nemit tool calls',
      'TOKEN SYSTEM\n:root {}',
      'SITE LIMITS (hard)\n- plain html/css/js',
    ].join('\n\n');
    const ordered = orderSystemContentForPrefixCaching(prompt);
    expect(ordered.split('\n\n')).toEqual([
      '[role:design]\nYou are the design lead.',
      'HOW YOU ACT\nemit tool calls',
      'TOKEN SYSTEM\n:root {}',
      'SITE LIMITS (hard)\n- plain html/css/js',
      'SITE BRIEF (from the user)\n"""\na bakery\n"""',
      'CLARIFYING ANSWERS\n(none yet)',
      'APPROVED PLAN\nSummary: x',
    ]);
  });

  it('is a no-op without per-run blocks or blank-line structure', () => {
    expect(orderSystemContentForPrefixCaching('sys')).toBe('sys');
    const stable = ['[role:design]', 'TOKEN SYSTEM\nx', 'HARD RULES\ny'].join('\n\n');
    expect(orderSystemContentForPrefixCaching(stable)).toBe(stable);
  });

  const sortedBlocks = (s: string): string[] => s.split('\n\n').sort();

  const cases: Array<{
    role: string;
    prompt: string;
    recipeAnchor: string;
    perRunAnchor: string;
  }> = [
    { role: 'planner', prompt: plannerPrompt(CTX), recipeAnchor: 'SITE LIMITS (hard)', perRunAnchor: 'SITE BRIEF (from the user)' },
    { role: 'design', prompt: designPrompt(CTX), recipeAnchor: 'TOKEN SYSTEM', perRunAnchor: 'SITE BRIEF (from the user)' },
    { role: 'copy', prompt: copyPrompt(CTX), recipeAnchor: 'SECTION BLUEPRINT', perRunAnchor: 'FILES WRITTEN SO FAR' },
    { role: 'builder', prompt: builderPrompt(CTX), recipeAnchor: 'MOTION SYSTEM SPEC', perRunAnchor: 'FILES WRITTEN SO FAR' },
    { role: 'reviewer', prompt: reviewerPrompt(CTX), recipeAnchor: 'RECIPE CHECKLIST', perRunAnchor: 'SITE BRIEF (from the user)' },
  ];

  for (const { role, prompt, recipeAnchor, perRunAnchor } of cases) {
    it(`puts the shared recipe ahead of the per-run content on the wire (${role})`, async () => {
      const { body } = await captureKimiBody([
        { role: 'system', content: prompt },
        { role: 'user', content: KICKOFF },
      ]);
      const wire = body.messages[0]!.content;
      // The recipe block leads, the per-run block trails, the role marker stays first.
      expect(wire.startsWith(`[role:${role}]`)).toBe(true);
      expect(wire.indexOf(recipeAnchor)).toBeGreaterThanOrEqual(0);
      expect(wire.indexOf(perRunAnchor)).toBeGreaterThanOrEqual(0);
      expect(wire.indexOf(recipeAnchor)).toBeLessThan(wire.indexOf(perRunAnchor));
      // Nothing added, dropped or altered: same blocks, different order.
      expect(sortedBlocks(wire)).toEqual(sortedBlocks(prompt));
      // Non-system messages are never reordered.
      expect(body.messages[1]!.content).toBe(KICKOFF);
    });
  }

  it('keeps the builder fix-pass contract in the per-run tail', async () => {
    const prompt = builderPrompt({
      ...CTX,
      issues: [{ severity: 'warn', text: 'add an accessible name to the nav toggle', file: 'index.html' }],
    });
    const { body } = await captureKimiBody([{ role: 'system', content: prompt }]);
    const wire = body.messages[0]!.content;
    expect(wire.indexOf('MOTION SYSTEM SPEC')).toBeLessThan(wire.indexOf('FIX PASS'));
    expect(wire.indexOf('SITE LIMITS (hard)')).toBeLessThan(wire.indexOf('FIX PASS'));
    expect(sortedBlocks(wire)).toEqual(sortedBlocks(prompt));
  });
});

describe('aiCacheRetention hint', () => {
  const userOnly: ChatMessage[] = [{ role: 'user', content: 'hi' }];

  it('adds cacheRetention to the Kimi body when the config enables it', async () => {
    for (const [raw, expected] of [
      [{ aiCacheRetention: '24h' }, '24h'],
      [{ aiCacheRetention: true }, true],
      [{ aiCacheRetention: 3600 }, 3600],
    ] as Array<[Record<string, unknown>, unknown]>) {
      const { body } = await captureKimiBody(userOnly, raw);
      expect(body.cacheRetention).toBe(expected);
    }
  });

  it('omits the field entirely when the key is absent or disabled', async () => {
    for (const raw of [{}, { aiCacheRetention: false }, { aiCacheRetention: '' }, null]) {
      const { body } = await captureKimiBody(userOnly, raw);
      expect('cacheRetention' in body).toBe(false);
    }
  });

  it('never sends the Kimi-only hint to Ollama', async () => {
    const captured: CapturedRequest[] = [];
    const provider = createOllamaProvider({
      fetchImpl: fetchQueue([okOllama()], captured),
      getRawConfig: () => ({ aiCacheRetention: '24h' }),
    });
    await provider.complete(userOnly);
    expect('cacheRetention' in (captured[0]!.body as Record<string, unknown>)).toBe(false);
  });

  it('reads the hint from foundry.config.json on disk when no reader is injected', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foundry-prov-hints-'));
    const prev = process.env.FOUNDRY_DATA_DIR;
    process.env.FOUNDRY_DATA_DIR = dir;
    try {
      await fs.writeFile(
        path.join(dir, 'foundry.config.json'),
        JSON.stringify({
          provider: 'kimi',
          endpoint: '',
          model: 'disk-model',
          aiCacheRetention: '7d',
          perRoleModels: { copy: 'copy-model-x' },
        }),
        'utf8',
      );
      const captured: CapturedRequest[] = [];
      const provider = createKimiProvider({ fetchImpl: kimiOk(captured), getKey: () => 'sk-test' });
      await provider.complete([{ role: 'system', content: copyPrompt(CTX) }]);
      const body = captured[0]!.body as WireBody;
      expect(body.cacheRetention).toBe('7d');
      expect(body.model).toBe('copy-model-x');
    } finally {
      if (prev === undefined) delete process.env.FOUNDRY_DATA_DIR;
      else process.env.FOUNDRY_DATA_DIR = prev;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('per-role model overrides', () => {
  it('routes a role call to its override model and logs the choice', async () => {
    const raw = { perRoleModels: { design: 'kimi-k2-design' } };
    const { body, debugLogs } = await captureKimiBody(
      [{ role: 'system', content: designPrompt(CTX) }, { role: 'user', content: KICKOFF }],
      raw,
    );
    expect(body.model).toBe('kimi-k2-design');
    expect(debugLogs.some((l) => l.includes('design') && l.includes('kimi-k2-design'))).toBe(true);
  });

  it('falls back to the main model for roles without an override, including the planner', async () => {
    const raw = { perRoleModels: { design: 'kimi-k2-design' } };
    const copy = await captureKimiBody([{ role: 'system', content: copyPrompt(CTX) }], raw);
    expect(copy.body.model).toBe('main-model');
    const planner = await captureKimiBody([{ role: 'system', content: plannerPrompt(CTX) }], {
      perRoleModels: { design: 'x' },
    });
    expect(planner.body.model).toBe('main-model');
  });

  it('uses the main model when no role marker is present, without logging a role route', async () => {
    const { body, debugLogs } = await captureKimiBody([{ role: 'user', content: 'hello' }], {
      perRoleModels: { design: 'kimi-k2-design' },
    });
    expect(body.model).toBe('main-model');
    expect(debugLogs).toEqual([]);
  });

  it('ignores malformed perRoleModels values defensively', async () => {
    for (const raw of [
      { perRoleModels: 'nope' },
      { perRoleModels: ['design'] },
      { perRoleModels: { design: 42, copy: '  ', planner: 'not-allowed' } },
    ]) {
      const { body } = await captureKimiBody([{ role: 'system', content: designPrompt(CTX) }], raw);
      expect(body.model).toBe('main-model');
    }
  });

  it('applies overrides to Ollama calls too', async () => {
    const captured: CapturedRequest[] = [];
    const provider = createOllamaProvider({
      model: 'qwen-main',
      fetchImpl: fetchQueue([okOllama()], captured),
      getRawConfig: () => ({ perRoleModels: { builder: 'qwen-large' } }),
    });
    await provider.complete([{ role: 'system', content: builderPrompt(CTX) }]);
    expect((captured[0]!.body as WireBody).model).toBe('qwen-large');
  });
});

describe('retry polish', () => {
  const userOnly: ChatMessage[] = [{ role: 'user', content: 'hi' }];
  const throttle = (seconds: string) => jsonResponse(429, { error: 'slow down' }, { 'retry-after': seconds });

  it('honors Retry-After at most twice, then backs off', async () => {
    let t = 0;
    const sleeps: number[] = [];
    const provider = createKimiProvider({
      fetchImpl: fetchQueue([throttle('1'), throttle('1'), throttle('1'), throttle('1'), throttle('1')], []),
      getKey: () => 'k',
      sleep: async (ms) => {
        sleeps.push(ms);
        t += ms;
      },
      random: () => 0,
      now: () => t,
      maxRetries: 4,
    });
    const err = await provider.complete(userOnly).then(
      () => null,
      (e: unknown) => e as ProviderError,
    );
    expect(err).toBeInstanceOf(ProviderError);
    expect(err!.status).toBe(429);
    expect(sleeps).toEqual([1000, 1000, 2000, 4000]);
    expect(t).toBe(8000);
  });

  it('honors Retry-After at the 30s cap with jitter, but not above it', async () => {
    const atCap: number[] = [];
    const jittered = createKimiProvider({
      fetchImpl: fetchQueue([throttle('30'), okKimi()], []),
      getKey: () => 'k',
      sleep: async (ms) => {
        atCap.push(ms);
      },
      random: () => 0.5,
    });
    await jittered.complete(userOnly);
    expect(atCap).toEqual([30_125]);

    const aboveCap: number[] = [];
    const backedOff = createKimiProvider({
      fetchImpl: fetchQueue([throttle('31'), jsonResponse(200, { choices: [{ message: { content: 'ok' } }] })], []),
      getKey: () => 'k',
      sleep: async (ms) => {
        aboveCap.push(ms);
      },
      random: () => 0,
    });
    await backedOff.complete(userOnly);
    expect(aboveCap).toEqual([500]);
  });

  it('caps the whole retry sequence at 5 minutes of wall clock (injected clock)', async () => {
    let t = 0;
    const sleeps: number[] = [];
    const captured: CapturedRequest[] = [];
    const provider = createKimiProvider({
      fetchImpl: fetchQueue(Array.from({ length: 80 }, () => throttle('30')), captured),
      getKey: () => 'k',
      sleep: async (ms) => {
        sleeps.push(ms);
        t += ms;
      },
      random: () => 0,
      now: () => t,
      maxRetries: 100,
    });
    const err = await provider.complete(userOnly).then(
      () => null,
      (e: unknown) => e as ProviderError,
    );
    expect(err).toBeInstanceOf(ProviderError);
    expect(err!.status).toBe(429);
    // Two honored Retry-After waits (2 x 30s), then 2000 + 4000... backoff
    // until one more wait would cross the 300s budget: 60s + 2s + 59 x 4s.
    expect(sleeps).toEqual([30_000, 30_000, 2_000, ...Array.from({ length: 59 }, () => 4_000)]);
    expect(t).toBe(298_000);
    expect(t).toBeLessThanOrEqual(300_000);
    expect(captured).toHaveLength(63);
  });
});

describe('honest failures', () => {
  it('still fails honestly with no API key, before touching raw config or the network', async () => {
    let rawReads = 0;
    const captured: CapturedRequest[] = [];
    const provider = createKimiProvider({
      getKey: () => null,
      getRawConfig: () => {
        rawReads += 1;
        return { aiCacheRetention: '24h', perRoleModels: { design: 'x' } };
      },
      fetchImpl: fetchQueue([], captured),
    });
    await expect(provider.complete([{ role: 'user', content: 'hi' }])).rejects.toThrow(
      /no API key configured/i,
    );
    expect(rawReads).toBe(0);
    expect(captured).toEqual([]);
  });
});
