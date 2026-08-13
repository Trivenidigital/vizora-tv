# Gate 2 — production paired-device acceptance runbook

Prepared 2026-08-13 so the whole acceptance can be completed in **one controlled run**
once a human re-pairs TV1 or Lobby. Everything that can be established without touching
a panel is established below; what remains genuinely needs the physical device.

**Publication of 1.3.14 is NOT authorised by this runbook.** This gate proves the
deployed backend + the paired client converge. Publishing is a separate operator decision.

---

## 0. State already verified (no device needed)

| Fact | Evidence | When |
|---|---|---|
| Backend is deployed at current `main` | `/opt/vizora/app` git HEAD = `69e02244` = `origin/main` | 2026-08-13 |
| Vizora#294 (heartbeat DTO) is in the deployed tree | `42149be6` is an ancestor of HEAD | " |
| Vizora#297 (T2 resolver + pull endpoint) is in | `9828b53d` is an ancestor of HEAD | " |
| Vizora#300 (+`a7a11d30` fixes) is in | `6ab40fc0` / `a7a11d30` on the log | " |
| `GET /api/v1/devices/me/content` **exists** | returns **401** `Device authentication required` | " |
| …and is a real route, not a blanket 401 | negative control: `/api/v1/devices/me/definitely-not-a-route` → **404** `Cannot GET …` | " |
| …and the guard actually parses tokens | garbage bearer → 401 `Invalid or expired device token` | " |
| `GET /api/v1/devices/auth/check` exists | 401 unauthenticated | " |
| Services healthy | `/api/v1/health` → `{status:ok, database:connected}`; PM2: middleware ×2, realtime, all online | " |
| `/tv` still serves **1.3.13 / 10143** | fetched page markup | " |

**This supersedes the closure ledger's `#256 → 404` finding, which is now STALE.**
The endpoint that 404'd is live. Ledger corrected.

---

## 1. Fleet state — why the acceptance needs a re-pair

Queried from prod Postgres (`devices`), read-only:

- **24 devices, all `status=offline`.**
- **Zero heartbeats since the realtime service started** (`created at 2026-08-13T07:40:58Z`).
- Most recent heartbeat of *any* device: `MOBILE`, 2026-08-12 14:48Z (~25 h ago).
- `content_impressions`: **0 rows.**

| device | last heartbeat | paired | playlist assigned? |
|---|---|---|---|
| **TV1** | 2026-02-19 01:08 | 2026-02-18 22:51 | **no** |
| **Lobby** | 2026-02-19 01:16 | 2026-02-19 01:09 | **no** |

Both are ~6 months past pairing, well beyond the 90-day token expiry, so both are
rejected at the handshake before any of this code runs. **No release and no deployment
recovers them** — the refresh path requires a *live authenticated socket* and returns
early when `msUntilExpiry <= 0`. Re-pairing is the only route.

### Read this before interpreting step 10

`0 of 24 devices carry `metadata.appVersion`` — the same count as before Vizora#294
merged. That is **fully explained by zero heartbeats since deploy** and is *not*
evidence the fix is broken. It is equally **not evidence it works**. appVersion
persistence is unproven at runtime in production; step 10 is the first real test of it.
Do not record it as verified on any weaker basis.

---

## 2. What needs a human

1. **Physically re-pair TV1 or Lobby** (install/open the app, read the code off the panel).
2. **Dashboard login** — pairing completion and playlist assignment are `admin/manager`
   REST routes; there is no agent-usable credential. Both devices also have **no playlist
   assigned**, so one must be attached for steps 3–5 to mean anything.

Everything else below is scripted or a read-only query.

---

## 3. The sequence

Record `DEVICE_ID`, and the UTC timestamp of each step, so the chain can be correlated
end to end.

