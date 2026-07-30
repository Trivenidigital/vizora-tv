#!/usr/bin/env node
/**
 * Rasterize the app icon SVG into the PNG sizes the TV platforms need.
 * The generated PNGs are committed (packaging must not depend on a native
 * rasterizer being available on every build machine); re-run this script
 * only when store-listing/icons/app-icon.svg changes.
 *
 * Usage: node scripts/generate-tv-icons.mjs
 */
import { Resvg } from '@resvg/resvg-js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const svg = readFileSync(join(root, 'store-listing/icons/app-icon.svg'), 'utf8');

const outputs = [
  // Samsung Tizen: Smart Hub application icon
  { path: 'tizen/icon.png', size: 512 },
  // LG webOS: launcher icon + large icon (appinfo.json icon/largeIcon)
  { path: 'webos/icon.png', size: 80 },
  { path: 'webos/largeIcon.png', size: 130 },
];

for (const { path, size } of outputs) {
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: size },
    font: { loadSystemFonts: true },
  });
  const png = resvg.render().asPng();
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, png);
  console.log(`wrote ${path} (${size}x${size}, ${png.length} bytes)`);
}
