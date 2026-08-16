/**
 * Unit tests for build provenance (src/build-provenance.ts) — the two things a
 * shipped artifact asserts about itself that nothing else can correct later: which
 * version every device reports on its heartbeat, and whether crash reporting is live.
 *
 * Both are read back OUT of the built artifact by the publish-side verifier, so a
 * wrong value here does not fail a gate — it passes one. That is why the version test
 * asserts against a DIFFERENT `process.env.npm_package_version` rather than just
 * "some non-empty string": the bug this file exists to pin down produced a perfectly
 * well-formed version ("1.0.0"), and every assertion of the shape "reports a non-zero
 * appVersion" passed on it.
 *
 * The last describe block calls the REAL vite.config.ts factory, so the assertions are
 * bound to the construction site that actually produces the bundle's `define` block —
 * not only to the extracted helpers it delegates to.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  DEV_VERSION_FALLBACK,
  RELEASE_ORIGINS,
  isReleaseMode,
  isSentryConfigured,
  releaseSentryWarning,
  resolveAppVersion,
  resolveReleaseOrigins,
  resolveSentryDsn,
} from './build-provenance';

/** A value nothing correct may ever return — the shape of the bug, not just a decoy. */
const NPM_ENV_DECOY = '9.9.9-from-npm-env';

let workDir: string;

/** Writes a real package.json into a real directory: no fs stubbing anywhere here. */
function withPackageJson(contents: string): string {
  const dir = mkdtempSync(join(workDir, 'pkg-'));
  writeFileSync(join(dir, 'package.json'), contents, 'utf8');
  return dir;
}

/** A directory that exists but holds no package.json at all. */
function withoutPackageJson(): string {
  const dir = join(workDir, `empty-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir);
  return dir;
}

/**
 * A pin deliberately unlike BOTH the repo's real release-origins.json and the
 * non-release fallbacks in vite.config.ts, so "resolved from the pin" cannot be
 * confused with "resolved from whatever was lying around".
 */
const VALID_PIN = {
  api: 'https://api.pinned.example',
  realtime: 'wss://realtime.pinned.example',
  dashboard: 'https://dashboard.pinned.example',
} as const;

/** Writes a real release-origins.json into a real directory. */
function withPin(contents: unknown): string {
  const dir = mkdtempSync(join(workDir, 'pin-'));
  writeFileSync(
    join(dir, 'release-origins.json'),
    typeof contents === 'string' ? contents : JSON.stringify(contents),
    'utf8',
  );
  return dir;
}

/** A directory that exists but holds no pin file at all. */
function withoutPin(): string {
  const dir = join(workDir, `nopin-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir);
  return dir;
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'vizora-provenance-'));
  // Every version test runs with this set. If the resolver ever reads it again, the
  // file-backed expectations below stop matching.
  process.env.npm_package_version = NPM_ENV_DECOY;
});

afterEach(() => {
  delete process.env.npm_package_version;
  rmSync(workDir, { recursive: true, force: true });
});

