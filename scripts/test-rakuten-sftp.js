#!/usr/bin/env node
/* =========================================================
   Fynd — scripts/rakuten-sftp.sh against a real SFTP server

   Starts a throwaway OpenSSH server on 127.0.0.1 (its own host key, its
   own config, a test user with an invented password), puts a FIXTURE
   Rakuten feed in its login directory, and checks what the integration
   does with it: lists the login directory and the root, fetches the
   whole file and a byte-range sample, and hands the sample to
   scripts/rakuten-sample.js — and refuses a server whose key doesn't
   match the fingerprint before a password is sent, a wrong password,
   a missing file, and paths that aren't plain.

   It also pins down why rakuten-sftp.sh doesn't rely on curl's
   --hostpubsha256: with the libssh build Ubuntu ships, a wrong value
   still connects when known_hosts matches.

   Needs root (to add the test user), sshd (openssh-server), ssh-keyscan,
   ssh-keygen and curl with SFTP; it says so and exits without a count
   when they are missing, so CI lists it in NOT_RUN. Run by hand:
     sudo node scripts/test-rakuten-sftp.js
   ========================================================= */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawnSync, spawn } = require('child_process');

const REPO = path.join(__dirname, '..');
const SCRIPT = path.join(__dirname, 'rakuten-sftp.sh');
const PORT = 2299;
const USER = 'fyndsftptest';
const PASS = 'FIXTURE local "only" \\ pass';
const MID = '99999';
const SID = '88888';

const have = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0;
const sshd = ['/usr/sbin/sshd', '/usr/bin/sshd'].find((p) => fs.existsSync(p));
if (process.getuid && process.getuid() !== 0 || !sshd || !['ssh-keyscan', 'ssh-keygen', 'curl', 'useradd', 'chpasswd'].every(have)) {
  console.log('Needs root, sshd, ssh-keyscan, ssh-keygen and curl with SFTP — skipping the SFTP integration tests.');
  process.exit(0);
}

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok    ${name}`); }
  catch (err) { failures.push(name); console.log(`  FAIL  ${name}\n        ${err && err.stack ? err.stack.split('\n').slice(0, 8).join('\n        ') : err}`); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fynd-sftp-'));
const sh = (cmd, args, opts) => spawnSync(cmd, args, Object.assign({ encoding: 'utf8' }, opts || {}));
sh('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(tmp, 'hostkey')]);
sh('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(tmp, 'otherkey')]);
const fpOf = (pub) => sh('ssh-keygen', ['-lf', pub, '-E', 'sha256']).stdout.split(' ')[1];
const FP = fpOf(path.join(tmp, 'hostkey.pub'));
const OTHER = fpOf(path.join(tmp, 'otherkey.pub'));

if (sh('id', [USER]).status !== 0) sh('useradd', ['-m', USER]);
sh('chpasswd', [], { input: `${USER}:${PASS}\n` });
const home = sh('sh', ['-c', `getent passwd ${USER} | cut -d: -f6`]).stdout.trim();
fs.mkdirSync('/run/sshd', { recursive: true });
const log = path.join(tmp, 'sshd.log');
fs.writeFileSync(path.join(tmp, 'sshd_config'), [`Port ${PORT}`, 'ListenAddress 127.0.0.1', `HostKey ${path.join(tmp, 'hostkey')}`, 'PasswordAuthentication yes',
  'KbdInteractiveAuthentication yes', 'UsePAM yes', `PidFile ${path.join(tmp, 'sshd.pid')}`, 'Subsystem sftp internal-sftp', 'LogLevel VERBOSE', ''].join('\n'));
const server = spawn(sshd, ['-D', '-e', '-f', path.join(tmp, 'sshd_config')], { stdio: ['ignore', 'ignore', fs.openSync(log, 'a')] });

/* a FIXTURE feed in the login directory, as Rakuten would deposit one */
const lines = [];
for (let i = 0; i < 4000; i += 1) {
  const c = `E98${String(i).padStart(4, '0')}-000`;
  for (const size of ['S', 'M', 'L']) {
    const f = new Array(38).fill('');
    Object.assign(f, { 0: String(700000 + i), 1: `FIXTURE Crew Neck T-Shirt ${i}`, 2: `${c.slice(1, 7)}-00-${size}`, 3: 'Men', 4: 'Tops~~T-Shirts',
      5: `https://click.linksynergy.com/link?id=FIXTUREID&offerid=${MID}.1&type=15&murl=${encodeURIComponent(`https://www.uniqlo.com/us/en/products/${c}/00`)}`,
      6: `https://image.uniqlo.com/UQ/ST3/AsianCommon/imagesgoods/${c.slice(1, 7)}/item/goodsimages/goods_00_${c.slice(1, 7)}_3x4.jpg`,
      13: '14.90', 16: 'UNIQLO', 22: 'in-stock', 24: '60', 25: 'USD', 29: 'T-Shirts', 30: size, 32: '00 WHITE', 33: 'Male', 35: 'Adult' });
    lines.push(f.join('|'));
  }
}
const feedName = `${MID}_${SID}_mp.txt.gz`;
const feed = zlib.gzipSync(Buffer.from([`HDR|${MID}|FIXTURE UNIQLO USA|10/30/2026 06:00:00`, ...lines, `TRL|${lines.length}`].join('\n')));
fs.writeFileSync(path.join(home, feedName), feed);
fs.mkdirSync(path.join(home, MID), { recursive: true });
fs.writeFileSync(path.join(home, MID, `${MID}_${SID}_cat.txt`), 'FIXTURE category list\n');

