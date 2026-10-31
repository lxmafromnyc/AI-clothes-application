#!/usr/bin/env node
/* =========================================================
   Fynd — scripts/rakuten-sftp.sh against a real SFTP server

   A throwaway OpenSSH server and a new, uniquely named account
   (scripts/fixtures/temp-sftp-server.js: never an existing account, a
   random password, no login shell, on a port the kernel allocated), with
   a FIXTURE Rakuten feed in the account's home. Then what the
   integration does with it: lists the login directory and the root,
   fetches the whole file and a byte-range sample, hands the sample to
   scripts/rakuten-sample.js — and refuses a server whose key doesn't
   match the fingerprint before any authentication, a wrong password, a
   missing file, and paths that aren't plain.

   And the helper itself: a name already in use is refused with nothing
   changed; on success, on an uncaught error, on process.exit and on
   SIGINT, SIGTERM and SIGHUP, the server stops and the account, its
   home and its files are removed — and every other account on the
   machine is exactly as it was. (SIGKILL can't be caught: a run killed
   that way leaves its fyndsftp<hex> account to remove by hand.)

   It also pins down why rakuten-sftp.sh doesn't rely on curl's
   --hostpubsha256: with the libssh build Ubuntu ships, a wrong value
   still connects when known_hosts matches.

   Needs root, sshd (openssh-server), ssh-keyscan, ssh-keygen, useradd,
   userdel, chpasswd and curl with SFTP: CI runs it as root in its own
   job (ci.yml, "SFTP integration"). By hand:
     sudo node scripts/test-rakuten-sftp.js
   ========================================================= */

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawn, spawnSync } = require('child_process');
const server = require('./fixtures/temp-sftp-server');

const lacking = server.missing();
if (lacking.length) {
  console.log(`Needs ${lacking.join(', ')} — skipping the SFTP integration tests.`);
  process.exit(0);
}

const REPO = path.join(__dirname, '..');
const SCRIPT = path.join(__dirname, 'rakuten-sftp.sh');
const CHILD = path.join(__dirname, 'fixtures/temp-sftp-child.js');
const MID = '99999';
const SID = '88888';
const sh = (cmd, args, opts) => spawnSync(cmd, args, Object.assign({ encoding: 'utf8' }, opts || {}));
/* still running: a process that exists and isn't a zombie (one that has
   exited but whose parent — here often a container's PID 1 — hasn't
   reaped it) */