describe('resolveAppVersion — release modes', () => {
  it('resolves the exact version in package.json for mode "production"', () => {
    const dir = withPackageJson(JSON.stringify({ name: 'vizora-tv', version: '1.3.15' }));
    expect(resolveAppVersion('production', dir)).toBe('1.3.15');
  });

  it('resolves the exact version in package.json for mode "tv"', () => {
    const dir = withPackageJson(JSON.stringify({ name: 'vizora-tv', version: '2.0.0-rc.4' }));
    expect(resolveAppVersion('tv', dir)).toBe('2.0.0-rc.4');
  });

  it('takes the version from the file, NOT from process.env.npm_package_version', () => {
    const dir = withPackageJson(JSON.stringify({ version: '1.3.15' }));

    // The env var is set to something else entirely (see beforeEach). A resolver that
    // reads it — the pre-fix behaviour, and its `|| '1.0.0'` fallback — cannot pass both.
    expect(process.env.npm_package_version).toBe(NPM_ENV_DECOY);
    expect(resolveAppVersion('production', dir)).toBe('1.3.15');
    expect(resolveAppVersion('production', dir)).not.toBe(NPM_ENV_DECOY);
    expect(resolveAppVersion('production', dir)).not.toBe('1.0.0');
  });

  it('resolves from the file even when npm_package_version is absent entirely', () => {
    delete process.env.npm_package_version;
    const dir = withPackageJson(JSON.stringify({ version: '1.3.15' }));
    expect(resolveAppVersion('production', dir)).toBe('1.3.15');
  });

  it('throws when package.json is missing', () => {
    const dir = withoutPackageJson();
    expect(() => resolveAppVersion('production', dir)).toThrow(/\[app-version\].*missing or not valid JSON/s);
  });

  it('throws when package.json is not valid JSON', () => {
    const dir = withPackageJson('{ "version": "1.3.15"');
    expect(() => resolveAppVersion('tv', dir)).toThrow(/\[app-version\].*missing or not valid JSON/s);
  });

  it('throws when "version" is an empty string', () => {
    const dir = withPackageJson(JSON.stringify({ name: 'vizora-tv', version: '' }));
    expect(() => resolveAppVersion('production', dir)).toThrow(/\[app-version\].*missing or empty/s);
  });

  it('throws when "version" is absent', () => {
    const dir = withPackageJson(JSON.stringify({ name: 'vizora-tv' }));
    expect(() => resolveAppVersion('tv', dir)).toThrow(/\[app-version\].*missing or empty/s);
  });

  it('throws rather than falling back to the dev placeholder', () => {
    const dir = withoutPackageJson();
    // Negative control on the direction of the two tests above: the release path must
    // not be reachable by anything that returns a value at all.
    let returned: string | undefined;
    try {
      returned = resolveAppVersion('production', dir);
    } catch {
      returned = undefined;
    }
    expect(returned).toBeUndefined();
  });

  it('names both release modes as release modes, and nothing else', () => {
    expect(isReleaseMode('production')).toBe(true);
    expect(isReleaseMode('tv')).toBe(true);
    expect(isReleaseMode('development')).toBe(false);
    expect(isReleaseMode('staging')).toBe(false);
    expect(isReleaseMode('test')).toBe(false);
  });
});

describe('resolveAppVersion — non-release modes', () => {
  it('resolves the real version when package.json is readable', () => {
    const dir = withPackageJson(JSON.stringify({ version: '1.3.15' }));
    expect(resolveAppVersion('development', dir)).toBe('1.3.15');
    expect(resolveAppVersion('development', dir)).not.toBe(NPM_ENV_DECOY);
  });

  it('degrades to the dev placeholder instead of throwing when package.json is missing', () => {
    const dir = withoutPackageJson();
    expect(() => resolveAppVersion('development', dir)).not.toThrow();
    expect(resolveAppVersion('development', dir)).toBe(DEV_VERSION_FALLBACK);
  });

  it('degrades to the dev placeholder when "version" is empty', () => {
    const dir = withPackageJson(JSON.stringify({ version: '' }));
    expect(resolveAppVersion('staging', dir)).toBe(DEV_VERSION_FALLBACK);
  });
});

/**
 * The origin guard is the mechanism CLAUDE.md and release-origins.json both describe
 * as the reason two people can no longer build the same commit and ship APKs pointing
 * at different backends. Every branch below is asserted on its own message, not just
 * on "it threw": several of these mutations make an ADJACENT branch throw instead, and
 * a bare toThrow() would call that a pass.
 */
