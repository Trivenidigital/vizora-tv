#!/usr/bin/env node
/**
 * file:// origin + CORS proxy check for the packaged webOS (and Tizen) app,
 * driven through the whole device lifecycle: pairing, the Authorization-header
 * REST calls, and the Socket.IO realtime connection.
 *
 *   npm run webos:package                       # or webos:build
 *   node scripts/webos-file-origin-check.mjs [--app-dir build/webos] [--timeout-ms 20000]
 *
 * WHAT THIS IS NOT: a webOS runtime. It loads the packaged index.html in a stock
 * headless Chromium: the build matching the pinned playwright-core
 * (`npx playwright-core install chromium-headless-shell` once per machine), or
 * any Chromium given by CHROMIUM_PATH. There is no real PalmSystem/Luna bus, no
 * LG security policy, and the engine is a modern Chromium, not the Chromium
 * 53–120 that webOS 4.x–25 ship. `window.PalmSystem` is stubbed with an empty
 * object (disable with --no-webos-stub) only so platform detection takes the
 * webOS branch and the pairing request carries a `webos-` identifier — nothing
 * else of webOS exists.
 *
 * The API base and realtime URL are injected with the app's own `?api_url=` /
 * `?realtime_url=` overrides (see loadConfig in src/main.ts), so the artifact
 * under test is the real release build, byte-for-byte, not a rebuild.
 *
 * STUB API (loopback), three modes:
 *   A   prod today: every preflight 204 with no Access-Control-Allow-Origin.
 *       Failing control — pairing must be blocked.
 *   A'  pairing calls get ACAO `null`; calls carrying `Authorization` (and their
 *       preflights) get none. Shows the authorized GETs fail independently.
 *   B   ACAO `null` on everything, no credentials, Allow-Headers
 *       `Authorization, Content-Type`. The whole lifecycle must succeed.
 *
 * STUB REALTIME: a real socket.io server (same 4.x major as the Vizora gateway),
 * configured like the gateway: cors { origin: ['https://vizora.cloud'],
 * credentials: true }, transports ['websocket','polling'], no allowRequest.
 * The app itself never falls back to polling (engine.io-client's
 * tryAllTransports defaults to false — see the comment near `upgrading` in
 * src/main.ts), so polling is probed separately: a minimal file:// page loading
 * the same socket.io-client build (node_modules/socket.io-client/dist, the
 * version the app bundles) with transports ['polling'], against the prod-like
 * server and against a positive control that also allows origin 'null'.
 *
 * After the app connects, the server emits `device:revoked`; the client's
 * confirmRevocation() answers that with GET /devices/auth/check, which is how
 * the auth/check call is driven deterministically (the stub answers 200, so the
 * client logs "NOT confirmed" and keeps its state). GET /devices/me/content is
 * the client's own pull-on-connect.
 *
 * Exits non-zero unless every expectation below holds. The failing controls are
 * required as well as the successes: without them a success proves nothing.
 */
import http from 'node:http';
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { Server } from 'socket.io';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const appDir = resolve(root, argValue('--app-dir', 'build/webos'));
const timeoutMs = Number(argValue('--timeout-ms', '20000'));
const webosStub = !args.includes('--no-webos-stub');

const indexHtml = join(appDir, 'index.html');
if (!existsSync(indexHtml)) {
  console.error(`${indexHtml} not found — run \`npm run webos:build\` first (or pass --app-dir).`);
  process.exit(2);
}

const PAIRING_CODE = 'FILE01';
const DEVICE_TOKEN = 'file-origin-device-token';
const DEVICE_ID = 'dev-file-origin';
const TENANT_ID = 'tenant-file-origin';
const PROD_REALTIME_CORS = { origin: ['https://vizora.cloud'], credentials: true };

const originOf = headers => (headers.origin === undefined ? '<absent>' : headers.origin);

async function waitFor(predicate, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return predicate();
}

/**
 * Stub API. Records every request; grants ACAO per mode:
 *   pairing class    — A: no, A': yes, B: yes
 *   authorized class — A: no, A': no,  B: yes
 * A request is "authorized class" when it carries Authorization, or (for a
 * preflight) asks permission to send it.
 */
