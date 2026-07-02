/**
 * Screen ownership state machine (P0-1).
 *
 * This is the ONLY code allowed to change which top-level screen is visible.
 * Every state maps to a guaranteed-non-empty screen div, so "black" has no
 * representation: there is no state whose renderer produces an empty screen,
 * and no public primitive that hides a screen without showing another.
 *
 * Design: docs/design/playback-state-machine.md
 */

export type ScreenState = 'boot' | 'pairing' | 'playing' | 'holding' | 'recovering';

export interface TransitionRecord {
  from: ScreenState;
  to: ScreenState;
  reason: string;
  at: number;
}

export interface ScreenGuards {
  /** PAIRING is only reachable when no device credentials exist. */
  canPair(): boolean;
  /** PLAYING requires a validated playlist with at least one item. */
  canPlay(): boolean;
}

const SCREEN_IDS = [
  'loading-screen',
  'pairing-screen',
  'content-screen',
  'holding-screen',
  'error-screen',
] as const;

const STATE_SCREEN: Record<ScreenState, (typeof SCREEN_IDS)[number]> = {
  boot: 'loading-screen',
  pairing: 'pairing-screen',
  playing: 'content-screen',
  holding: 'holding-screen',
  recovering: 'holding-screen',
};

const MAX_HISTORY = 50;

export class ScreenStateMachine {
  private current: ScreenState = 'boot';
  private history: TransitionRecord[] = [];

  constructor(
    private guards: ScreenGuards,
    private onTransition?: (rec: TransitionRecord) => void,
  ) {}

  get state(): ScreenState {
    return this.current;
  }

  get transitions(): readonly TransitionRecord[] {
    return this.history;
  }

  /**
   * Request a state change. Guarded transitions that fail are REFUSED (state
   * and screen unchanged) and reported — never silently performed.
   * Returns true if the machine is in `to` after the call.
   */
  transition(to: ScreenState, reason: string): boolean {
    if (to === this.current) {
      // Idempotent ensure — re-apply screen visibility in case DOM was rebuilt.
      this.applyScreens(to);
      return true;
    }

    if (to === 'pairing' && !this.guards.canPair()) {
      console.warn(`[ScreenState] REFUSED ${this.current} -> pairing (${reason}): credentials present`);
      return false;
    }
    if (to === 'playing' && !this.guards.canPlay()) {
      console.warn(`[ScreenState] REFUSED ${this.current} -> playing (${reason}): no renderable playlist`);
      return false;
    }

    const rec: TransitionRecord = { from: this.current, to, reason, at: Date.now() };
    this.current = to;
    this.history.push(rec);
    if (this.history.length > MAX_HISTORY) this.history.shift();

    console.log(`[ScreenState] ${rec.from} -> ${rec.to} (${reason})`);
    this.applyScreens(to);
    this.onTransition?.(rec);
    return true;
  }

  private applyScreens(state: ScreenState) {
    const active = STATE_SCREEN[state];
    for (const id of SCREEN_IDS) {
      const el = document.getElementById(id);
      if (el) el.classList.toggle('hidden', id !== active);
    }
  }
}
