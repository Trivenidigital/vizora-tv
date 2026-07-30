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

const target = process.argv[2];
if (!['tizen', 'webos', 'all'].includes(target ?? '')) {
  console.error('Usage: node scripts/package-tv.mjs <tizen|webos|all>');
  process.exit(1);
}

if (!existsSync(join(distTv, 'index.html'))) {
  console.error('dist-tv/ is missing or incomplete — run `npm run build:tv` first.');
  process.exit(1);
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

  console.log(`Assembled ${out}`);
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
    '  ares-install --device <tv> build/com.vizora.display_1.0.1_all.ipk\n',
  );
}