function startApiStub(mode) {
  const seen = [];
  const grants = cls => (cls === 'authorized' ? mode === 'B' : mode !== 'A');

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const requestHeaders = req.headers['access-control-request-headers'];
      const cls = req.method === 'OPTIONS'
        ? (/authorization/i.test(requestHeaders ?? '') ? 'authorized' : 'pairing')
        : (req.headers.authorization ? 'authorized' : 'pairing');
      seen.push({
        method: req.method,
        url: req.url,
        origin: originOf(req.headers),
        requestMethod: req.headers['access-control-request-method'],
        requestHeaders,
        authorization: req.headers.authorization,
        cls,
        granted: grants(cls),
        body: body || undefined,
      });
      const cors = grants(cls) ? { 'Access-Control-Allow-Origin': 'null', Vary: 'Origin' } : {};

      if (req.method === 'OPTIONS') {
        res.writeHead(204, grants(cls)
          ? {
              ...cors,
              'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
              'Access-Control-Allow-Headers': 'Authorization, Content-Type',
              'Access-Control-Max-Age': '600',
            }
          : {});
        return res.end();
      }

      const json = (status, payload) => {
        res.writeHead(status, { 'Content-Type': 'application/json', ...cors });
        res.end(JSON.stringify(payload));
      };
      const url = req.url ?? '';
      if (req.method === 'POST' && url.startsWith('/api/v1/devices/pairing/request')) {
        // Shape read by startPairing(): { success, data: { code, deviceId?, expiresInSeconds? } }.
        return json(200, { success: true, data: { code: PAIRING_CODE, deviceId: DEVICE_ID, expiresInSeconds: 300 } });
      }
      if (url.startsWith(`/api/v1/devices/pairing/status/${PAIRING_CODE}`)) {
        // Shape read by startPairingCheck(): { status: 'paired', deviceToken, deviceId, tenantId }.
        return json(200, { success: true, data: { status: 'paired', deviceToken: DEVICE_TOKEN, deviceId: DEVICE_ID, tenantId: TENANT_ID } });
      }
      if (url.startsWith('/api/v1/devices/auth/check')) {
        return json(200, { success: true, data: { status: 'ok' } });
      }
      if (url.startsWith('/api/v1/devices/me/content')) {
        // Shape read by applyPulledContent(): { version?, playlist? }. No playlist
        // assigned, so the device holds on its branded "paired" screen.
        return json(200, { success: true, data: { version: 'v0', playlist: null } });
      }
      return json(404, { success: false, error: 'not found' });
    });
  });

  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, seen, port: server.address().port })));
}

/** Real socket.io server, configured like the Vizora gateway unless `cors` is overridden. */
function startRealtimeStub({ cors = PROD_REALTIME_CORS, emitRevokedOnConnect = false } = {}) {
  const httpRequests = [];
  const connections = [];
  const httpServer = http.createServer();
  const io = new Server(httpServer, {
    cors,
    transports: ['websocket', 'polling'],
    pingInterval: 25000,
    pingTimeout: 20000,
    maxHttpBufferSize: 2 * 1024 * 1024,
  });
  // Registered AFTER the Server on purpose: engine.io's attach() takes over every
  // 'request' listener present at that moment and forwards only non-/socket.io/
  // paths to it, so an earlier listener never sees a polling request. These record
  // what reached the server, which is not what the browser let the page read.
  httpServer.on('request', req => {
    httpRequests.push(`${req.method} ${req.url} origin=${originOf(req.headers)}`);
  });
  httpServer.on('upgrade', req => {
    httpRequests.push(`UPGRADE ${req.url} origin=${originOf(req.headers)}`);
  });
  io.on('connection', socket => {
    connections.push({
      transport: socket.conn.transport.name,
      origin: originOf(socket.handshake.headers),
      tokenMatches: socket.handshake.auth?.token === DEVICE_TOKEN,
    });
    if (emitRevokedOnConnect) setTimeout(() => socket.emit('device:revoked', { reason: 'file-origin-check' }), 500);
  });
  return new Promise(r => httpServer.listen(0, '127.0.0.1', () =>
    r({ io, httpServer, httpRequests, connections, port: httpServer.address().port })));
}

const closeRealtime = rt => new Promise(r => rt.io.close(() => r()));

function attachConsole(page, lines) {
  page.on('console', msg => lines.push(`[${msg.type()}] ${msg.text()}`));
  page.on('pageerror', err => lines.push(`[pageerror] ${err.message}`));
  page.on('requestfailed', req => lines.push(`[requestfailed] ${req.method()} ${req.url()} — ${req.failure()?.errorText}`));
}

