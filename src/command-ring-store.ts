/**
 * A THIRD durable home for the command dedupe ring, in IndexedDB.
 *
 * Why a third one exists at all. The ring's whole job is to survive
 * window.location.reload() so a requeued `reload` cannot execute twice, and the
 * argument for it rested on having two independent homes: localStorage (synchronous,
 * bridge-free) and Capacitor Preferences (durable across a webview storage clear).
 * That independence is real on Android — Preferences there is native
 * SharedPreferences — and FALSE on Tizen/webOS, which is where the motivating failure
 * lives: @capacitor/preferences 6.0.4's web implementation is literally
 * `window.localStorage` under a `CapacitorStorage.` prefix
 * (dist/esm/web.js — `get impl() { return window.localStorage; }`). On those runtimes
 * both "homes" share one ~5MB budget, which `SecureStorageWeb` and `last_playlist`
 * also draw on, so a single QuotaExceededError removes the only terminator a replay
 * loop has — on exactly the platforms CLAUDE.md lists as shipped.
 *
 * IndexedDB has its own, far larger quota, so it is a genuinely independent store
 * rather than a second name for the first one. It is also already proven on these
 * exact runtimes: TvCacheManager caches all content through it on Tizen/webOS.
 *
 * It does NOT replace the synchronous localStorage write. That one lands before this
 * function can even yield, which is what makes it safe against a reload firing on the
 * next turn; IndexedDB is asynchronous and is only durable here because the caller
 * awaits it (bounded) before dispatching. The two cover different failure modes and
 * neither is redundant.
 *
 * Behind an interface for the same reason TvCacheStore is: it keeps the raw IDB
 * plumbing out of the tests, which drive an in-memory implementation instead.
 */

export interface CommandRingStore {
  /** The stored ring, or null when there is nothing (or nothing readable). */
  read(): Promise<string[] | null>;
  /** Persist the ring. REJECTS if it did not commit — the caller counts that. */
  write(keys: string[]): Promise<void>;
}

const DB_NAME = 'vizora-command-ring';
const DB_VERSION = 1;
const STORE = 'ring';
const RING_KEY = 'seen_command_keys';

/** Promisify an IDBRequest. */
function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/**
 * Resolve when the transaction COMMITS, not when the request succeeds. On
 * quota-constrained TV storage a write request can "succeed" and the transaction still
 * abort at commit — resolving early would report a durable record that does not exist,
 * which is the one lie this store must never tell.
 */
function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

class IndexedDbCommandRingStore implements CommandRingStore {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private openDb(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') {
          reject(new Error('IndexedDB unavailable'));
          return;
        }
        const open = indexedDB.open(DB_NAME, DB_VERSION);
        open.onupgradeneeded = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
        };
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
        open.onblocked = () => reject(new Error('IndexedDB open blocked'));
      });
      // A failed open must not poison every later call with the same rejected promise.
      this.dbPromise.catch(() => { this.dbPromise = null; });
    }
    return this.dbPromise;
  }

  async read(): Promise<string[] | null> {
    const db = await this.openDb();
    const store = db.transaction(STORE, 'readonly').objectStore(STORE);
    const value = await req<unknown>(store.get(RING_KEY));
    if (!Array.isArray(value)) return null;
    return value.filter((k): k is string => typeof k === 'string');
  }

  async write(keys: string[]): Promise<void> {
    const db = await this.openDb();
    const tx = db.transaction(STORE, 'readwrite');
    // Store a plain copy: a live array would be structured-cloned anyway, and this
    // keeps what lands on disk independent of any later mutation of the caller's ring.
    tx.objectStore(STORE).put([...keys], RING_KEY);
    await txDone(tx);
  }
}

export const CommandRing: CommandRingStore = new IndexedDbCommandRingStore();