const env = (extra) => Object.assign({ PATH: process.env.PATH, RAKUTEN_SFTP_HOST: '127.0.0.1', RAKUTEN_SFTP_PORT: String(PORT), RAKUTEN_SFTP_USER: USER, RAKUTEN_SFTP_PASSWORD: PASS, RAKUTEN_SFTP_HOSTKEY_SHA256: FP }, extra || {});
const run = (args, extra) => sh('bash', [SCRIPT, ...args], { env: env(extra), timeout: 60000 });
const logSince = (fn) => { const before = fs.readFileSync(log, 'utf8').length; const r = fn(); return { r, log: fs.readFileSync(log, 'utf8').slice(before) }; };

/* wait for the server to answer */
for (let i = 0; i < 50 && sh('ssh-keyscan', ['-T', '2', '-p', String(PORT), '127.0.0.1']).stdout.trim() === ''; i += 1) sh('sleep', ['0.2']);

console.log('\nrakuten-sftp.sh against a real SFTP server');

test('lists the login directory with the main file and the advertiser folder, and the server root apart from it', () => {
  const r = run(['list', '~/']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`${feedName}$`, 'm'));
  assert.match(r.stdout, new RegExp(`^d.* ${MID}$`, 'm'));
  const folder = run(['list', `~/${MID}/`]);
  assert.match(folder.stdout, new RegExp(`${MID}_${SID}_cat\\.txt`));
  const root = run(['list', '/']);
  assert.strictEqual(root.status, 0, root.stderr);
  assert.ok(!root.stdout.includes(feedName), 'this server isn’t chrooted: "/" is not the login directory — which is what the real listing must settle');
});

test('the fingerprint in any of its usual forms works; the whole file arrives byte for byte', () => {
  const raw = FP.replace(/^SHA256:/, '');
  for (const form of [FP, raw, `${raw}=`]) {
    const out = path.join(tmp, 'whole.gz');
    const r = run(['fetch', `~/${feedName}`, out], { RAKUTEN_SFTP_HOSTKEY_SHA256: form });
    assert.strictEqual(r.status, 0, `${form}: ${r.stderr}`);
    assert.ok(fs.readFileSync(out).equals(feed));
  }
});