async function runAppMode(browser, mode) {
  const api = await startApiStub(mode);
  const rt = await startRealtimeStub({ emitRevokedOnConnect: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const consoleLines = [];
  attachConsole(page, consoleLines);
  if (webosStub) await page.addInitScript(() => { window.PalmSystem = {}; });

  const url = `${pathToFileURL(indexHtml).href}?api_url=${encodeURIComponent(`http://127.0.0.1:${api.port}`)}` +
    `&realtime_url=${encodeURIComponent(`ws://127.0.0.1:${rt.port}`)}`;
  await page.goto(url);

  const has = (method, prefix) => api.seen.some(r => r.method === method && r.url.startsWith(prefix));
  const preflightFor = prefix => api.seen.some(r => r.method === 'OPTIONS' && r.url.startsWith(prefix));
  const logged = re => consoleLines.some(l => re.test(l));

  // Pairing code on the glass: the placeholder is "------" until a pairing response is read.
  const codeShown = await page
    .waitForFunction(c => document.getElementById('pairing-code')?.textContent === c, PAIRING_CODE, { timeout: timeoutMs })
    .then(() => true, () => false);

  if (mode !== 'A') {
    // Paired -> socket connects -> pull-on-connect (me/content) -> device:revoked -> auth/check.
    await waitFor(() => logged(/Device paired successfully/), timeoutMs);
    await waitFor(() => rt.connections.length > 0, timeoutMs);
    await waitFor(() => (preflightFor('/api/v1/devices/me/content') || has('GET', '/api/v1/devices/me/content')) &&
      (preflightFor('/api/v1/devices/auth/check') || has('GET', '/api/v1/devices/auth/check')), timeoutMs);
    // Let the authorized GETs either land or fail before reading state.
    await waitFor(() => mode === 'B'
      ? has('GET', '/api/v1/devices/auth/check') && has('GET', '/api/v1/devices/me/content') && logged(/NOT confirmed/)
      : logged(/Auth check unreachable/) && logged(/pullContent failed/), timeoutMs);
  } else {
    // Give the pairing retry loop a few attempts so "blocked" is not "not yet tried".
    await new Promise(r => setTimeout(r, 4000));
  }

  const state = await page.evaluate(() => ({
    systemJsLoaded: typeof window.System !== 'undefined',
    moduleScripts: document.querySelectorAll('script[type="module"]').length,
    crossoriginAttrs: document.querySelectorAll('[crossorigin]').length,
    location: location.protocol,
  }));
  await context.close();
  await new Promise(r => api.server.close(r));
  await closeRealtime(rt);

  const bootErrors = consoleLines.filter(l => /module script|crossorigin|Failed to load module|Unexpected token|SyntaxError/i.test(l));
  const authorizedGets = api.seen.filter(r => r.method === 'GET' && r.authorization);
  let identifier;
  const post = api.seen.find(r => r.method === 'POST');
  try { identifier = JSON.parse(post?.body ?? 'null')?.deviceIdentifier; } catch { /* not JSON */ }

  return {
    mode,
    booted: state.systemJsLoaded && bootErrors.length === 0,
    ...state,
    apiOriginsSeen: [...new Set(api.seen.map(r => r.origin))],
    pairingPostReachedServer: has('POST', '/api/v1/devices/pairing/request'),
    pairingPostIdentifier: identifier,
    pairingCodeShown: codeShown,
    paired: logged(/Device paired successfully/),
    realtime: {
      connections: rt.connections,
      httpRequests: rt.httpRequests,
      clientLoggedConnected: logged(/Connected to realtime gateway/),
    },
    authorizedPreflights: api.seen
      .filter(r => r.method === 'OPTIONS' && r.cls === 'authorized')
      .map(r => `${r.url} req-headers=${r.requestHeaders} origin=${r.origin} granted=${r.granted}`),
    authorizedGetsReachedServer: authorizedGets.map(r => `${r.url} authorization=${r.authorization} origin=${r.origin}`),
    authCheckReached: has('GET', '/api/v1/devices/auth/check'),
    meContentReached: has('GET', '/api/v1/devices/me/content'),
    bootErrors,
    corsErrors: consoleLines.filter(l => /CORS policy/i.test(l)),
    lifecycleLog: consoleLines.filter(l =>
      /paired successfully|Connected to realtime|Connection error|device:revoked|NOT confirmed|Auth check unreachable|pullContent|Pairing request failed/.test(l)),
    requests: api.seen.map(r => `${r.method} ${r.url} origin=${r.origin}${r.authorization ? ' +Authorization' : ''} granted=${r.granted}`),
    console: consoleLines,
  };
}

/**
 * Minimal file:// page with the same socket.io-client build the app bundles,
 * forced onto one transport. Answers whether that transport can reach a
 * gateway configured with `cors` from an opaque (null) origin.
 */
async function runTransportProbe(browser, probeDir, transport, cors, label) {
  const rt = await startRealtimeStub({ cors });
  const page = await (await browser.newContext()).newPage();
  const consoleLines = [];
  attachConsole(page, consoleLines);
  const html = join(probeDir, `${label}.html`);
  writeFileSync(html, `<!doctype html><meta charset="utf-8"><script src="socket.io.min.js"></script>
<script>
  window.__result = null;
  const s = io('http://127.0.0.1:${rt.port}', { transports: ['${transport}'], auth: { token: '${DEVICE_TOKEN}' }, reconnection: false, timeout: 8000 });
  s.on('connect', () => { window.__result = { connected: true, transport: s.io.engine.transport.name }; });
  s.on('connect_error', e => { window.__result = { connected: false, error: String(e && e.message), description: String(e && e.description && (e.description.message || e.description)) }; });
</script>`);
  await page.goto(pathToFileURL(html).href);
  await page.waitForFunction(() => window.__result !== null, null, { timeout: 15000 }).catch(() => {});
  const result = await page.evaluate(() => window.__result);
  await page.context().close();
  await closeRealtime(rt);
  return {
    label,
    transport,
    serverCors: cors,
    result,
    serverConnections: rt.connections,
    serverHttpRequests: rt.httpRequests,
    corsErrors: consoleLines.filter(l => /CORS policy/i.test(l)),
    console: consoleLines,
  };
}

const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined });
console.log(`Engine: Chromium ${browser.version()} (headless) — NOT a webOS runtime; see header.`);
console.log(`App dir: ${appDir}`);
console.log(`PalmSystem stub: ${webosStub ? 'on' : 'off'}\n`);

