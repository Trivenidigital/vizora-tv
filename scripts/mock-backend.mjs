/**
 * Minimal local mock of the Vizora backend for emulator smoke tests.
 *
 * Serves exactly what the device needs for the full loop:
 *   pair (code -> paired with tenantId) -> socket auth -> playlist push ->
 *   asset download -> heartbeats/impressions -> socket kill/recover.
 *
 * Usage:  node scripts/mock-backend.mjs
 * Device: build with `npx vite build --mode smoke` (.env.smoke points the app
 *         at http://10.0.2.2:3000 / :3002 — the emulator's host alias).
 * Safety: local only. No production URLs, no real credentials.
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

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const api = http.createServer((req, res) => {
  const url = req.url ?? '';
  console.log(`[mock:api] ${req.method} ${url}`);

  if (req.method === 'POST' && url.startsWith('/api/v1/devices/pairing/request')) {
    statusPolls = 0;
    return json(res, 200, { success: true, data: { code: CODE, deviceId: 'dev-smoke', expiresInSeconds: 300 } });
  }
  if (url.startsWith(`/api/v1/devices/pairing/status/${CODE}`)) {
    statusPolls++;
    if (statusPolls >= PAIR_AFTER_POLLS) {
      console.log('[mock:api] -> PAIRED (with tenantId)');
      return json(res, 200, {
        success: true,
        data: { status: 'paired', deviceToken: TOKEN, deviceId: 'dev-smoke', tenantId: TENANT },
      });
    }
    return json(res, 200, { success: true, data: { status: 'pending' } });
  }
  if (url.startsWith('/api/v1/devices/auth/check')) {
    return json(res, 200, { status: 'ok' });
  }
  if (url.startsWith('/content/test.png')) {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': banner.length });
    return res.end(banner);
  }
  json(res, 404, { error: 'not found' });
});

api.listen(API_PORT, () => console.log(`[mock:api] listening on :${API_PORT}`));

const rt = http.createServer();
const io = new Server(rt, { cors: { origin: '*' } });

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (token === TOKEN) return next();
  console.log('[mock:rt] rejected handshake, token =', token);
  next(new Error('unauthorized'));
});

io.on('connection', (socket) => {
  console.log('[mock:rt] device connected');
  setTimeout(() => {
    console.log('[mock:rt] pushing playlist');
    socket.emit('playlist:update', {
      playlist: {
        id: 'pl-smoke',
        name: 'Smoke',
        items: [{
          id: 'item-1', contentId: 'c-smoke', duration: 8, order: 0,
          content: {
            id: 'c-smoke', name: 'SmokeImage', type: 'image',
            url: `http://10.0.2.2:${API_PORT}/content/test.png`, mimeType: 'image/png',
          },
        }],
        loopPlaylist: true,
      },
    });
  }, 1500);

  socket.on('heartbeat', (data, ack) => {
    console.log(`[mock:rt] heartbeat state=${data?.screenState} src=${data?.playbackSource} content=${data?.currentContent?.contentId ?? '-'}`);
    if (typeof ack === 'function') ack({});
  });
  socket.on('content:impression', (d) => console.log(`[mock:rt] impression ${d?.contentId} ${d?.completionPercentage ?? ''}`));
  socket.on('disconnect', (r) => console.log('[mock:rt] device disconnected:', r));
});

rt.listen(RT_PORT, () => console.log(`[mock:rt] socket.io listening on :${RT_PORT}`));
