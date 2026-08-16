/**
 * The artifact assertions in vite.config.ts, driven directly.
 *
 * Why this file exists: the instrument lives in a `writeBundle` hook, and the
 * provenance tests call the config factory only — so the hook had never run in any
 * test and its ORDINARY SUCCESS PATH had never been traced. It was authored entirely
 * while staring at a no-DSN regression, which is how it shipped with a budget that
 * would have failed the first DSN-configured build: the SDK it exists to detect is
 * ~90 kB, and the budget did not account for the build that is SUPPOSED to carry it.
 * Same bias as the guards, migrated into the build lane.
 *
 * LAYER, stated deliberately. What is checked here is the instrument's DECISION —
 * budget arithmetic, the DSN gate, and the token scan — which is where that logic
 * lives. What is NOT checked here is whether a real artifact comes in under budget;
 * that property lives in the artifact, and the only honest way to check it is to build
 * one, which `npm run build` and `npm run build:tv` do in CI. Splitting it this way is
 * the point: driving a real build from inside vitest was tried and the child process's
 * output capture, not the build, decided the result — a collection mistake that looks
 * exactly like the defect these tests exist to catch.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { Plugin } from 'vite';

type WriteBundleHook = (options: unknown, bundle: Record<string, { code?: string }>) => void;

/**
 * The artifact-assertions plugin, as the real build constructs it.
 *
 * Driven in a NON-RELEASE mode on purpose: release modes fail closed against
 * release-origins.json, so `production` here would test the origin pin rather than the
 * budget. The plugin is registered for every mode and its logic does not vary by one,
 * apart from the TV size baseline.
 */
async function artifactPlugin(mode: string, dsn: string | undefined): Promise<WriteBundleHook> {
  vi.resetModules();
  if (dsn === undefined) delete process.env.VITE_SENTRY_DSN;
  else process.env.VITE_SENTRY_DSN = dsn;

  const configModule = await import('../vite.config');
  const factory = configModule.default as unknown as (env: { mode: string; command: string }) => {
    plugins: Plugin[];
  };
  const resolved = factory({ mode, command: 'build' });
  const plugin = resolved.plugins.flat().find(p => p && p.name === 'vizora-artifact-assertions');
  if (!plugin) throw new Error('artifact-assertions plugin not registered for mode ' + mode);
  return (plugin.writeBundle as unknown as WriteBundleHook).bind(plugin);
}

/** A synthetic emitted bundle of `bytes` JS, optionally carrying the SDK's tokens. */
function bundleOf(bytes: number, withSdk = false): Record<string, { code: string }> {
  const marker = withSdk ? 'sentry_key=abc;sentry_client=x;' : '';
  return { 'assets/index-test.js': { code: marker + 'x'.repeat(Math.max(0, bytes - marker.length)) } };
}

describe('artifact assertions — the instrument decides correctly', () => {
  afterEach(() => { delete process.env.VITE_SENTRY_DSN; });

  it('a DSN-CONFIGURED build is allowed to carry the SDK', async () => {
    // THE bug this file was added for. Ungated, the budget failed here by ~90 kB: the
    // first person to supply a DSN — the exact remediation the build's own [sentry]
    // WARNING instructs — got a failing build telling them to find what grew.
    const write = await artifactPlugin('development', 'https://abc123@o1.ingest.sentry.io/42');

    // A no-DSN build measures ~148 kB; the SDK adds ~90 kB. This is that build.
    expect(() => write({}, bundleOf(238_000, true))).not.toThrow();
  });

  it('a NO-DSN build is under budget and carries no SDK', async () => {
    const write = await artifactPlugin('development', undefined);

    expect(() => write({}, bundleOf(148_000))).not.toThrow();
  });

  it('the SDK in a NO-DSN build is refused', async () => {
    // The regression the instrument was built for: a transform on the env read defeats
    // Vite's static replacement and the whole SDK lands in a build that cannot use it.
    const write = await artifactPlugin('development', undefined);

    expect(() => write({}, bundleOf(238_000, true))).toThrow(/@sentry is present/);
  });

  it('an oversized build is refused even with a DSN', async () => {
    // The gate widens the budget; it does not remove it.
    const write = await artifactPlugin('development', 'https://abc123@o1.ingest.sentry.io/42');

    expect(() => write({}, bundleOf(400_000, true))).toThrow(/over the/);
  });

  it('NEGATIVE CONTROL: our own log strings mentioning SENTRY do not trip the token scan', async () => {
    // The first version of this check was /sentry/i and flagged every healthy build,
    // because src/ logs "[Vizora] Crash reporting disabled (no VITE_SENTRY_DSN)". The
    // scan keys on SDK internals instead; this pins that it still does.
    const write = await artifactPlugin('development', undefined);
    const ownStrings = { 'assets/index-test.js': { code: 'console.log("no VITE_SENTRY_DSN");' } };

    expect(() => write({}, ownStrings)).not.toThrow();
  });
});
