#!/usr/bin/env node
/**
 * One-command sideload of the Vizora display client onto a Samsung Tizen TV.
 *
 *   node scripts/install-tizen.mjs --ip 192.168.1.50 --duid-only
 *   node scripts/install-tizen.mjs --ip 192.168.1.50 --profile VizoraTV
 *
 * Automates the manual sequence in docs/SAMSUNG_LG_TV.md:
 *   connect -> read DUID -> build -> package (sign) -> install -> launch -> verify
 *
 * Prerequisites (all on the PC, not the TV):
 *   - Tizen Studio with the TV extension (provides the `tizen` and `sdb` CLIs)
 *   - A Samsung certificate profile holding this TV's DUID
 *     (Certificate Manager -> Samsung -> TV; run with --duid-only first to get it)
 *   - Developer Mode enabled on the TV (Apps panel -> 12345 -> On -> this PC's IP -> reboot)
 *
 * This script only shells out to the vendor CLIs — it cannot be exercised
 * without a TV on the network, so treat the first run as part of the test.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tizenDir = join(root, 'build', 'tizen');
const SDB_PORT = 26101;

// ---------------------------------------------------------------- args

function parseArgs(argv) {
  const opts = { build: true, duidOnly: false, launch: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--ip') opts.ip = argv[++i];
    else if (arg === '--profile') opts.profile = argv[++i];
    else if (arg === '--duid-only') opts.duidOnly = true;
    else if (arg === '--no-build') opts.build = false;
    else if (arg === '--no-launch') opts.launch = false;
    else if (arg === '-h' || arg === '--help') opts.help = true;
    else die(`Unknown argument: ${arg}`);
  }
  return opts;
}

const usage = `Usage: node scripts/install-tizen.mjs --ip <tv-ip> [options]

  --ip <addr>        TV IP address (required). Settings -> General -> Network -> Network Status
  --profile <name>   Samsung certificate profile to sign with (required unless --duid-only)
  --duid-only        Connect, print the TV's DUID, and stop. Run this first.
  --no-build         Skip \`npm run tizen:build\`; package whatever is in build/tizen/
  --no-launch        Install but do not launch the app
`;

function die(msg) {
  console.error(`\n  error  ${msg}\n`);
  process.exit(1);
}

function step(n, msg) {
  console.log(`\n[${n}] ${msg}`);
}

// ------------------------------------------------------- CLI discovery

/**
 * Tizen Studio is rarely on PATH after a default install, so fall back to the
 * documented install roots before giving up.
 */
