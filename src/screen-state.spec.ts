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

  it('C6b: once CREDENTIALS exist, pairing -> holding is ALLOWED', () => {
    // The guard's condition is "nothing to hold FOR", which means UNPAIRED — not
    // "the screen currently shows pairing". Keyed on the state alone it also refused a
    // device that had just paired: nothing in the poll-success path transitions the
    // screen, so the machine is still in `pairing` when the connect handler holds for
    // content that has not been assigned yet. That stranded a paired, heartbeating
    // device on a dead pairing code, with re-pairing refused too because canPair() had
    // gone false.
    //
    // canPair() is exactly the discriminator: false here (credentials present) means
    // the refusal must NOT fire. C6 above covers the other half, where it must.
    // Credentials have to ARRIVE mid-sequence, which is the real thing being modelled:
    // the device enters pairing while unpaired (canPair true, or the hop is refused),
    // the poll succeeds and writes deviceToken/deviceId, and only then does the connect
    // handler ask to hold. A fixed-guard machine cannot express that ordering.
    const seen: TransitionRecord[] = [];
    let unpaired = true;
    const m = new ScreenStateMachine(
      { canPair: () => unpaired, canPlay: () => false },
      rec => seen.push(rec),
    );
    m.transition('pairing', 'pairing_requested');
    seen.length = 0;
    unpaired = false; // ← the pairing poll succeeded; credentials now exist

    expect(m.transition('holding', 'paired_no_playlist')).toBe(true);

    expect(m.state).toBe('holding');
    expect(visible()).toEqual(['holding-screen']);
    expect(seen.map(r => `${r.from}->${r.to}`)).toEqual(['pairing->holding']);
  });

  it('C6c: RECOVERING is the same door as HOLDING and is guarded the same way', () => {
    // `recovering` and `holding` render the SAME div (STATE_SCREEN above), so guarding
    // only one leaves the other able to replace a live pairing code with "Starting up
    // — retrying…". startInit's catch transitions to `recovering` on every failed init
    // attempt, so this is a real door, not a theoretical one.
    let unpaired = true;
    const m = new ScreenStateMachine({ canPair: () => unpaired, canPlay: () => false });
    m.transition('pairing', 'pairing_requested');

    // Unpaired: nothing to recover FOR, the pairing code keeps the screen.
    expect(m.transition('recovering', 'init_failure')).toBe(false);
    expect(m.state).toBe('pairing');
    expect(visible()).toEqual(['pairing-screen']);

    // Paired: the same transition is allowed, exactly as for holding.
    unpaired = false;
    expect(m.transition('recovering', 'init_failure')).toBe(true);
    expect(m.state).toBe('recovering');
    expect(visible()).toEqual(['holding-screen']);
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