describe('resolveReleaseOrigins — a valid pin', () => {
  it('pins exactly api, realtime and dashboard', () => {
    // Guards the data-driven blocks below: an emptied RELEASE_ORIGINS would otherwise
    // generate zero tests and leave the whole suite green.
    expect(RELEASE_ORIGINS.map(o => o.key)).toEqual(['api', 'realtime', 'dashboard']);
  });

  it('resolves all three origins from the pin file', () => {
    const dir = withPin(VALID_PIN);

    expect(resolveReleaseOrigins('production', {}, dir)).toEqual({
      VITE_API_URL: VALID_PIN.api,
      VITE_REALTIME_URL: VALID_PIN.realtime,
      VITE_DASHBOARD_URL: VALID_PIN.dashboard,
    });
  });

  it('resolves the pin for mode "tv" as well as "production"', () => {
    const dir = withPin(VALID_PIN);
    expect(resolveReleaseOrigins('tv', {}, dir).VITE_REALTIME_URL).toBe(VALID_PIN.realtime);
  });

  it('does not fall back to the non-release defaults', () => {
    const dir = withPin(VALID_PIN);
    const resolved = resolveReleaseOrigins('production', {}, dir);

    // The pre-1.3.13 shape: an absent .env silently produced a working-looking APK
    // aimed at api.vizora.io. Nothing here may return those.
    expect(resolved.VITE_API_URL).not.toBe('https://api.vizora.io');
    expect(resolved.VITE_REALTIME_URL).not.toBe('wss://realtime.vizora.io');
    expect(resolved.VITE_DASHBOARD_URL).not.toBe('https://dashboard.vizora.io');
  });

  it('accepts an env var that AGREES with the pin — the normal dev-machine state', () => {
    const dir = withPin(VALID_PIN);
    const env = {
      VITE_API_URL: VALID_PIN.api,
      VITE_REALTIME_URL: VALID_PIN.realtime,
      VITE_DASHBOARD_URL: VALID_PIN.dashboard,
    };

    expect(() => resolveReleaseOrigins('production', env, dir)).not.toThrow();
    expect(resolveReleaseOrigins('production', env, dir).VITE_API_URL).toBe(VALID_PIN.api);
  });
});

describe('resolveReleaseOrigins — the pin file itself', () => {
  it('throws when release-origins.json is missing', () => {
    expect(() => resolveReleaseOrigins('production', {}, withoutPin())).toThrow(
      /\[release-origins\].*is missing or not valid JSON/s,
    );
  });

  it('throws when release-origins.json is not valid JSON', () => {
    const dir = withPin('{ "api": "https://api.pinned.example"');
    expect(() => resolveReleaseOrigins('tv', {}, dir)).toThrow(
      /\[release-origins\].*is missing or not valid JSON/s,
    );
  });

  it('throws when a pinned origin is an empty string', () => {
    const dir = withPin({ ...VALID_PIN, api: '' });
    expect(() => resolveReleaseOrigins('production', {}, dir)).toThrow(
      /"api" is missing from/,
    );
  });

  it('throws when a pinned origin is not a string', () => {
    const dir = withPin({ ...VALID_PIN, dashboard: 42 });
    expect(() => resolveReleaseOrigins('production', {}, dir)).toThrow(
      /"dashboard" is missing from/,
    );
  });

  it('throws when a pinned origin is not a parseable URL', () => {
    const dir = withPin({ ...VALID_PIN, api: 'not-a-url' });
    expect(() => resolveReleaseOrigins('production', {}, dir)).toThrow(
      /"api" in .* is not a valid URL: "not-a-url"/,
    );
  });
});

/**
 * Per-origin, generated from the real RELEASE_ORIGINS. `realtime` requires wss: while
 * the other two require https:, so a suite that only ever corrupts `api` would stay
 * green while the realtime check rotted. Each case corrupts ONE key and leaves the
 * other two valid, which also proves the loop reaches every entry rather than
 * short-circuiting on the first.
 */
describe('resolveReleaseOrigins — protocol, per origin', () => {
  const DOWNGRADE: Record<string, string> = {
    'https:': 'http://downgraded.example',
    'wss:': 'ws://downgraded.example',
  };

  it('has a downgrade case for every protocol this repo pins', () => {
    for (const { protocol } of RELEASE_ORIGINS) {
      expect(DOWNGRADE[protocol]).toBeDefined();
    }
  });

  for (const { key, protocol } of RELEASE_ORIGINS) {
    it(`throws when "${key}" does not use ${protocol}`, () => {
      const dir = withPin({ ...VALID_PIN, [key]: DOWNGRADE[protocol] });

      expect(() => resolveReleaseOrigins('production', {}, dir)).toThrow(
        new RegExp(`"${key}" in .* must use ${protocol}//`),
      );
    });

    it(`does not throw when only "${key}" is checked and every origin is correct`, () => {
      // Negative control at the same layer: the assertion above must be caused by the
      // downgrade, not by the fixture being generally unbuildable.
      const dir = withPin(VALID_PIN);
      expect(() => resolveReleaseOrigins('production', {}, dir)).not.toThrow();
    });
  }
});

