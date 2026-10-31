/* =========================================================
   Fynd — test helper: a throwaway SFTP server and account

   For scripts/test-rakuten-sftp.js only. Creates, on this machine:

     an account   a new, uniquely named one (fyndsftp + 10 random hex
                  characters), never an existing one: if the name is
                  taken as a user or a group, nothing is created and it
                  throws. Its password is random. No login shell
                  (nologin); its home is in a fresh temporary directory.
     a server     OpenSSH on 127.0.0.1, on a port the kernel allocated,
                  with its own host key and config. It admits only that
                  account, only by password, only to internal-sftp
                  (ForceCommand), with root login and forwarding off.

   stop() undoes all of it, and is safe to call any number of times: it
   stops the server, removes the account with its home (userdel -r) —
   only if this helper created it — and deletes the temporary directory.
   It runs on its own when the process exits, is interrupted (SIGINT,
   SIGTERM, SIGHUP) or throws, so nothing is left behind however a test
   ends. Everything is synchronous, so it also runs from an exit handler.

   accountsOtherThan(name) reads the system's account files without that
   account's lines, so a test can show nobody else was touched.

   Needs root, sshd, ssh-keygen, ssh-keyscan, useradd, userdel, chpasswd.
   ========================================================= */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const SSHD = ['/usr/sbin/sshd', '/usr/bin/sshd'].find((p) => fs.existsSync(p)) || null;
const NOLOGIN = ['/usr/sbin/nologin', '/sbin/nologin', '/bin/false'].find((p) => fs.existsSync(p));
const ACCOUNT_FILES = ['/etc/passwd', '/etc/shadow', '/etc/group', '/etc/gshadow', '/etc/subuid', '/etc/subgid'];
const NAME = /^fyndsftp[0-9a-f]{10}$/;

const run = (cmd, args, opts) => spawnSync(cmd, args, Object.assign({ encoding: 'utf8' }, opts || {}));
const have = (cmd) => run('sh', ['-c', `command -v ${cmd}`]).status === 0;

/* what this machine lacks for the helper, or [] */
function missing() {
  const out = [];
  if (!(process.getuid && process.getuid() === 0)) out.push('root');
  if (!SSHD) out.push('sshd (openssh-server)');
  ['ssh-keygen', 'ssh-keyscan', 'useradd', 'userdel', 'chpasswd', 'curl'].forEach((c) => { if (!have(c)) out.push(c); });
  return out;
}

const accountExists = (name) => run('getent', ['passwd', name]).status === 0;
const groupExists = (name) => run('getent', ['group', name]).status === 0;

/* the system's account files, without one account's own lines */
function accountsOtherThan(name) {
  return Object.fromEntries(ACCOUNT_FILES.filter((f) => fs.existsSync(f)).map((f) => [f,
    fs.readFileSync(f, 'utf8').split('\n').filter((l) => !l.startsWith(`${name}:`)).join('\n')]));
}

/* a port nobody is listening on, as the kernel hands one out */
function freePort() {
  const probe = run(process.execPath, ['-e', `const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close();});`]);
  const port = Number(probe.stdout);
  if (!Number.isInteger(port) || port <= 0) throw new Error('No free port could be allocated');
  return port;
}
const listening = (port) => run(process.execPath, ['-e', `const c=require('net').connect(${port},'127.0.0.1');c.on('connect',()=>{process.exit(0)});c.on('error',()=>process.exit(1));`]).status === 0;

/* Create the account — only a new one. Throws, creating nothing, when
   the name is malformed or already in use as a user or a group. */
function createAccount(name, home, password) {
  if (!NAME.test(name)) throw new Error(`Refusing to create ${JSON.stringify(name)}: not a fyndsftp<hex> test name`);
  if (accountExists(name) || groupExists(name)) throw new Error(`Refusing to use ${name}: that account or group already exists, and this test never reuses or changes one`);
  const made = run('useradd', ['-m', '-d', home, '-s', NOLOGIN, '-K', 'UMASK=077', '-c', 'Fynd SFTP test (temporary)', name]);
  if (made.status !== 0) throw new Error(`useradd failed: ${made.stderr.trim()}`);
  const set = run('chpasswd', [], { input: `${name}:${password}\n` });
  if (set.status !== 0) {
    run('userdel', ['-r', name]);
    throw new Error(`chpasswd failed: ${set.stderr.trim()}`);
  }
}

