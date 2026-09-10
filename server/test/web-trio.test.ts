import { describe, expect, it } from 'vitest';
import type { ActivityEvent } from '../../web/src/types.js';
import { resolveEnhancement } from '../../web/src/components/ChatComposer.js';
import { PROGRAM_SCROLL_FALLBACK_MS, resolveScrollStuck } from '../../web/src/components/ChatColumn.js';
import { roleDisplay } from '../../web/src/components/AgentTimeline.js';

const ev = (state: ActivityEvent['state'], note?: string): ActivityEvent => ({
  role: 'builder',
  state,
  ...(note !== undefined ? { note } : {}),
});

describe('ChatComposer.resolveEnhancement', () => {
  it('applies the enhanced text when the draft is untouched', () => {
    expect(resolveEnhancement('a rough brief', 'a rough brief', 'A polished brief')).toEqual({
      kind: 'applied',
      text: 'A polished brief',
    });
  });

  it('discards the enhanced text when the draft changed while the request was in flight', () => {
    // Regression: the late result used to clobber the user's concurrent typing.
    expect(resolveEnhancement('a rough brief', 'a rough brief, typed on', 'A polished brief')).toEqual({
      kind: 'discarded',
    });
  });

  it('treats even a whitespace-only edit as a change', () => {
    expect(resolveEnhancement('brief', 'brief ', 'polished').kind).toBe('discarded');
  });
});

describe('ChatColumn.resolveScrollStuck', () => {
  it('ignores intermediate frames of a programmatic smooth-scroll', () => {
    // Regression: these frames used to set stuck=false, so messages arriving
    // mid-animation incremented unread and the thread never scrolled again.
    expect(resolveScrollStuck({ atBottom: false, programmatic: true, gesture: false })).toEqual({
      stuck: null,
      release: false,
    });
  });

  it('releases the programmatic flag without touching stuck once the animation lands', () => {
    expect(resolveScrollStuck({ atBottom: true, programmatic: true, gesture: false })).toEqual({
      stuck: null,
      release: true,
    });
  });

  it('lets a user gesture take over mid-animation and unstick', () => {
    expect(resolveScrollStuck({ atBottom: false, programmatic: true, gesture: true })).toEqual({
      stuck: false,
      release: true,
    });
  });

  it('tracks scrolls normally when no programmatic scroll is in flight', () => {
    expect(resolveScrollStuck({ atBottom: false, programmatic: false, gesture: true })).toEqual({
      stuck: false,
      release: false,
    });
    expect(resolveScrollStuck({ atBottom: true, programmatic: false, gesture: false })).toEqual({
      stuck: true,
      release: false,
    });
  });

  it('caps the programmatic flag with a 600ms fallback', () => {
    expect(PROGRAM_SCROLL_FALLBACK_MS).toBe(600);
  });
});

describe('AgentTimeline.roleDisplay', () => {
  it('demotes a stale active role to error when the build is CANCELLED', () => {
    // Regression: a cancelled build left the mid-flight role spinning forever.
    expect(roleDisplay('builder', { builder: ev('active', 'writing styles.css') }, 'CANCELLED')).toEqual({
      state: 'error',
      note: 'writing styles.css',
    });
  });

  it('demotes a stale active role to error when the build is ERROR', () => {
    expect(roleDisplay('builder', { builder: ev('active') }, 'ERROR')).toEqual({ state: 'error' });
  });

  it('keeps done and error events authoritative at terminal phases', () => {
    expect(roleDisplay('builder', { builder: ev('done') }, 'CANCELLED').state).toBe('done');
    expect(roleDisplay('builder', { builder: ev('error') }, 'CANCELLED').state).toBe('error');
  });

  it('keeps a genuinely active role spinning mid-build', () => {
    expect(roleDisplay('builder', { builder: ev('active') }, 'BUILDING')).toEqual({ state: 'active' });
  });

  it('keeps the DONE special-casing: event states pass through untouched', () => {
    expect(roleDisplay('builder', { builder: ev('active') }, 'DONE').state).toBe('active');
    expect(roleDisplay('reviewer', {}, 'DONE').state).toBe('done');
  });

  it('still maps idle to queued and event-less roles at terminal phases to skipped', () => {
    expect(roleDisplay('builder', { builder: ev('idle') }, 'CANCELLED').state).toBe('queued');
    expect(roleDisplay('reviewer', { builder: ev('done') }, 'CANCELLED').state).toBe('skipped');
    expect(roleDisplay('reviewer', {}, 'CANCELLED').state).toBe('skipped');
  });
});
