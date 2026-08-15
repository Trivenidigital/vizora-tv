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
    // Uses boot→holding→playing rather than boot→pairing→holding: the pair chosen
    // here is incidental to what this test asserts (that transitions are recorded and
    // observed), and pairing→holding is now a REFUSED transition — see the guard test
    // below. No assertion is weakened; a two-hop unguarded path is still exercised.
    const m = new ScreenStateMachine(guards(true, true), rec => seen.push(rec));
    m.transition('holding', 'r1');
    m.transition('playing', 'r2');
    expect(seen.map(r => `${r.from}>${r.to}:${r.reason}`)).toEqual([
      'boot>holding:r1',
      'holding>playing:r2',
    ]);
    expect(m.transitions.length).toBe(2);
  });

  // -------- C6: HOLDING must not be able to replace a live pairing code --------

  it('C6: REFUSES pairing -> holding — a pairing code is not replaced by "Waiting for content…"', () => {
    // A stale advance() continuation resuming after a revocation has already called
    // startPairing() fires enterHolding('no_playlist'). Unguarded, that swapped a live
    // pairing code for the holding screen for up to the five minutes until the code
    // expired — on a device an installer is standing in front of.
    const seen: TransitionRecord[] = [];
    const m = new ScreenStateMachine(guards(true, true), rec => seen.push(rec));
    m.transition('pairing', 'pairing_requested');
    seen.length = 0;

    expect(m.transition('holding', 'no_playlist')).toBe(false);

    expect(m.state).toBe('pairing');
    expect(visible()).toEqual(['pairing-screen']);
    expect(seen).toEqual([]);          // refused transitions are not recorded
    expect(m.transitions.length).toBe(1); // …only the pairing hop
  });

  it('C6 NEGATIVE CONTROL: holding is still reachable from every other state', () => {
    // Same layer. Proves the guard is scoped to the pairing screen and did not turn
    // the never-black terminal into an unreachable state.
    for (const from of ['boot', 'playing', 'recovering'] as const) {
      screens = new Map(
        ['loading-screen', 'pairing-screen', 'content-screen', 'holding-screen', 'error-screen']
          .map(id => [id, makeScreen(id)]),
      );
      const m = new ScreenStateMachine(guards(true, true));
      if (from !== 'boot') expect(m.transition(from, 'setup')).toBe(true);
      expect(m.transition('holding', 'no_playlist')).toBe(true);
      expect(m.state).toBe('holding');
      expect(visible()).toEqual(['holding-screen']);
    }
  });

  it('refused transitions are not recorded and do not notify', () => {
    const seen: TransitionRecord[] = [];
    const m = new ScreenStateMachine(guards(false, true), rec => seen.push(rec));
    m.transition('pairing', 'refused');
    expect(seen.length).toBe(0);
    expect(m.transitions.length).toBe(0);
  });
});
