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

   stop() undoes all of it, and is safe to call any number of times:
     1. ends every process still running as the account — an open SFTP
        session's sshd child, for one — by its UID, recorded when this
        helper created the account: SIGTERM, then SIGKILL after a bounded
        wait, then waits until none is left. Nothing of any other
        account is signalled: each process's owner is read again from
        /proc just before it is. This comes before the server stops, so
        the root sshd process above each session is still there to reap
        it (a container's PID 1 may reap nothing).
     2. stops the server;
     3. removes the account with its home (userdel -r) — only if this
        helper created it;
     4. deletes the temporary directory.
   If the account can't be removed — a process that won't end, userdel
   failing — stop() throws, naming why, and every later call throws the
   same; it is never reported as cleaned up. It runs on its own when the
   process exits, is interrupted (SIGINT, SIGTERM, SIGHUP) or throws, so
   nothing is left behind however a test ends, and a cleanup failure
   there makes the process exit 1. Everything is synchronous, so it also
   runs from an exit handler.

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
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/* a process's real, effective, saved and filesystem UIDs and its state,
   from /proc, or null once it is gone */
function owner(pid) {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const uids = ((/^Uid:\s+(.*)$/m.exec(status) || [])[1] || '').trim().split(/\s+/).map(Number);
    return { uids, state: ((/^State:\s+(\S)/m.exec(status) || [])[1]) || '?' };
  } catch (err) { return null; }
}

/* every process any of whose UIDs is `uid` (zombies too: userdel counts them) */
function processesOf(uid) {
  if (!Number.isInteger(uid) || uid <= 0) throw new Error(`Refusing to look for the processes of UID ${uid}`);
  return fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)).map(Number)
    .filter((pid) => pid !== process.pid)
    .map((pid) => ({ pid, o: owner(pid) }))
    .filter(({ o }) => o && o.uids.includes(uid))
    .map(({ pid, o }) => ({ pid, state: o.state }));
}

/* End every process wholly owned by `uid` (never root's, never another
   account's, never one only partly the account's):
   SIGTERM, up to graceMs to go; then SIGKILL, up to killMs; returns any
   still there (a zombie whose parent never reaps it, say) */
function endProcessesOf(uid, options) {
  const opts = Object.assign({ graceMs: 3000, killMs: 3000 }, options || {});
  const signal = (sig) => processesOf(uid).forEach(({ pid }) => {
    /* its owner read again, just before: a PID can be reused */
    /* only a process wholly the account's: every one of its UIDs; one
       that is partly another's (root's, say) is never signalled, and is
       reported as left over instead */
    const o = owner(pid);
    if (o && o.uids.length && o.uids.every((u) => u === uid)) { try { process.kill(pid, sig); } catch (err) { /* gone */ } }
  });
  const waitGone = (ms) => { const until = Date.now() + ms; while (processesOf(uid).length && Date.now() < until) sleep(50); return processesOf(uid); };
  if (!processesOf(uid).length) return [];
  signal('SIGTERM');
  if (!waitGone(opts.graceMs).length) return [];
  signal('SIGKILL');
  return waitGone(opts.killMs);
}

/* Remove the account this helper made, or throw saying why not */
function removeAccount(name, deps) {
  const d = Object.assign({ run, exists: accountExists }, deps || {});
  if (!NAME.test(name)) throw new Error(`Refusing to remove ${JSON.stringify(name)}: not a fyndsftp<hex> test name`);
  if (!d.exists(name)) return;
  const gone = d.run('userdel', ['-r', name]);
  /* userdel -r exits 12 when only the mail spool was missing; the account itself is what counts */
  if (d.exists(name)) throw new Error(`couldn’t remove the temporary account ${name}: userdel exited ${gone.status}: ${String(gone.stderr || '').trim()}`);
}
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
  const state = { stopped: false, createdAccount: false, uid: null, server: null, dir: null, error: null };
  const name = opts.name || `fyndsftp${crypto.randomBytes(5).toString('hex')}`;
  /* a password with the characters a config file has to escape */
  const password = `Fx-${crypto.randomBytes(12).toString('base64url')} "q" \\ :`;

  function stopServer() {
    if (state.server && state.server.exitCode === null && state.server.signalCode === null) {
      try { process.kill(state.server.pid, 'SIGTERM'); } catch (err) { /* already gone */ }
      for (let i = 0; i < 50 && listening(handle.port); i += 1) sleep(100);
      try { process.kill(state.server.pid, 'SIGKILL'); } catch (err) { /* gone */ }
    }
  }

  function stop() {
    if (state.stopped) { if (state.error) throw state.error; return; }
    state.stopped = true;
    const problems = [];
    /* only the account this helper made: its sessions first, while their
       root sshd parents can still reap them */
    if (state.createdAccount && Number.isInteger(state.uid) && state.uid > 0) {
      const left = endProcessesOf(state.uid, opts.timeouts);
      if (left.length) problems.push(`processes of ${name} (UID ${state.uid}) would not end: ${left.map((p) => `${p.pid} (${p.state})`).join(', ')}`);
    }
    stopServer();
    if (state.createdAccount && Number.isInteger(state.uid) && state.uid > 0) {
      /* anything that started while the server stopped */
      const late = endProcessesOf(state.uid, opts.timeouts);
      if (late.length && !problems.length) problems.push(`processes of ${name} (UID ${state.uid}) would not end: ${late.map((p) => `${p.pid} (${p.state})`).join(', ')}`);
      try { removeAccount(name); } catch (err) { problems.push(err.message); }
    }
    if (state.dir) fs.rmSync(state.dir, { recursive: true, force: true });
    ['exit', 'SIGINT', 'SIGTERM', 'SIGHUP', 'uncaughtException'].forEach((ev) => process.removeListener(ev, handlers[ev]));
    if (problems.length) {
      state.error = new Error(`temp-sftp-server: cleanup failed — ${problems.join('; ')}. Remove it by hand: userdel -r ${name}`);
      throw state.error;
    }
  }

  /* however the process ends, the account and the server go with it; a
     cleanup that fails there makes the process exit 1, saying why */
  const stopped = () => { try { stop(); return true; } catch (err) { console.error(err.message); return false; } };
  const handlers = {
    exit: () => { if (!stopped()) process.exitCode = 1; },
    SIGINT: () => process.exit(stopped() ? 130 : 1),
    SIGTERM: () => process.exit(stopped() ? 143 : 1),
    SIGHUP: () => process.exit(stopped() ? 129 : 1),
    uncaughtException: (err) => { stopped(); console.error(err); process.exit(1); }
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
    /* the UID this helper's account was given: the only one whose
       processes stop() will ever signal */
    const uid = Number(run('id', ['-u', name]).stdout.trim());
    if (!Number.isInteger(uid) || uid <= 0) throw new Error(`The new account ${name} has no usable UID (${uid})`);
    state.uid = uid;
    handle.uid = uid;
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
    try { stop(); } catch (cleanup) { err.message += ` (and ${cleanup.message})`; }
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

module.exports = { start, put, missing, createAccount, removeAccount, endProcessesOf, processesOf, accountExists, groupExists, accountsOtherThan, freePort, listening, NAME };