describe('resolveReleaseOrigins — env disagreement, per origin', () => {
  for (const { key, envVar } of RELEASE_ORIGINS) {
    it(`throws when ${envVar} disagrees with the pinned "${key}"`, () => {
      const dir = withPin(VALID_PIN);
      const env = { [envVar]: 'https://someone-elses-backend.example' };

      expect(() => resolveReleaseOrigins('production', env, dir)).toThrow(
        new RegExp(`${envVar} is set to "https://someone-elses-backend.example"`),
      );
      expect(() => resolveReleaseOrigins('production', env, dir)).toThrow(
        new RegExp(`pins "${key}"`),
      );
    });

    it(`never lets ${envVar} decide the compiled origin`, () => {
      // Direction check: the guard must STOP the build, not quietly prefer one side.
      // A resolver that returned the env value would not throw at all.
      const dir = withPin(VALID_PIN);
      const env = { [envVar]: 'https://someone-elses-backend.example' };

      let resolved: Record<string, string> | undefined;
      try {
        resolved = resolveReleaseOrigins('production', env, dir);
      } catch {
        resolved = undefined;
      }
      expect(resolved).toBeUndefined();
    });
  }

  it('throws when a missing pin key would otherwise be filled in from the env', () => {
    const dir = withPin({ realtime: VALID_PIN.realtime, dashboard: VALID_PIN.dashboard });
    const env = { VITE_API_URL: 'https://someone-elses-backend.example' };

    expect(() => resolveReleaseOrigins('production', env, dir)).toThrow(
      /"api" is missing from/,
    );
  });
});

describe('isSentryConfigured', () => {
  it('is true when a DSN is actually present', () => {
    expect(isSentryConfigured({ VITE_SENTRY_DSN: 'https://abc@o1.ingest.sentry.io/42' })).toBe(true);
  });

  it('is false when the DSN is an empty string', () => {
    expect(isSentryConfigured({ VITE_SENTRY_DSN: '' })).toBe(false);
  });

  it('is false when the DSN key is absent', () => {
    expect(isSentryConfigured({})).toBe(false);
  });

  it('ignores every other VITE_ variable', () => {
    expect(isSentryConfigured({ VITE_API_URL: 'https://vizora.cloud' })).toBe(false);
  });

  // A whitespace DSN is the same lie as MVd — stamping `true` onto an artifact whose
  // crash reporting is dead — but reachable by a typo in a CI secret rather than by
  // editing code. @sentry/core's DSN regex rejects it, makeDsn returns undefined, no
  // transport is built and every event is dropped: the SDK does not throw, it silently
  // disables. The publish-side verifier would then read the stamp and confirm the lie.
  it('is false for a whitespace-only DSN', () => {
    expect(isSentryConfigured({ VITE_SENTRY_DSN: '   ' })).toBe(false);
  });

  it('is false for a DSN of tabs and newlines', () => {
    expect(isSentryConfigured({ VITE_SENTRY_DSN: '\t\n  \r' })).toBe(false);
  });

  it('is still true for a real DSN — the trim must not reject valid input', () => {
    expect(isSentryConfigured({ VITE_SENTRY_DSN: 'https://abc@o1.ingest.sentry.io/42' })).toBe(
      true,
    );
  });

  it('reports configured for a padded DSN — because the compiled value is trimmed too', () => {
    // Was a known residual: the flag trimmed, the compiled DSN did not, so a padded
    // DSN stamped `true` while Sentry's regex rejected the leading space at runtime —
    // the same false positive through a narrower entrance. Closed by deriving both
    // from resolveSentryDsn. The pairing is what makes this assertion honest, so it is
    // asserted here as a pair, not as a lone boolean.
    const env = { VITE_SENTRY_DSN: ' https://abc@o1.ingest.sentry.io/42 ' };

    expect(isSentryConfigured(env)).toBe(true);
    expect(resolveSentryDsn(env)).toBe('https://abc@o1.ingest.sentry.io/42');
  });

  it('never claims configured while compiling a DSN Sentry would reject as empty', () => {
    // The invariant the two functions exist to hold, stated once: the flag is true
    // exactly when the compiled DSN is non-empty. Nothing may satisfy one and not
    // the other.
    for (const dsn of [undefined, '', '   ', '\t\n ', 'https://abc@o1.ingest.sentry.io/42']) {
      const env = { VITE_SENTRY_DSN: dsn };
      expect(isSentryConfigured(env)).toBe(resolveSentryDsn(env).length > 0);
    }
  });
});