| # | Step | Pass condition | How to verify |
|---|---|---|---|
| 1 | Pair / re-pair the device | device authenticates | `devices.status='online'`, fresh `pairedAt` |
| 2 | Authenticated content pull | **200** with resolver-backed content | see §4 probe A |
| 3 | Expected playlist renders | correct content on glass | photograph the panel |
| 4 | Change the assigned playlist (dashboard) | assignment persisted | `devices.currentPlaylistId` changed |
| 5 | Change reaches the TV over realtime | new playlist on glass without restart | panel + `playlist:update` in realtime logs |
| 6 | Simulate a **missed** push | device not told | see §4 probe C |
| 7 | Heartbeat reconcile repairs the drift | ack carries `reconcileContent:true`, device pulls | realtime log + an access-log hit on `/devices/me/content` |
| 8 | Restart / relaunch the app | app comes back paired | panel |
| 9 | Pull-on-connect restores authoritative state | correct playlist **before** any push | `/devices/me/content` hit right after connect |
| 10 | Heartbeat records a **non-zero** appVersion | `metadata->>'appVersion'` is set and non-zero | see §4 probe B |
| 11 | A real impression reaches durable storage | `content_impressions` row count **> 0** | see §4 probe B |
| 12 | Healthy after reconnect/restart | no persistent "connection failed"; no stale playlist winning; no unexpected pairing purge | panel + `AuditLog` |

Steps 6–7 are the tester's original symptom, deliberately induced. Step 9 is the second,
independent recovery path (pull-on-connect) — both must work on their own.

---

## 4. Evidence probes (read-only, copy-paste)

All three go through the two-step SSH pattern: redirect to a file, then read it.

**Probe A — the authenticated pull.** Needs the device JWT. Run it *on the panel's
behalf* from the VPS so the token never lands in a durable record:

```bash
# NOTE: do not paste the token into any file that gets committed.
ssh -o KexAlgorithms=curve25519-sha256 root@89.167.55.176 \
  'curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $DEV_TOKEN" \
     http://localhost:3000/api/v1/devices/me/content' > .ssh_out.txt 2>&1
```

Expect **200**. A 401 means the pairing did not take; a 404 would mean the deploy regressed.

**Probe B — fleet truth after the run:**

```bash
ssh -o KexAlgorithms=curve25519-sha256 root@89.167.55.176 'PW=$(grep -m1 "^DATABASE_URL" /opt/vizora/app/.env | sed -E "s#.*://[^:]+:([^@]*)@.*#\1#");
docker exec -e PGPASSWORD="$PW" vizora-postgres psql -U postgres -d vizora -t -A -F"|" -c
"SELECT nickname, status, \"lastHeartbeat\", coalesce(metadata->>'"'"'appVersion'"'"','"'"'-'"'"')
   FROM devices WHERE nickname IN ('"'"'TV1'"'"','"'"'Lobby'"'"');";
docker exec -e PGPASSWORD="$PW" vizora-postgres psql -U postgres -d vizora -t -A -c
"SELECT count(*) FROM content_impressions;"' > .ssh_out.txt 2>&1
```

Pass: `status=online`, `lastHeartbeat` within the last minute, **appVersion non-empty and
non-zero**, impressions count **> 0**.

**Probe C — inducing a missed push (step 6).** Cleanest non-destructive method: change
the assignment while the panel's socket is down (pull the network for ~30 s, reassign,
restore). The device then holds a stale `contentVersion` with no push having reached it,
which is exactly the state step 7 must repair. Reassigning while connected would be
repaired by the push itself and would not test reconcile.

**Realtime logs for steps 5/7/9:**

```bash
ssh -o KexAlgorithms=curve25519-sha256 root@89.167.55.176 \
  'pm2 logs vizora-realtime --lines 300 --nostream' > .ssh_out.txt 2>&1
```

---

## 5. Recording rules

- Correlate: `pair/auth → pull → resolver → render → reassignment → realtime/reconcile → restart/pull → heartbeat → impression`, each with a UTC timestamp and the device id.
- **Never** put a device JWT, the DB password, or any bearer token in a durable record.
  Device **id** and **nickname** are fine.
- A step that cannot be run is recorded as **NOT RUN**, never inferred from an adjacent
  step passing. Step 10 in particular: the appVersion column being non-empty is the only
  acceptable evidence.

---

## 6. Devices needing re-pair regardless

All 24 are offline and every one predates the deploy. TV1 and Lobby are the two chosen
for acceptance because they are named, non-test panels. The remaining roster is mostly
`Smoke Display` / `QA Test TV` / `E2E …` scratch entries plus `MOBILE`, `Home`,
`Counter 1`, `Surya`, `Moto`.

1.3.14 **cannot** remotely recover any hard-expired credential — the refresh path needs a
live authenticated socket, and an expired token is rejected at the handshake before it.
Its value here is preventing *future* stranding, plus release provenance.
