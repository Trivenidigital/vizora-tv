#!/usr/bin/env node
/**
 * file:// origin + CORS proxy check for the packaged webOS (and Tizen) app.
 *
 *   npm run webos:package                       # or webos:build
 *   node scripts/webos-file-origin-check.mjs [--app-dir build/webos] [--timeout-ms 15000]
 *
 * WHAT THIS IS NOT: a webOS runtime. It loads the packaged index.html in a stock
 * headless Chromium: the build matching the pinned playwright-core
 * (`npx playwright-core install chromium-headless-shell` once per machine), or
 * any Chromium given by CHROMIUM_PATH. There is no real PalmSystem/Luna bus, no LG security policy, and
 * the engine is a modern Chromium, not the Chromium 53–120 that webOS 4.x–25 ship.
 * `window.PalmSystem` is stubbed with an empty object (disable with
 * --no-webos-stub) only so platform detection takes the webOS branch and the
 * pairing request carries a `webos-` identifier — nothing else of webOS exists.
 *
 * WHAT IT DOES PROVE, on that engine:
 *  1. the legacy SystemJS bundle boots from a file:// URL with relative asset
 *     paths (no module scripts, no crossorigin attributes);
 *  2. the Origin header a file:// page sends to the API (expected: literal "null");
 *  3. that the pairing POST — a JSON body, hence a CORS preflight — is BLOCKED
 *     when the preflight answers like prod does today (MODE A: 204, no
 *     Access-Control-Allow-Origin) and SUCCEEDS when it answers
 *     `Access-Control-Allow-Origin: null` without credentials (MODE B).
 *
 * Both outcomes are required. If MODE A pairs, the harness is not exercising CORS
 * and MODE B's success means nothing — so the script exits non-zero unless A fails
 * AND B succeeds.
 *
 * The API base is injected with the app's own `?api_url=` override (see
 * loadConfig in src/main.ts), so the artifact under test is the real release
 * build, byte-for-byte, not a rebuild pointed at a stub.
 */
import http from 'node:http';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const appDir = resolve(root, argValue('--app-dir', 'build/webos'));
const timeoutMs = Number(argValue('--timeout-ms', '15000'));
const webosStub = !args.includes('--no-webos-stub');

const indexHtml = join(appDir, 'index.html');
if (!existsSync(indexHtml)) {
  console.error(`${indexHtml} not found — run \`npm run webos:build\` first (or pass --app-dir).`);
  process.exit(2);
}

const PAIRING_CODE = 'FILE01';

/** Stub API. Records every request; answers preflights according to `mode`. */
function startStub(mode) {
  const seen = [];
  const corsHeaders = mode === 'B'
    ? { 'Access-Control-Allow-Origin': 'null', Vary: 'Origin' }
    : {};

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      seen.push({
        method: req.method,
        url: req.url,
        // undefined = header absent; the string "null" = the opaque-origin literal.
        origin: req.headers.origin,
        requestMethod: req.headers['access-control-request-method'],
        requestHeaders: req.headers['access-control-request-headers'],
        body: body || undefined,
      });

      if (req.method === 'OPTIONS') {
        // MODE A mirrors prod today: the preflight "succeeds" with 204 but grants
        // nothing, so the browser refuses to send the real request.
        res.writeHead(204, mode === 'B'
          ? {
              ...corsHeaders,
              'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
              'Access-Control-Allow-Headers': 'Authorization, Content-Type',
              'Access-Control-Max-Age': '600',
            }
          : {});
        return res.end();
      }

      const json = (status, payload) => {
        res.writeHead(status, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify(payload));
      };
      if (req.method === 'POST' && req.url.startsWith('/api/v1/devices/pairing/request')) {
        // Shape read by startPairing(): envelope { success, data: { code, deviceId?, expiresInSeconds? } }.
        return json(200, { success: true, data: { code: PAIRING_CODE, deviceId: 'dev-file-origin', expiresInSeconds: 300 } });
      }
      if (req.url.startsWith(`/api/v1/devices/pairing/status/${PAIRING_CODE}`)) {
        return json(200, { success: true, data: { status: 'pending' } });
      }
      return json(404, { success: false, error: 'not found' });
    });
  });

  return new Promise(resolveStart => {
    server.listen(0, '127.0.0.1', () => resolveStart({ server, seen, port: server.address().port }));
  });
}