const probeDir = mkdtempSync(join(tmpdir(), 'vizora-sio-probe-'));
copyFileSync(join(root, 'node_modules/socket.io-client/dist/socket.io.min.js'), join(probeDir, 'socket.io.min.js'));

const modes = {};
const probes = {};
try {
  for (const mode of ['A', "A'", 'B']) modes[mode] = await runAppMode(browser, mode);
  probes.pollingProd = await runTransportProbe(browser, probeDir, 'polling', PROD_REALTIME_CORS, 'polling-prod-cors');
  probes.pollingNullAllowed = await runTransportProbe(
    browser, probeDir, 'polling', { origin: ['https://vizora.cloud', 'null'], credentials: true }, 'polling-null-allowed-control');
  probes.websocketProd = await runTransportProbe(browser, probeDir, 'websocket', PROD_REALTIME_CORS, 'websocket-prod-cors');
} finally {
  await browser.close();
  rmSync(probeDir, { recursive: true, force: true });
}

for (const [mode, r] of Object.entries(modes)) {
  console.log(`===== APP MODE ${mode} =====`);
  console.log(JSON.stringify(r, null, 2));
  console.log();
}
for (const p of Object.values(probes)) {
  console.log(`===== TRANSPORT PROBE ${p.label} =====`);
  console.log(JSON.stringify(p, null, 2));
  console.log();
}

const A = modes.A, Ap = modes["A'"], B = modes.B;
const allApiOrigins = [A, Ap, B].flatMap(r => r.apiOriginsSeen);
const wsConn = r => r.realtime.connections.find(c => c.transport === 'websocket');
const verdict = {
  bootedFromFile: A.booted && Ap.booted && B.booted,
  apiOriginIsNullLiteral: allApiOrigins.length > 0 && allApiOrigins.every(o => o === 'null'),
  modeA_pairingBlocked: !A.pairingCodeShown && !A.pairingPostReachedServer && !A.paired,
  modeAprime_pairsAndConnects: Ap.paired && Boolean(wsConn(Ap)),
  modeAprime_authorizedGetsBlocked: !Ap.authCheckReached && !Ap.meContentReached && Ap.authorizedPreflights.length > 0,
  modeB_paired: B.paired,
  modeB_websocketConnectedFromNullOrigin: Boolean(wsConn(B)) && wsConn(B).origin === 'null' && wsConn(B).tokenMatches,
  modeB_authCheckAndMeContentReached: B.authCheckReached && B.meContentReached &&
    B.authorizedGetsReachedServer.every(g => g.includes(`Bearer ${DEVICE_TOKEN}`)),
  modeB_noCorsErrors: B.corsErrors.length === 0,
  probe_websocketProdCorsConnects: probes.websocketProd.result?.connected === true,
  probe_pollingProdCorsBlocked: probes.pollingProd.result?.connected === false && probes.pollingProd.corsErrors.length > 0,
  probe_pollingNullAllowedConnects: probes.pollingNullAllowed.result?.connected === true,
};
console.log('VERDICT', JSON.stringify(verdict, null, 2));
const ok = Object.values(verdict).every(Boolean);
console.log(ok
  ? 'PASS: every expectation held (see VERDICT).'
  : 'FAIL: at least one expectation did not hold — read the per-mode output above.');
process.exit(ok ? 0 : 1);