function findCli(name) {
  const exe = process.platform === 'win32' ? `${name}.bat` : name;
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', [exe], {
    encoding: 'utf8',
  });
  if (probe.status === 0) return probe.stdout.trim().split(/\r?\n/)[0];

  const home = process.env.HOME || process.env.USERPROFILE || '';
  const roots = [
    process.env.TIZEN_STUDIO_HOME,
    join(home, 'tizen-studio'),
    join(home, 'TizenStudio'),
    '/Applications/tizen-studio',
    'C:\\tizen-studio',
  ].filter(Boolean);

  // `tizen` lives in tools/ide/bin, `sdb` in tools/.
  for (const r of roots) {
    for (const rel of [join('tools', 'ide', 'bin', exe), join('tools', exe)]) {
      const candidate = join(r, rel);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function run(cmd, args, { capture = false, allowFail = false } = {}) {
  const res = spawnSync(cmd, args, {
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    shell: process.platform === 'win32',
  });
  if (res.error) die(`Failed to run ${cmd}: ${res.error.message}`);
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  if (res.status !== 0 && !allowFail) {
    if (capture) console.error(out);
    die(`${cmd} ${args.join(' ')} exited with code ${res.status}`);
  }
  return { code: res.status, out };
}

// ------------------------------------------------------------- helpers

function appIdFromConfig() {
  const xml = readFileSync(join(root, 'tizen', 'config.xml'), 'utf8');
  const match = xml.match(/<tizen:application[^>]*\bid="([^"]+)"/);
  if (!match) die('Could not read the application id from tizen/config.xml');
  return match[1];
}

/** `sdb devices` lists connected targets; the name is what `tizen -t` wants. */
function resolveTarget(sdb, ip) {
  const { out } = run(sdb, ['devices'], { capture: true, allowFail: true });
  const lines = out
    .split(/\r?\n/)
    .filter((l) => l.trim() && !/List of devices/i.test(l));
  for (const line of lines) {
    const [serial, state, name] = line.trim().split(/\s{1,}/);
    if (!serial || state !== 'device') continue;
    if (serial.startsWith(ip)) return name || serial;
  }
  die(
    `TV ${ip} is not showing as a connected device.\n` +
      '         Check Developer Mode is on (Apps panel -> 12345), that this PC\'s IP is\n' +
      '         listed there, and that the TV was rebooted after enabling it.',
  );
}

function newestWgt() {
  if (!existsSync(tizenDir)) return null;
  const wgts = readdirSync(tizenDir)
    .filter((f) => f.endsWith('.wgt'))
    .map((f) => ({ path: join(tizenDir, f), mtime: statSync(join(tizenDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return wgts.length ? wgts[0].path : null;
}

// ---------------------------------------------------------------- main

const opts = parseArgs(process.argv.slice(2));
if (opts.help) {
  console.log(usage);
  process.exit(0);
}
if (!opts.ip) die(`--ip is required.\n${usage}`);
if (!opts.duidOnly && !opts.profile) {
  die(
    'A signing profile is required.\n' +
      '         Run with --duid-only first, add the DUID to a Samsung TV certificate\n' +
      '         profile in Certificate Manager, then re-run with --profile <name>.',
  );
}

const sdb = findCli('sdb') || die('sdb not found. Install Tizen Studio, or set TIZEN_STUDIO_HOME.');
const tizen =
  findCli('tizen') || die('tizen CLI not found. Install the Tizen Studio TV extension.');

step(1, `Connecting to ${opts.ip}:${SDB_PORT}`);
const connect = run(sdb, ['connect', `${opts.ip}:${SDB_PORT}`], { capture: true, allowFail: true });
process.stdout.write(connect.out);
if (/failed|unable|refused/i.test(connect.out)) {
  die(
    `Could not reach the TV at ${opts.ip}.\n` +
      '         Developer Mode must be ON with this PC\'s IP registered, and the TV\n' +
      '         must have been rebooted since. Both devices on the same subnet.',
  );
}

const target = resolveTarget(sdb, opts.ip);
console.log(`    target: ${target}`);

step(2, 'Reading the TV DUID');
const duid = run(sdb, ['shell', '0', 'getduid'], { capture: true }).out.trim();
console.log(`    DUID: ${duid}`);
console.log(
  '    Add this to your Samsung TV certificate profile (Certificate Manager ->\n' +
    '    Samsung -> TV). One profile holds ~10 DUIDs by hand, up to 50 via a list file,\n' +
    '    so a single signed .wgt covers a batch of TVs.',
);

if (opts.duidOnly) {
  console.log('\n--duid-only: stopping here.\n');
  process.exit(0);
}

if (opts.build) {
  step(3, 'Building the TV bundle (npm run tizen:build)');
  run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'tizen:build']);
} else {
  step(3, 'Skipping build (--no-build)');
  if (!existsSync(join(tizenDir, 'index.html'))) {
    die('build/tizen/ is missing or incomplete — drop --no-build.');
  }
}

step(4, `Packaging and signing with profile "${opts.profile}"`);
const pkg = run(tizen, ['package', '-t', 'wgt', '-s', opts.profile, '--', tizenDir], {
  capture: true,
  allowFail: true,
});
process.stdout.write(pkg.out);
if (pkg.code !== 0) {
  if (/profile|certificate/i.test(pkg.out)) {
    const { out } = run(tizen, ['security-profiles', 'list'], { capture: true, allowFail: true });
    console.error(`\n    Available profiles:\n${out}`);
  }
  die('Packaging failed — see the output above.');
}

const wgt = newestWgt() || die('No .wgt produced in build/tizen/.');
console.log(`    package: ${wgt}`);

step(5, 'Installing on the TV');
run(tizen, ['install', '-n', wgt, '-t', target]);

const appId = appIdFromConfig();

if (opts.launch) {
  step(6, `Launching ${appId}`);
  run(tizen, ['run', '-t', target, '-p', appId]);
}

step(7, 'Verifying the app is installed');
const applist = run(sdb, ['shell', '0', 'applist'], { capture: true, allowFail: true });
const installed = applist.out.includes(appId);
console.log(installed ? `    OK — ${appId} is installed.` : `    Could not confirm ${appId} in applist; check the TV.`);

console.log(`
Next, by hand on the TV — this is the part that decides unattended deployment:

  1. Leave Vizora as the foreground app.
  2. Settings -> General & Privacy -> Start Screen Options -> enable "Autorun Last App".
  3. Power off with the remote, power on. Did Vizora come back on its own?   (gate C)
  4. Repeat 3-4 times. Intermittent counts as a fail.
  5. Pull the AC power, reconnect, power on. Same question.
  6. Disconnect this PC from the network, repeat 3 and 5.

  Record separately: is the app still installed (gate A), and did it return
  without touching the remote (gate C)?
`);
