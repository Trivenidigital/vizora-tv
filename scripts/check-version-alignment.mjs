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

// versionCode is not derived from the version string, but it must move when the
// version does, or Play rejects the upload and a sideloaded install-over becomes
// two distinct binaries claiming one identity.
const versionCode = gradle.match(/versionCode\s+(\d+)/)?.[1];
if (!versionCode) {
  console.error('android/app/build.gradle has no versionCode.');
  process.exit(1);
}

if (failures.length > 0) process.exit(1);
console.log(`Version alignment OK: ${expected} (versionCode ${versionCode})`);
