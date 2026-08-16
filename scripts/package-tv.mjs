#!/usr/bin/env node
/**
 * Assemble ready-to-package app directories for the TV platforms from the
 * dist-tv web build (produced by `npm run build:tv`).
 *
 *   node scripts/package-tv.mjs tizen   -> build/tizen/  (package with `tizen` CLI)
 *   node scripts/package-tv.mjs webos   -> build/webos/  (package with `ares-package`)
 *   node scripts/package-tv.mjs all     -> both
 *
 * The actual .wgt / .ipk packaging requires the vendor SDK toolchains
 * (Tizen Studio, webOS TV SDK) and signing certificates, which live on the
 * release machine — this script stops at the assembled directory and prints
 * the exact command to run next. See docs/SAMSUNG_LG_TV.md.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const distTv = join(root, 'dist-tv');

// package.json is the single source of truth for the app version. The Tizen and
// webOS manifests carry their own version strings, and before this was stamped
// they had drifted 14 releases behind (still 1.0.1 while the app reported
// 1.3.15). That drift is invisible on the fleet side: Samsung and LG compare the
// *manifest* version when deciding whether an install is an update, so two
// artifacts built months apart looked identical to the installer while their
// bundles reported different appVersions on the heartbeat.
const appVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
if (!appVersion) {
  console.error('package.json has no "version" — refusing to assemble an unversioned TV package.');
  process.exit(1);
}

const target = process.argv[2];
if (!['tizen', 'webos', 'all'].includes(target ?? '')) {
  console.error('Usage: node scripts/package-tv.mjs <tizen|webos|all>');
  process.exit(1);
}

if (!existsSync(join(distTv, 'index.html'))) {
  console.error('dist-tv/ is missing or incomplete — run `npm run build:tv` first.');
  process.exit(1);
}

/**
 * Rewrite the assembled manifest's version from package.json. The check-then-write
 * is deliberate: a manifest whose version we could not find is a packaging error,
 * not something to paper over by shipping the committed value — that is exactly
 * how the 1.0.1 drift survived 14 releases.
 */
function stampVersion(platform, out) {
  const spec = platform === 'tizen'
    // The tizen pattern is anchored to its own line on purpose: an unanchored
    // /\sversion="/ matches the XML prolog's version="1.0" first, so stamping
    // would rewrite the XML declaration and produce a manifest Tizen rejects.
    ? { file: 'config.xml', find: /^(\s*version=")[^"]*(")/m, to: `$1${appVersion}$2` }
    : { file: 'appinfo.json', find: /("version"\s*:\s*")[^"]*(")/, to: `$1${appVersion}$2` };

  const path = join(out, spec.file);
  const before = readFileSync(path, 'utf8');
  if (!spec.find.test(before)) {
    console.error(`${platform}: no version field found in ${spec.file} — cannot stamp ${appVersion}.`);
    process.exit(1);
  }
  writeFileSync(path, before.replace(spec.find, spec.to));
}

function assemble(platform) {
  const src = join(root, platform);
  const out = join(root, 'build', platform);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  // Web build first, then the platform manifest/icons on top.
  cpSync(distTv, out, { recursive: true });
  cpSync(src, out, { recursive: true });

  // Packaged TV apps load from file:// — a `crossorigin` attribute puts the
  // script fetch in CORS mode, which stock Chromium blocks for file:// URLs.
  // Vite emits the attribute for HTTP serving; strip it for the package.
  const indexPath = join(out, 'index.html');
  const html = readFileSync(indexPath, 'utf8');
  writeFileSync(indexPath, html.replace(/ crossorigin(="[^"]*")?/g, ''));

  stampVersion(platform, out);

  console.log(`Assembled ${out} (version ${appVersion})`);
}

if (target === 'tizen' || target === 'all') {
  assemble('tizen');
  console.log(
    '\nNext (requires Tizen Studio CLI + Samsung certificate profile):\n' +
    '  tizen package -t wgt -s <security-profile> -- build/tizen\n' +
    '  tizen install -n build/tizen/VizoraDisplay.wgt -t <tv-target>\n',
  );
}

if (target === 'webos' || target === 'all') {
  assemble('webos');
  console.log(
    '\nNext (requires webOS TV SDK / ares CLI):\n' +
    '  ares-package build/webos -o build\n' +
    `  ares-install --device <tv> build/com.vizora.display_${appVersion}_all.ipk\n`,
  );
}