function start(options) {
  const opts = options || {};
  const lacking = missing();
  if (lacking.length) throw new Error(`Needs ${lacking.join(', ')}`);
  const state = { stopped: false, createdAccount: false, server: null, dir: null };
  const name = opts.name || `fyndsftp${crypto.randomBytes(5).toString('hex')}`;
  /* a password with the characters a config file has to escape */
  const password = `Fx-${crypto.randomBytes(12).toString('base64url')} "q" \\ :`;

  function stop() {
    if (state.stopped) return;
    state.stopped = true;
    if (state.server && state.server.exitCode === null && state.server.signalCode === null) {
      try { process.kill(state.server.pid, 'SIGTERM'); } catch (err) { /* already gone */ }
      for (let i = 0; i < 50 && listening(handle.port); i += 1) run('sleep', ['0.1']);
      try { process.kill(state.server.pid, 'SIGKILL'); } catch (err) { /* gone */ }
    }
    /* only the account this helper made, and only by its own name */
    if (state.createdAccount && NAME.test(name) && accountExists(name)) {
      const gone = run('userdel', ['-r', name]);
      if (gone.status !== 0 && accountExists(name)) console.error(`temp-sftp-server: couldn’t remove ${name}: ${gone.stderr.trim()}`);
    }
    if (state.dir) fs.rmSync(state.dir, { recursive: true, force: true });
    ['exit', 'SIGINT', 'SIGTERM', 'SIGHUP', 'uncaughtException'].forEach((ev) => process.removeListener(ev, handlers[ev]));
  }

  /* however the process ends, the account and the server go with it */
  const handlers = {
    exit: () => stop(),
    SIGINT: () => { stop(); process.exit(130); },
    SIGTERM: () => { stop(); process.exit(143); },
    SIGHUP: () => { stop(); process.exit(129); },
    uncaughtException: (err) => { stop(); console.error(err); process.exit(1); }
  };
  Object.entries(handlers).forEach(([ev, fn]) => process.on(ev, fn));

  const handle = { name, password, port: null, home: null, fingerprint: null, otherFingerprint: null, dir: null, stop, state };
  try {
    state.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fynd-sftp-'));
    fs.chmodSync(state.dir, 0o711); /* the account must reach its home inside */
    handle.dir = state.dir;
    handle.home = path.join(state.dir, 'home');
    const key = path.join(state.dir, 'hostkey');
    const other = path.join(state.dir, 'otherkey');
    run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key]);
    run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', other]);
    const fp = (pub) => run('ssh-keygen', ['-lf', pub, '-E', 'sha256']).stdout.split(' ')[1];
    handle.fingerprint = fp(`${key}.pub`);
    handle.otherFingerprint = fp(`${other}.pub`);
    handle.publicKey = fs.readFileSync(`${key}.pub`, 'utf8').split(' ').slice(0, 2).join(' ');

    createAccount(name, handle.home, password);
    state.createdAccount = true;
    if (opts.afterAccount) opts.afterAccount(handle);

    fs.mkdirSync('/run/sshd', { recursive: true, mode: 0o755 });
    handle.log = path.join(state.dir, 'sshd.log');
    /* the kernel's free port; another process could take it before sshd
       binds, so try a few */
    for (let attempt = 0; attempt < 5 && !handle.port; attempt += 1) {
      const port = freePort();
      const config = path.join(state.dir, 'sshd_config');
      fs.writeFileSync(config, [
        `Port ${port}`, 'ListenAddress 127.0.0.1', `HostKey ${key}`, `PidFile ${path.join(state.dir, 'sshd.pid')}`,
        `AllowUsers ${name}`, 'PermitRootLogin no', 'PubkeyAuthentication no', 'PasswordAuthentication yes',
        'KbdInteractiveAuthentication yes', 'UsePAM yes', 'DisableForwarding yes', 'PermitTTY no',
        'Subsystem sftp internal-sftp', 'ForceCommand internal-sftp', 'LogLevel VERBOSE', ''
      ].join('\n'), { mode: 0o600 });
      state.server = spawn(SSHD, ['-D', '-e', '-f', config], { stdio: ['ignore', 'ignore', fs.openSync(handle.log, 'a')] });
      for (let i = 0; i < 50 && state.server.exitCode === null && !listening(port); i += 1) run('sleep', ['0.1']);
      if (state.server.exitCode === null && listening(port)) handle.port = port;
      else { try { process.kill(state.server.pid, 'SIGKILL'); } catch (err) { /* gone */ } state.server = null; }
    }
    if (!handle.port) throw new Error(`sshd didn’t start: ${fs.existsSync(handle.log) ? fs.readFileSync(handle.log, 'utf8').slice(-500) : 'no log'}`);
    handle.pid = state.server.pid;
    return handle;
  } catch (err) {
    stop();
    throw err;
  }
}

/* write a file into the account's home, owned by it */
function put(handle, rel, data) {
  const file = path.join(handle.home, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  run('chown', ['-R', `${handle.name}:`, handle.home]);
  return file;
}

module.exports = { start, put, missing, createAccount, accountExists, groupExists, accountsOtherThan, freePort, listening, NAME };
