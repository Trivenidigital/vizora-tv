/**
 * Unit tests for the ScreenStateMachine (src/screen-state.ts) — guard
 * enforcement, refusal semantics, and screen visibility application.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ScreenStateMachine, type TransitionRecord } from './screen-state';

interface ScreenStub {
  id: string;
  hidden: boolean;
  classList: { toggle: (cls: string, force: boolean) => void };
}

let screens: Map<string, ScreenStub>;

function makeScreen(id: string): ScreenStub {
  const stub: ScreenStub = {
    id,
    hidden: false,
    classList: {
      toggle: (cls: string, force: boolean) => {
        if (cls === 'hidden') stub.hidden = force;
      },
    },
  };
  return stub;
}

function visible(): string[] {
  return [...screens.values()].filter(s => !s.hidden).map(s => s.id);
}

describe('ScreenStateMachine', () => {
  beforeEach(() => {
    screens = new Map(
      ['loading-screen', 'pairing-screen', 'content-screen', 'holding-screen', 'error-screen']
        .map(id => [id, makeScreen(id)]),
    );
    vi.stubGlobal('document', {
      getElementById: (id: string) => screens.get(id) ?? null,
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const guards = (canPair: boolean, canPlay: boolean) => ({
    canPair: () => canPair,
    canPlay: () => canPlay,
  });

  it('starts in boot', () => {
    const m = new ScreenStateMachine(guards(true, true));
    expect(m.state).toBe('boot');
  });

  it('transition applies visibility: exactly the target screen is shown', () => {
    const m = new ScreenStateMachine(guards(true, true));
    m.transition('holding', 'test');
    expect(visible()).toEqual(['holding-screen']);
    m.transition('playing', 'test');
    expect(visible()).toEqual(['content-screen']);
  });

  it('recovering renders on the holding screen', () => {
    const m = new ScreenStateMachine(guards(true, true));
    m.transition('recovering', 'test');
    expect(m.state).toBe('recovering');
    expect(visible()).toEqual(['holding-screen']);
  });

  it('REFUSES pairing while credentials exist — state and screens unchanged', () => {
    const m = new ScreenStateMachine(guards(false, true));
    m.transition('playing', 'setup');
    const ok = m.transition('pairing', 'attack');
    expect(ok).toBe(false);
    expect(m.state).toBe('playing');
    expect(visible()).toEqual(['content-screen']);
  });

  it('REFUSES playing without a renderable playlist', () => {
    const m = new ScreenStateMachine(guards(true, false));
    const ok = m.transition('playing', 'no-content');
    expect(ok).toBe(false);
    expect(m.state).toBe('boot');
  });

  it('holding is always reachable (universal fallback)', () => {
    const m = new ScreenStateMachine(guards(false, false));
    expect(m.transition('holding', 'fallback')).toBe(true);
    expect(m.state).toBe('holding');
  });

  it('same-state transition is an idempotent ensure and returns true', () => {
    const m = new ScreenStateMachine(guards(true, true));
    m.transition('holding', 'first');
    // Simulate external DOM damage, then re-ensure
    screens.get('holding-screen')!.hidden = true;
    expect(m.transition('holding', 'ensure')).toBe(true);
    expect(visible()).toEqual(['holding-screen']);
  });

  it('records transitions and notifies the observer', () => {
    const seen: TransitionRecord[] = [];
    const m = new ScreenStateMachine(guards(true, true), rec => seen.push(rec));
    m.transition('pairing', 'r1');
    m.transition('holding', 'r2');
    expect(seen.map(r => `${r.from}>${r.to}:${r.reason}`)).toEqual([
      'boot>pairing:r1',
      'pairing>holding:r2',
    ]);
    expect(m.transitions.length).toBe(2);
  });

  it('refused transitions are not recorded and do not notify', () => {
    const seen: TransitionRecord[] = [];
    const m = new ScreenStateMachine(guards(false, true), rec => seen.push(rec));
    m.transition('pairing', 'refused');
    expect(seen.length).toBe(0);
    expect(m.transitions.length).toBe(0);
  });
});
