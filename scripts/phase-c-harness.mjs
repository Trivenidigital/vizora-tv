/**
 * Phase C harness — drives the FULL content-delivery loop against a real player.
 *
 * Why this exists rather than more unit tests: this delivery path has already
 * shipped a "silent-inert" failure once. `reconcileContent` was wired on the
 * client, wired on the server, unit-tested green on both sides, and the signal
 * never fired in production (tasks/pending-decisions.md:379-383 in the Vizora
 * repo). Two more instances of the same class turned up in this workstream — the
 * heartbeat DTO rejecting every beat, and content:impression rejecting every
 * event, both invisible for months. Unit tests on either side cannot catch that
 * class; only driving the real client against a real socket + real HTTP can.
 *
 * So this speaks the actual wire protocol and lets the scenario be steered from
 * outside, including the case that matters most: DROPPING a push to prove the
 * pull backstop repairs it.
 *
 *   node scripts/phase-c-harness.mjs
 *   npx vite build --mode smoke && npx cap sync android   # player points at 10.0.2.2
 *
 * Control plane (curl from the host):
 *   GET  /ctl/state                  what the harness believes is true
 *   POST /ctl/assign/:playlistId     change the assignment (push + bump version)
 *   POST /ctl/assign/:id?drop=1      change it but DELIBERATELY SKIP the push,
 *                                    so only pull-on-connect or reconcile can fix it
 *   POST /ctl/reconcile              answer the next heartbeat with reconcileContent
 *   GET  /ctl/log                    ordered event log for assertions
 *
 * Local only. No production URLs, no real credentials.
 */

import http from 'node:http';
import { readFileSync } from 'node:fs';
import { Server } from 'socket.io';

const API_PORT = 3000;
const RT_PORT = 3002;
const CODE = 'SMOKE1';
const TOKEN = 'smoke-device-token';
const TENANT = 'tenant-smoke';
const PAIR_AFTER_POLLS = 3;

const banner = readFileSync(new URL('../android/app/src/main/res/drawable-xhdpi/tv_banner.png', import.meta.url));

let statusPolls = 0;
let forceReconcileNext = false;
const log = [];
const record = (event, detail) => {
  const entry = { t: new Date().toISOString(), event, ...detail };
  log.push(entry);
  console.log(`[harness] ${event}`, detail ?? '');
};

/**
 * Versions are ISO-8601 max(updatedAt), matching the server resolver. They MUST
 * increase as strings — the deployed client compares with `>` (src/utils.ts:56),
 * so a version that merely CHANGES is silently ignored. Bumping by a second on
 * each assignment reproduces that contract exactly.
 */
let versionClock = Date.parse('2026-08-13T06:00:00.000Z');
const nextVersion = () => new Date((versionClock += 1000)).toISOString();

const makePlaylist = (id, label) => ({
  id,
  name: label,
  items: [
    {
      id: `item-${id}`,
      contentId: `c-${id}`,
      duration: 8,
      order: 0,
      content: {
        id: `c-${id}`,
        name: label,
        type: 'image',
        url: `http://10.0.2.2:${API_PORT}/content/test.png`,
        mimeType: 'image/png',
      },
    },
  ],
  loopPlaylist: true,
});