test('a byte-range sample arrives, and the sample validator accepts it as a sample — never as the whole', () => {
  const out = path.join(tmp, 'sample.gz');
  const r = run(['fetch', `~/${feedName}`, out, '40000']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(fs.statSync(out).size, 40000);
  assert.match(r.stdout, /at most 40000: a sample/);
  const v = sh(process.execPath, [path.join(__dirname, 'rakuten-sample.js'), '--file', out, '--mid', MID, '--licensed', 'images,sizes,price', '--json'], { cwd: REPO });
  assert.strictEqual(v.status, 0, v.stdout.slice(0, 2000));
  const report = JSON.parse(v.stdout);
  assert.deepStrictEqual([report.verdict, report.mode, report.gzip], ['accepted', 'sample', 'cut off']);
  assert.ok(report.import.products > 0 && report.import.products < 4000);
});

test('a server presenting another key is refused before any password is sent, and the keys it presented are named', () => {
  const { r, log: seen } = logSince(() => run(['list', '~/'], { RAKUTEN_SFTP_HOSTKEY_SHA256: OTHER }));
  assert.strictEqual(r.status, 4);
  assert.match(r.stderr, new RegExp(`the server presented: ${FP.replace(/[+/]/g, (c) => `\\${c}`)}`));
  assert.match(r.stderr, /Nothing was sent to it/);
  assert.ok(!/password for|Accepted|Failed password|authenticating/i.test(seen), `the server saw an authentication attempt:\n${seen}`);
});

test('why the known_hosts route: curl (libssh) given a wrong --hostpubsha256 still connects once known_hosts matches', () => {
  const h = path.join(tmp, 'curlhome');
  fs.mkdirSync(path.join(h, '.ssh'), { recursive: true });
  fs.writeFileSync(path.join(h, '.ssh/known_hosts'), `[127.0.0.1]:${PORT} ${fs.readFileSync(path.join(tmp, 'hostkey.pub'), 'utf8').split(' ').slice(0, 2).join(' ')}\n`);
  const cfg = path.join(tmp, 'c.cfg');
  fs.writeFileSync(cfg, `user = "${USER}:${PASS.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\n`, { mode: 0o600 });
  const r = sh('curl', ['-q', '-sS', '-K', cfg, '--hostpubsha256', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', `sftp://127.0.0.1:${PORT}/~/`], { env: { PATH: process.env.PATH, HOME: h } });
  const libssh = /libssh\//.test(sh('curl', ['-V']).stdout);
  if (libssh) assert.strictEqual(r.status, 0, 'this curl is libssh: --hostpubsha256 ignored, as found');
  else assert.notStrictEqual(r.status, 0, 'a libssh2 curl enforces it');
});

test('a wrong password, a missing file and paths that aren’t plain each fail with their own exit code', () => {
  assert.strictEqual(run(['list', '~/'], { RAKUTEN_SFTP_PASSWORD: 'wrong' }).status, 67, 'curl: login denied');
  assert.strictEqual(run(['fetch', '~/nothing-here.gz', path.join(tmp, 'x')]).status, 78, 'curl: remote file not found');
  ['../etc/passwd', '~/a b', '~/$(id)', '~/x;rm'].forEach((p) => assert.strictEqual(run(['fetch', p, path.join(tmp, 'x')]).status, 2, p));
  assert.strictEqual(run(['list', '~/'], { RAKUTEN_SFTP_USER: '' }).status, 2);
});

test('the credential never reaches a command line, and nothing it wrote is left behind', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  assert.ok(!/--user\b|-u\s/.test(src.replace(/^#.*$/gm, '')), 'no --user on curl’s command line');
  const r = run(['list', '~/']);
  assert.ok(!r.stdout.includes(PASS) && !r.stderr.includes(PASS));
  const leftovers = fs.readdirSync(os.tmpdir()).filter((f) => /^tmp\./.test(f) && fs.existsSync(path.join(os.tmpdir(), f, 'curl.cfg')));
  assert.deepStrictEqual(leftovers, []);
});

server.kill();
fs.rmSync(tmp, { recursive: true, force: true });
fs.rmSync(path.join(home, feedName), { force: true });
fs.rmSync(path.join(home, MID), { recursive: true, force: true });
console.log(`\n${passed} passed, ${failures.length} failed\n`);
process.exit(failures.length ? 1 : 0);