describe('resolveSentryDsn', () => {
  it('returns an empty string when no DSN is set', () => {
    expect(resolveSentryDsn({})).toBe('');
  });

  it('returns an empty string for a whitespace-only DSN', () => {
    expect(resolveSentryDsn({ VITE_SENTRY_DSN: '   ' })).toBe('');
  });

  it('strips the padding Sentry would choke on', () => {
    expect(resolveSentryDsn({ VITE_SENTRY_DSN: '  https://abc@o1.ingest.sentry.io/42\n' })).toBe(
      'https://abc@o1.ingest.sentry.io/42',
    );
  });

  it('leaves an already-clean DSN byte-identical', () => {
    const dsn = 'https://abc@o1.ingest.sentry.io/42';
    expect(resolveSentryDsn({ VITE_SENTRY_DSN: dsn })).toBe(dsn);
  });
});

describe('releaseSentryWarning', () => {
  it('warns for a release build with no DSN', () => {
    const warning = releaseSentryWarning('production', false);
    expect(warning).not.toBeNull();
    expect(warning).toContain('[sentry] WARNING');
    expect(warning).toContain('production');
    expect(warning).toContain('__VIZORA_SENTRY_CONFIGURED__');
  });

  it('warns for a tv release build with no DSN', () => {
    expect(releaseSentryWarning('tv', false)).not.toBeNull();
    expect(releaseSentryWarning('tv', false)).toContain('[sentry] WARNING');
  });

  it('says nothing when the release build has a DSN', () => {
    expect(releaseSentryWarning('production', true)).toBeNull();
  });

  it('says nothing for a non-release build with no DSN', () => {
    expect(releaseSentryWarning('development', false)).toBeNull();
  });
});

/**
 * The wiring, not the helpers: these call the real vite.config.ts factory and read the
 * `define` block it returns — the same object vite compiles into the bundle. A helper
 * that decides correctly but is called wrongly (or not at all) fails here.
 */
