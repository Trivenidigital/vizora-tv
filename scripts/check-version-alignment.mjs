#!/usr/bin/env node
/**
 * Assert every place that declares the app's version agrees with package.json.
 *
 * Why this exists: the version is declared in four independent literals, and
 * nothing derived any of them from the others. They drifted. The Tizen and webOS
 * manifests sat at 1.0.1 for fourteen releases while the app reported 1.3.15 on
 * the heartbeat, and no gate noticed — because each gate read a different source
 * of truth. The Play/`dumpsys` check reads android/app/build.gradle, and the
 * "heartbeat reports a non-zero appVersion" check reads the bundle, which comes
 * from package.json. Both can pass while disagreeing with each other.
 *
 * package.json is the single source of truth. This fails the build when anything
 * disagrees with it.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const expected = JSON.parse(read('package.json')).version;
if (!expected) {
  console.error('package.json has no "version".');
  process.exit(1);
}

const gradle = read('android/app/build.gradle');
const checks = [
  {
    where: 'android/app/build.gradle versionName',
    found: gradle.match(/versionName\s+"([^"]+)"/)?.[1],
  },
  {
    // Anchored to its own line: an unanchored /\sversion="/ matches the XML
    // prolog's version="1.0" first, which silently reads the wrong field.
    where: 'tizen/config.xml version',
    found: read('tizen/config.xml').match(/^\s*version="([^"]+)"/m)?.[1],
  },
  {
    where: 'webos/appinfo.json version',
    found: JSON.parse(read('webos/appinfo.json')).version,
  },
];

const failures = checks.filter((c) => c.found !== expected);
for (const c of failures) {
  console.error(`MISMATCH ${c.where}: found ${c.found ?? '<none>'}, expected ${expected} (from package.json)`);
}

// versionCode is not derived from the version string, but it must MOVE when the
// version does, or Play rejects the upload and a sideloaded install-over becomes
// two distinct binaries claiming one identity.
//
// Checking only that a versionCode EXISTS was the defect this comment already
// described: `versionName "1.3.16"` alongside `versionCode 10145` passed green,
// which is precisely the two-binaries-one-identity case. The series is derivable
// from the version — 1.3.14 -> 10144, 1.3.15 -> 10145 — so derive it and compare.
const versionCode = gradle.match(/versionCode\s+(\d+)/)?.[1];
if (!versionCode) {
  console.error('android/app/build.gradle has no versionCode.');
  process.exit(1);
}

// Deliberately a MONOTONICITY check against the last published code, not a formula
// derived from the version string. The historical series (1.3.14 -> 10144,
// 1.3.15 -> 10145) has only ever varied in the patch digit, so any formula inferred
// from it is a guess that happens to fit two points — and asserting an inferred
// formula is how you get a check that is confidently wrong. Monotonicity is the
// property Play actually enforces and the one install-over ordering depends on.
//
// Bump LAST_PUBLISHED_VERSION_CODE when a release is actually published, not when
// it is prepared.
const LAST_PUBLISHED_VERSION_CODE = 10145; // 1.3.15, live on customer devices

if (Number(versionCode) <= LAST_PUBLISHED_VERSION_CODE) {
  console.error(
    `MISMATCH android/app/build.gradle versionCode: found ${versionCode}, which is not greater ` +
      `than the last published ${LAST_PUBLISHED_VERSION_CODE}. Play rejects a non-increasing ` +
      `versionCode, and a sideloaded install-over would produce two distinct binaries claiming ` +
      `one identity.`,
  );
  process.exit(1);
}

if (failures.length > 0) process.exit(1);
console.log(`Version alignment OK: ${expected} (versionCode ${versionCode})`);
