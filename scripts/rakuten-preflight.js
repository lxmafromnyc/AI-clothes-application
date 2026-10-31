#!/usr/bin/env node
/* =========================================================
   Fynd — preflight for UNIQLO's Rakuten Product Catalog over SFTP

   Before anything connects: is everything the SFTP download needs set,
   and in a shape that can work? Reads the environment only — nothing is
   fetched, nothing written but GITHUB_OUTPUT when asked — and never
   prints a credential, its length, or any part of it.

     RAKUTEN_SFTP_USER            secret    set, one word, no ":"
     RAKUTEN_SFTP_PASSWORD        secret    set, one line
     RAKUTEN_UNIQLO_MID           variable  UNIQLO USA's advertiser ID: digits
     RAKUTEN_SID                  variable  Fynd's publisher site ID: digits
     RAKUTEN_SFTP_HOSTKEY_SHA256  variable  the server's host key fingerprint,
                                            from Rakuten (never first use):
                                            SHA256:<base64>, with or without
                                            the prefix and padding — 32 bytes
     RAKUTEN_SFTP_DIR             variable  optional: the directory holding
                                            the main files, once the real
                                            listing has shown it: "/" (the
                                            server root, the default), "~/"
                                            (the login directory) or a folder
                                            under either, ending in "/"
     UNIQLO_FEED_LICENSED_FIELDS  variable  optional: what the licence covers
                                            (images, colours, sizes, price,
                                            stock, description); empty keeps
                                            only the core fields
   and the server host recorded in api/_catalog/sources/uniqlo-us.js
   (RAKUTEN.host) — never taken from the environment.

   With --tools, it also checks the machine: curl built with SFTP, and
   ssh-keyscan and ssh-keygen, which scripts/rakuten-sftp.sh uses to
   accept only a host key matching the fingerprint.

   Usage:
     node scripts/rakuten-preflight.js [--tools] [--json] [--github-output]
   Exit 0 when ready, 1 when not (each problem named), 2 on a usage error.
   ========================================================= */

'use strict';

const fs = require('fs');
const { spawnSync } = require('child_process');
const adapter = require('../api/_catalog/sources/uniqlo-us');
const { LICENSABLE } = require('../api/_catalog/product');

const DIGITS = /^\d{1,12}$/;
const HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const DIR = /^(?:~\/|\/)(?:[A-Za-z0-9._-]+\/)*$/;

/* the fingerprint in OpenSSH's own form (SHA256:<unpadded base64>), or
   the reason it isn't one */
function fingerprint(value) {
  const raw = String(value || '').trim();
  if (!raw) return { error: 'not set' };
  if (/^(MD5:)?([0-9a-f]{2}:){15}[0-9a-f]{2}$/i.test(raw)) return { error: 'an MD5 fingerprint; the SHA-256 one is needed (ssh-keygen -lf <key> -E sha256)' };
  const b64 = raw.replace(/^SHA256:/, '').replace(/=+$/, '');
  if (!/^[A-Za-z0-9+/]{43}$/.test(b64)) return { error: 'not a SHA-256 fingerprint (43 base64 characters after "SHA256:")' };
  const bytes = Buffer.from(b64, 'base64');
  if (bytes.length !== 32) return { error: 'does not decode to 32 bytes' };
  return { value: `SHA256:${bytes.toString('base64').replace(/=+$/, '')}` };
}