describe('vite.config.ts stamps what build-provenance decided', () => {
  type ConfigFactory = (env: {
    mode: string;
    command: 'build' | 'serve';
  }) => { define: Record<string, string> };

  const PINNED = JSON.parse(
    readFileSync(resolve(process.cwd(), 'release-origins.json'), 'utf8'),
  ) as { api: string; realtime: string; dashboard: string };

  const REPO_VERSION = (
    JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as { version: string }
  ).version;

  const TOUCHED = [
    'VITE_API_URL',
    'VITE_REALTIME_URL',
    'VITE_DASHBOARD_URL',
    'VITE_SENTRY_DSN',
  ] as const;

  let saved: Record<string, string | undefined>;

  async function buildConfig(mode: string) {
    const factory = (await import('../vite.config')).default as unknown as ConfigFactory;
    return factory({ mode, command: 'build' });
  }

  beforeEach(() => {
    saved = Object.fromEntries(TOUCHED.map(k => [k, process.env[k]]));
    // Agree with the pin so the origin guard (tested elsewhere) cannot be what fails,
    // whatever this machine's environment happens to hold.
    process.env.VITE_API_URL = PINNED.api;
    process.env.VITE_REALTIME_URL = PINNED.realtime;
    process.env.VITE_DASHBOARD_URL = PINNED.dashboard;
    delete process.env.VITE_SENTRY_DSN;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    for (const key of TOUCHED) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    vi.restoreAllMocks();
  });

  it('stamps __APP_VERSION__ from package.json, not from npm_package_version', async () => {
    const config = await buildConfig('production');

    expect(process.env.npm_package_version).toBe(NPM_ENV_DECOY);
    expect(config.define['__APP_VERSION__']).toBe(JSON.stringify(REPO_VERSION));
    expect(config.define['__APP_VERSION__']).not.toBe(JSON.stringify(NPM_ENV_DECOY));
    expect(config.define['__APP_VERSION__']).not.toBe(JSON.stringify('1.0.0'));
  });

  it('stamps __RELEASE_SENTRY_CONFIGURED__ false, and warns, when no DSN was present', async () => {
    const config = await buildConfig('production');

    expect(config.define['__RELEASE_SENTRY_CONFIGURED__']).toBe('false');
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(console.warn).mock.calls[0][0]).toContain('[sentry] WARNING');
  });

  it('stamps __RELEASE_SENTRY_CONFIGURED__ true, and stays quiet, when a DSN was present', async () => {
    process.env.VITE_SENTRY_DSN = 'https://abc@o1.ingest.sentry.io/42';

    const config = await buildConfig('production');

    expect(config.define['__RELEASE_SENTRY_CONFIGURED__']).toBe('true');
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('stamps __RELEASE_SENTRY_CONFIGURED__ false for a tv release with no DSN', async () => {
    const config = await buildConfig('tv');

    expect(config.define['__RELEASE_SENTRY_CONFIGURED__']).toBe('false');
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('does not warn in a non-release mode with no DSN', async () => {
    const config = await buildConfig('development');

    expect(config.define['__RELEASE_SENTRY_CONFIGURED__']).toBe('false');
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('stamps __RELEASE_SENTRY_CONFIGURED__ false for a whitespace-only DSN', async () => {
    process.env.VITE_SENTRY_DSN = '   ';

    const config = await buildConfig('production');

    expect(config.define['__RELEASE_SENTRY_CONFIGURED__']).toBe('false');
    expect(config.define['import.meta.env.VITE_SENTRY_DSN']).toBe(JSON.stringify(''));
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('compiles the TRIMMED DSN into the bundle, not the padded one', async () => {
    process.env.VITE_SENTRY_DSN = '  https://abc@o1.ingest.sentry.io/42  ';

    const config = await buildConfig('production');

    // The bytes that ship are what Sentry parses at runtime. Padding here is the
    // difference between working telemetry and a single console.error in logcat.
    expect(config.define['import.meta.env.VITE_SENTRY_DSN']).toBe(
      JSON.stringify('https://abc@o1.ingest.sentry.io/42'),
    );
    expect(config.define['__RELEASE_SENTRY_CONFIGURED__']).toBe('true');
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('compiles the PINNED origins into a release build', async () => {
    const config = await buildConfig('production');

    expect(config.define['import.meta.env.VITE_API_URL']).toBe(JSON.stringify(PINNED.api));
    expect(config.define['import.meta.env.VITE_REALTIME_URL']).toBe(
      JSON.stringify(PINNED.realtime),
    );
    expect(config.define['import.meta.env.VITE_DASHBOARD_URL']).toBe(
      JSON.stringify(PINNED.dashboard),
    );
    // The pin file also carries a `_comment` block; the stamp must contain the three
    // origins and nothing else, in the order the client reads them back.
    expect(config.define['__RELEASE_ORIGINS_JSON__']).toBe(
      JSON.stringify(
        JSON.stringify({
          api: PINNED.api,
          realtime: PINNED.realtime,
          dashboard: PINNED.dashboard,
        }),
      ),
    );
  });

  it('REFUSES a release build when a VITE_ origin disagrees with the pin', async () => {
    process.env.VITE_API_URL = 'https://someone-elses-backend.example';

    await expect(buildConfig('production')).rejects.toThrow(
      /\[release-origins\].*VITE_API_URL is set to/s,
    );
  });

  it('REFUSES a tv release build when a VITE_ origin disagrees with the pin', async () => {
    process.env.VITE_REALTIME_URL = 'wss://someone-elses-backend.example';

    await expect(buildConfig('tv')).rejects.toThrow(/\[release-origins\].*VITE_REALTIME_URL/s);
  });

  it('takes the env path in a NON-release mode, even disagreeing with the pin', async () => {
    process.env.VITE_API_URL = 'http://localhost:9999';

    const config = await buildConfig('development');

    expect(config.define['import.meta.env.VITE_API_URL']).toBe(
      JSON.stringify('http://localhost:9999'),
    );
  });
});