const alive = (pid) => {
  try { process.kill(pid, 0); } catch (err) { return false; }
  try { return fs.readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /s, '')[0] !== 'Z'; } catch (err) { return false; }
};

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ok    ${name}`); }
  catch (err) { failures.push(name); console.log(`  FAIL  ${name}\n        ${err && err.stack ? err.stack.split('\n').slice(0, 8).join('\n        ') : err}`); }
}

/* a FIXTURE feed, as Rakuten would deposit one */
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

/* a child process holding a server of its own, ended one way, and what it left */
function childEnding(how, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD, how], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let made = null;
    child.stderr.on('data', (d) => { err += d; });
    child.stdout.on('data', (d) => {
      out += d;
      if (!made && out.includes('\n')) {
        made = JSON.parse(out.split('\n')[0]);
        if (signal) child.kill(signal);
      }
    });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`child (${how}) didn’t end: ${err}`)); }, 60000);
    child.on('exit', (code, sig) => { clearTimeout(timer); resolve({ made, code, signal: sig, err }); });
  });
}
const leftNothing = (made, before) => {
  assert.ok(made && server.NAME.test(made.name), 'the child said what it made');
  assert.strictEqual(server.accountExists(made.name), false, `${made.name} is still an account`);
  assert.strictEqual(server.groupExists(made.name), false, `${made.name} is still a group`);
  assert.strictEqual(fs.existsSync(made.home), false, 'its home is gone');
  assert.strictEqual(fs.existsSync(made.dir), false, 'its temporary directory is gone');
  assert.strictEqual(alive(made.pid), false, 'its sshd has stopped');
  assert.strictEqual(server.listening(made.port), false, 'nothing listens on its port');
  assert.deepStrictEqual(server.accountsOtherThan(made.name), before, 'every other account is as it was');
};

(async () => {
  const name = `fyndsftp${crypto.randomBytes(5).toString('hex')}`;
  const before = server.accountsOtherThan(name);
  const h = server.start({ name });
  try {
    server.put(h, feedName, feed);
    server.put(h, `${MID}/${MID}_${SID}_cat.txt`, 'FIXTURE category list\n');
    const env = (extra) => Object.assign({ PATH: process.env.PATH, RAKUTEN_SFTP_HOST: '127.0.0.1', RAKUTEN_SFTP_PORT: String(h.port), RAKUTEN_SFTP_USER: h.name, RAKUTEN_SFTP_PASSWORD: h.password, RAKUTEN_SFTP_HOSTKEY_SHA256: h.fingerprint }, extra || {});
    const run = (args, extra) => sh('bash', [SCRIPT, ...args], { env: env(extra), timeout: 60000 });
    const logSince = (fn) => { const at = fs.readFileSync(h.log, 'utf8').length; const r = fn(); return { r, log: fs.readFileSync(h.log, 'utf8').slice(at) }; };

    console.log(`\nthe throwaway server and account (${h.name}, port ${h.port})`);

    await test('a new, uniquely named account with no login shell, on a port the kernel allocated — and it alone may log in', () => {
      assert.ok(server.NAME.test(h.name));
      const entry = sh('getent', ['passwd', h.name]).stdout.trim().split(':');
      assert.match(entry[6], /nologin|false$/);
      assert.strictEqual(entry[5], h.home);
      assert.ok(h.port > 0 && server.listening(h.port));
      const root = run(['list', '~/'], { RAKUTEN_SFTP_USER: 'root' });
      assert.notStrictEqual(root.status, 0, 'root can’t log in to it');
    });

    await test('a name already in use is refused with nothing changed — its password and files untouched; a name not of the test’s own form is refused too', () => {
      const shadowLine = () => fs.readFileSync('/etc/shadow', 'utf8').split('\n').find((l) => l.startsWith(`${h.name}:`));
      const was = shadowLine();
      assert.throws(() => server.createAccount(h.name, path.join(h.dir, 'again'), 'other'), /already exists, and this test never reuses or changes one/);
      assert.strictEqual(shadowLine(), was, 'its password wasn’t changed');
      assert.strictEqual(fs.existsSync(path.join(h.dir, 'again')), false);
      ['root', 'nobody', 'fyndsftp', 'fyndsftpZZZZZZZZZZ', `${h.name}x`].forEach((n) => assert.throws(() => server.createAccount(n, '/nonexistent', 'x'), /Refusing/, n));
      assert.strictEqual(run(['list', '~/']).status, 0, 'the account still works with its own password');
    });

    console.log('\nrakuten-sftp.sh against it');

    await test('lists the login directory with the main file and the advertiser folder, and the server root apart from it', () => {
      const r = run(['list', '~/']);
      assert.strictEqual(r.status, 0, r.stderr);
      assert.match(r.stdout, new RegExp(`${feedName}$`, 'm'));
      assert.match(r.stdout, new RegExp(`^d.* ${MID}$`, 'm'));
      assert.match(run(['list', `~/${MID}/`]).stdout, new RegExp(`${MID}_${SID}_cat\\.txt`));
      const root = run(['list', '/']);
      assert.strictEqual(root.status, 0, root.stderr);
      assert.ok(!root.stdout.includes(feedName), 'this server isn’t chrooted: "/" is not the login directory — which is what the real listing must settle');
    });

    await test('the fingerprint in any of its usual forms works; the whole file arrives byte for byte', () => {
      const raw = h.fingerprint.replace(/^SHA256:/, '');
      for (const form of [h.fingerprint, raw, `${raw}=`]) {
        const out = path.join(h.dir, 'whole.gz');
        const r = run(['fetch', `~/${feedName}`, out], { RAKUTEN_SFTP_HOSTKEY_SHA256: form });
        assert.strictEqual(r.status, 0, `${form}: ${r.stderr}`);
        assert.ok(fs.readFileSync(out).equals(feed));
      }
    });

    await test('a byte-range sample arrives, and the sample validator accepts it as a sample — never as the whole', () => {
      const out = path.join(h.dir, 'sample.gz');
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

    await test('a server presenting another key is refused before any authentication, and the keys it presented are named', () => {
      const { r, log: seen } = logSince(() => run(['list', '~/'], { RAKUTEN_SFTP_HOSTKEY_SHA256: h.otherFingerprint }));
      assert.strictEqual(r.status, 4);
      assert.ok(r.stderr.includes(`the server presented: ${h.fingerprint}`), r.stderr);
      assert.match(r.stderr, /Nothing was sent to it/);
      assert.ok(!/password for|Accepted|Failed password|authenticating/i.test(seen), `the server saw an authentication attempt:\n${seen}`);
    });

    await test('why the known_hosts route: curl (libssh) given a wrong --hostpubsha256 still connects once known_hosts matches', () => {
      const home = path.join(h.dir, 'curlhome');
      fs.mkdirSync(path.join(home, '.ssh'), { recursive: true });
      fs.writeFileSync(path.join(home, '.ssh/known_hosts'), `[127.0.0.1]:${h.port} ${h.publicKey}\n`);
      const cfg = path.join(h.dir, 'c.cfg');
      fs.writeFileSync(cfg, `user = "${h.name}:${h.password.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\n`, { mode: 0o600 });
      const r = sh('curl', ['-q', '-sS', '-K', cfg, '--hostpubsha256', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', `sftp://127.0.0.1:${h.port}/~/`], { env: { PATH: process.env.PATH, HOME: home } });
      if (/libssh\//.test(sh('curl', ['-V']).stdout)) assert.strictEqual(r.status, 0, 'this curl is libssh: --hostpubsha256 ignored, as found');
      else assert.notStrictEqual(r.status, 0, 'a libssh2 curl enforces it');
    });

    await test('a wrong password, a missing file and paths that aren’t plain each fail with their own exit code', () => {
      assert.strictEqual(run(['list', '~/'], { RAKUTEN_SFTP_PASSWORD: 'wrong' }).status, 67, 'curl: login denied');
      assert.strictEqual(run(['fetch', '~/nothing-here.gz', path.join(h.dir, 'x')]).status, 78, 'curl: remote file not found');
      ['../etc/passwd', '~/a b', '~/$(id)', '~/x;rm'].forEach((p) => assert.strictEqual(run(['fetch', p, path.join(h.dir, 'x')]).status, 2, p));
      assert.strictEqual(run(['list', '~/'], { RAKUTEN_SFTP_USER: '' }).status, 2);
    });

    await test('the credential never reaches a command line or the output, and the script leaves no file of its own behind', () => {
      const src = fs.readFileSync(SCRIPT, 'utf8').replace(/^\s*#.*$/gm, '');
      assert.ok(!/--user\b|\s-u\s/.test(src), 'no --user on curl’s command line');
      const tmpBefore = new Set(fs.readdirSync(require('os').tmpdir()));
      const r = run(['list', '~/']);
      assert.ok(!r.stdout.includes(h.password) && !r.stderr.includes(h.password));
      const added = fs.readdirSync(require('os').tmpdir()).filter((f) => !tmpBefore.has(f));
      assert.deepStrictEqual(added, [], 'its temporary directory was removed');
    });
  } finally {
    h.stop();
  }

  console.log('\ncleaning up, however a run ends');

  await test('on success: the server stops, and the account, its home and its files are removed — every other account exactly as before', () => {
    leftNothing({ name: h.name, port: h.port, pid: h.pid, home: h.home, dir: h.dir }, before);
    h.stop(); /* a second stop does nothing */
  });

  for (const [how, signal, code] of [['hold', 'SIGINT', 130], ['hold', 'SIGTERM', 143], ['hold', 'SIGHUP', 129], ['throw', null, 1], ['exit', null, 3]]) {
    await test(`${signal ? `interrupted by ${signal}` : how === 'throw' ? 'an uncaught error' : 'process.exit without stopping'}: nothing left behind, nobody else touched`, async () => {
      /* every account file, before the child made its own account */
      const others = server.accountsOtherThan('-');
      const ended = await childEnding(how, signal);
      assert.strictEqual(ended.code, code, `exit ${ended.code} ${ended.signal || ''}: ${ended.err}`);
      if (how === 'throw') assert.match(ended.err, /FIXTURE failure after setup/);
      leftNothing(ended.made, others);
    });
  }

  console.log(`\n${passed} passed, ${failures.length} failed\n`);
  process.exit(failures.length ? 1 : 0);
})();