async function runMode(browser, mode) {
  const { server, seen, port } = await startStub(mode);
  const apiUrl = `http://127.0.0.1:${port}`;
  const context = await browser.newContext();
  const page = await context.newPage();
  const consoleLines = [];
  page.on('console', msg => consoleLines.push(`[${msg.type()}] ${msg.text()}`));
  page.on('pageerror', err => consoleLines.push(`[pageerror] ${err.message}`));
  page.on('requestfailed', req => consoleLines.push(`[requestfailed] ${req.method()} ${req.url()} — ${req.failure()?.errorText}`));
  if (webosStub) await page.addInitScript(() => { window.PalmSystem = {}; });

  const url = `${pathToFileURL(indexHtml).href}?api_url=${encodeURIComponent(apiUrl)}`;
  await page.goto(url);

  // Paired-or-blocked is decided by the pairing code on the glass: the placeholder
  // is "------" until a pairing response has actually been read.
  const shownCode = await page
    .waitForFunction(
      expected => document.getElementById('pairing-code')?.textContent === expected,
      PAIRING_CODE,
      { timeout: timeoutMs },
    )
    .then(() => PAIRING_CODE)
    .catch(async () => page.evaluate(() => document.getElementById('pairing-code')?.textContent ?? null));

  const state = await page.evaluate(() => ({
    systemJsLoaded: typeof window.System !== 'undefined',
    moduleScripts: document.querySelectorAll('script[type="module"]').length,
    crossoriginAttrs: document.querySelectorAll('[crossorigin]').length,
    pairingScreenVisible: !!document.getElementById('pairing-screen') &&
      !document.getElementById('pairing-screen').classList.contains('hidden'),
    location: location.protocol,
  }));
  await context.close();
  await new Promise(r => server.close(r));

  const pairingPosts = seen.filter(r => r.method === 'POST' && r.url.startsWith('/api/v1/devices/pairing/request'));
  const preflights = seen.filter(r => r.method === 'OPTIONS');
  const bootErrors = consoleLines.filter(l => /module script|crossorigin|Failed to load module|SystemJS|Unexpected token|SyntaxError/i.test(l));
  const corsErrors = consoleLines.filter(l => /CORS|Access-Control-Allow-Origin/i.test(l));

  let identifier;
  try { identifier = JSON.parse(pairingPosts[0]?.body ?? 'null')?.deviceIdentifier; } catch { /* not JSON */ }

  return {
    mode,
    booted: state.systemJsLoaded && state.pairingScreenVisible && bootErrors.length === 0,
    ...state,
    originsSeen: [...new Set(seen.map(r => (r.origin === undefined ? '<absent>' : r.origin)))],
    preflights: preflights.map(r => `${r.url} req-method=${r.requestMethod} req-headers=${r.requestHeaders} origin=${r.origin}`),
    pairingPostReachedServer: pairingPosts.length > 0,
    pairingPostIdentifier: identifier,
    pairingCodeShown: shownCode,
    paired: shownCode === PAIRING_CODE,
    bootErrors,
    corsErrors,
    requests: seen.map(r => `${r.method} ${r.url} origin=${r.origin === undefined ? '<absent>' : r.origin}`),
    console: consoleLines,
  };
}

const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined });
console.log(`Engine: Chromium ${browser.version()} (headless) — NOT a webOS runtime; see header.`);
console.log(`App dir: ${appDir}`);
console.log(`PalmSystem stub: ${webosStub ? 'on' : 'off'}\n`);

const results = [];
try {
  for (const mode of ['A', 'B']) results.push(await runMode(browser, mode));
} finally {
  await browser.close();
}

for (const r of results) {
  console.log(`===== MODE ${r.mode} (${r.mode === 'A' ? 'prod today: 204 preflight, no ACAO' : 'ACAO null, no credentials'}) =====`);
  console.log(JSON.stringify(r, null, 2));
  console.log();
}

const [a, b] = results;
const verdict = {
  bootedFromFile: a.booted && b.booted,
  originIsNullLiteral: [...a.originsSeen, ...b.originsSeen].every(o => o === 'null'),
  modeABlocked: !a.paired && !a.pairingPostReachedServer,
  modeBPaired: b.paired && b.pairingPostReachedServer,
};
console.log('VERDICT', JSON.stringify(verdict, null, 2));
const ok = Object.values(verdict).every(Boolean);
console.log(ok
  ? 'PASS: file:// boot works, Origin is "null", prod-style preflight blocks pairing, ACAO null unblocks it.'
  : 'FAIL: at least one expectation did not hold — read the per-mode output above.');
process.exit(ok ? 0 : 1);