// Authoritative server state. The pull endpoint and every push read from HERE,
// so push and pull cannot disagree — which is the coherence property the real
// resolver is built to guarantee.
let current = { playlist: makePlaylist('pl-a', 'Playlist A'), version: nextVersion(), source: 'direct' };
let deviceSocket = null;

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const api = http.createServer((req, res) => {
  const url = req.url ?? '';

  if (req.method === 'POST' && url.startsWith('/api/v1/devices/pairing/request')) {
    statusPolls = 0;
    return json(res, 200, { success: true, data: { code: CODE, deviceId: 'dev-smoke', expiresInSeconds: 300 } });
  }

  if (req.method === 'GET' && url.startsWith('/api/v1/devices/pairing/status/')) {
    statusPolls += 1;
    if (statusPolls < PAIR_AFTER_POLLS) return json(res, 200, { success: true, data: { status: 'pending' } });
    return json(res, 200, {
      success: true,
      data: { status: 'paired', deviceToken: TOKEN, deviceId: 'dev-smoke', tenantId: TENANT },
    });
  }

  // THE ENDPOINT THAT DID NOT EXIST. Four releases of players called this and
  // got a 404, so pull-on-connect and heartbeat-reconcile were both inert.
  if (req.method === 'GET' && url.startsWith('/api/v1/devices/me/content')) {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${TOKEN}`) {
      record('pull_rejected_auth', { auth });
      return json(res, 401, { success: false, error: 'unauthorized' });
    }
    record('pull_served', { playlistId: current.playlist.id, version: current.version });
    return json(res, 200, {
      success: true,
      data: { playlist: current.playlist, source: current.source, version: current.version },
    });
  }

  if (req.method === 'GET' && url.startsWith('/api/v1/devices/auth/check')) {
    return json(res, 200, { success: true, data: { status: 'ok' } });
  }

  if (url.startsWith('/content/')) {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': banner.length });
    return res.end(banner);
  }

  // ── control plane ──────────────────────────────────────────────────────────
  if (url.startsWith('/ctl/state')) {
    return json(res, 200, {
      playlistId: current.playlist.id,
      version: current.version,
      socketConnected: Boolean(deviceSocket?.connected),
      forceReconcileNext,
    });
  }

  if (url.startsWith('/ctl/log')) return json(res, 200, log);

  if (req.method === 'POST' && url.startsWith('/ctl/assign/')) {
    const [, , , rawId] = url.split('/');
    const id = (rawId || '').split('?')[0];
    const drop = url.includes('drop=1');
    current = { playlist: makePlaylist(id, `Playlist ${id}`), version: nextVersion(), source: 'direct' };
    record('assigned', { playlistId: id, version: current.version, pushDropped: drop });

    if (drop) {
      // The whole point of the backstop: the device is NOT told. Only
      // pull-on-connect or a reconcile can bring it back to truth.
      return json(res, 200, { ok: true, pushed: false, version: current.version });
    }
    if (deviceSocket?.connected) {
      deviceSocket.emit('playlist:update', {
        playlist: current.playlist,
        version: current.version,
        source: current.source,
      });
      record('pushed', { playlistId: id, version: current.version });
      return json(res, 200, { ok: true, pushed: true, version: current.version });
    }
    return json(res, 200, { ok: true, pushed: false, reason: 'no socket', version: current.version });
  }

  if (req.method === 'POST' && url.startsWith('/ctl/reconcile')) {
    forceReconcileNext = true;
    record('reconcile_armed', {});
    return json(res, 200, { ok: true });
  }

  json(res, 404, { error: 'not found' });
});

api.listen(API_PORT, () => console.log(`[harness:api] listening on :${API_PORT}`));

const rt = http.createServer();
const io = new Server(rt, { cors: { origin: '*' } });

io.use((socket, next) => {
  if (socket.handshake.auth?.token === TOKEN) return next();
  record('handshake_rejected', { token: socket.handshake.auth?.token });
  next(new Error('unauthorized'));
});

io.on('connection', (socket) => {
  deviceSocket = socket;
  record('device_connected', { id: socket.id });

  // Initial state carries the SAME version the pull endpoint would return, so
  // push and pull reconcile to one decision rather than two that happen to agree.
  setTimeout(() => {
    socket.emit('playlist:update', {
      playlist: current.playlist,
      version: current.version,
      source: current.source,
    });
    record('initial_state_pushed', { playlistId: current.playlist.id, version: current.version });
  }, 1200);

  socket.on('heartbeat', (data, ack) => {
    const reported = data?.contentVersion ?? '(absent)';
    const drift = reported !== current.version;
    record('heartbeat', {
      reported,
      authoritative: current.version,
      drift,
      appVersion: data?.appVersion,
      screenState: data?.screenState,
    });
    if (typeof ack !== 'function') return;

    // Mirrors the real ack envelope: { success, data, timestamp }, which the
    // client unwraps at main.ts:1017.
    const shouldReconcile = forceReconcileNext || drift;
    if (shouldReconcile) record('ack_reconcile', { reported, authoritative: current.version });
    forceReconcileNext = false;
    ack({
      success: true,
      data: { nextHeartbeatIn: 15000, commands: [], reconcileContent: shouldReconcile },
      timestamp: new Date().toISOString(),
    });
  });

  socket.on('content:impression', d =>
    record('impression', { contentId: d?.contentId, pct: d?.completionPercentage, tsType: typeof d?.timestamp }),
  );
  socket.on('disconnect', r => {
    record('device_disconnected', { reason: r });
    if (deviceSocket === socket) deviceSocket = null;
  });
});

rt.listen(RT_PORT, () => console.log(`[harness:rt] socket.io listening on :${RT_PORT}`));