function check(env, options) {
  const opts = options || {};
  const checks = [];
  const add = (name, ok, detail, level) => checks.push({ name, ok, level: ok ? 'ok' : level || 'error', detail });

  const user = env.RAKUTEN_SFTP_USER;
  if (!user) add('RAKUTEN_SFTP_USER', false, 'not set (repository secret)');
  else if (/[\s:]/.test(user) || user.length > 128) add('RAKUTEN_SFTP_USER', false, 'set, but it has a space, a colon or is too long, so it can’t be a Rakuten SFTP user name');
  else add('RAKUTEN_SFTP_USER', true, 'set');
  const pass = env.RAKUTEN_SFTP_PASSWORD;
  if (!pass) add('RAKUTEN_SFTP_PASSWORD', false, 'not set (repository secret)');
  else if (/[\r\n\0]/.test(pass) || pass.length > 256) add('RAKUTEN_SFTP_PASSWORD', false, 'set, but it holds a line break or is too long');
  else add('RAKUTEN_SFTP_PASSWORD', true, 'set');

  const mid = (env.RAKUTEN_UNIQLO_MID || '').trim();
  add('RAKUTEN_UNIQLO_MID', DIGITS.test(mid), mid ? (DIGITS.test(mid) ? mid : 'set, but not a number') : 'not set (repository variable: UNIQLO USA’s advertiser ID, from the publisher dashboard)');
  const sid = (env.RAKUTEN_SID || '').trim();
  add('RAKUTEN_SID', DIGITS.test(sid), sid ? (DIGITS.test(sid) ? sid : 'set, but not a number') : 'not set (repository variable: Fynd’s publisher site ID)');

  const fp = fingerprint(env.RAKUTEN_SFTP_HOSTKEY_SHA256);
  add('RAKUTEN_SFTP_HOSTKEY_SHA256', !fp.error, fp.error ? `${fp.error} (repository variable: the server’s host key fingerprint, from Rakuten)` : fp.value);

  const host = adapter.RAKUTEN && adapter.RAKUTEN.host;
  add('feed host (uniqlo-us.js RAKUTEN.host)', Boolean(host && HOST.test(host)), host || 'not recorded');

  const dir = (env.RAKUTEN_SFTP_DIR || '/').trim();
  add('RAKUTEN_SFTP_DIR', DIR.test(dir) && !/\/\.{1,2}\//.test(dir), DIR.test(dir) ? `${dir}${env.RAKUTEN_SFTP_DIR ? '' : ' (default — confirm it against the real listing)'}` : 'must be "/" or "~/" or a folder under either, ending in "/", e.g. "~/12345/"');

  const licensed = (env.UNIQLO_FEED_LICENSED_FIELDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = licensed.filter((f) => !LICENSABLE.includes(f));
  if (unknown.length) add('UNIQLO_FEED_LICENSED_FIELDS', false, `not fields a licence can cover: ${unknown.join(', ')} (choose from ${LICENSABLE.join(', ')})`);
  else if (!licensed.length) add('UNIQLO_FEED_LICENSED_FIELDS', false, 'empty: only ID, name, link, category and line would be kept — set it to what the agreement licenses', 'warning');
  else add('UNIQLO_FEED_LICENSED_FIELDS', true, licensed.join(', '));

  if (opts.tools) {
    const run = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' });
    const curl = run('curl', ['-V']);
    const protocols = curl.status === 0 ? (/^Protocols:(.*)$/m.exec(curl.stdout) || [])[1] || '' : '';
    add('curl with SFTP', /\bsftp\b/.test(protocols), curl.status === 0 ? (/\bsftp\b/.test(protocols) ? curl.stdout.split('\n')[0] : 'this curl has no SFTP') : 'curl not found');
    ['ssh-keyscan', 'ssh-keygen'].forEach((t) => {
      const found = run('sh', ['-c', `command -v ${t}`]);
      add(t, found.status === 0, found.status === 0 ? found.stdout.trim() : 'not found (openssh-client)');
    });
  }

  const ready = checks.every((c) => c.level !== 'error');
  const files = DIGITS.test(mid) && DIGITS.test(sid) ? { full: `${mid}_${sid}_mp.txt.gz`, delta: `${mid}_${sid}_mp_delta.txt.gz` } : null;
  return { ready, checks, host: host || null, port: 22, mid: DIGITS.test(mid) ? mid : null, sid: DIGITS.test(sid) ? sid : null, dir: DIR.test(dir) ? dir : null, fingerprint: fp.value || null, files, licensed };
}

function main(argv, deps) {
  const d = Object.assign({ env: process.env, log: console.log, error: console.error }, deps || {});
  const known = ['--tools', '--json', '--github-output'];
  const bad = argv.find((a) => !known.includes(a));
  if (bad) { d.error(`Unknown option ${bad}. Usage: rakuten-preflight.js [--tools] [--json] [--github-output]`); return 2; }
  const r = check(d.env, { tools: argv.includes('--tools') });
  if (argv.includes('--json')) d.log(JSON.stringify(r, null, 2));
  else {
    d.log('Rakuten Product Catalog SFTP — preflight (nothing is fetched)\n');
    r.checks.forEach((c) => d.log(`  ${c.level === 'ok' ? 'ok  ' : c.level === 'warning' ? 'warn' : 'FAIL'}  ${c.name}: ${c.detail}`));
    if (r.files) d.log(`\n  would fetch: sftp://${r.host}${r.dir || '/'}${r.files.full} (full), ${r.files.delta} (delta)`);
    d.log(`\n${r.ready ? 'Ready to connect.' : 'Not ready: fix each FAIL above. Nothing will be fetched until then.'}`);
  }
  if (argv.includes('--github-output') && d.env.GITHUB_OUTPUT && r.ready) {
    /* public values only: never a credential */
    const out = [`host=${r.host}`, `port=${r.port}`, `mid=${r.mid}`, `sid=${r.sid}`, `dir=${r.dir}`, `fingerprint=${r.fingerprint}`, `full_file=${r.files.full}`, `delta_file=${r.files.delta}`];
    fs.appendFileSync(d.env.GITHUB_OUTPUT, `${out.join('\n')}\n`);
  }
  return r.ready ? 0 : 1;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { check, fingerprint, main };
