/* =========================================================
   Fynd — keeps a CI test run on this machine

   Loaded into every suite scripts/ci-tests.js runs (node --require),
   and into every Node process those suites start. Any TCP connection
   to a host that is not this machine is refused the way a closed port
   refuses it — an error on the socket — and written to the file named
   by FYND_OFFLINE_LOG, which the runner reads: a suite that tried to
   reach the internet fails, even when it handled the refusal.

   Loopback (localhost, 127.x, ::1) and local sockets are untouched:
   the suites serve their stub endpoints and pages from 127.0.0.1.

   This covers Node — fetch, http, https, net, tls. The browser the
   interface suites drive is its own process; those suites answer or
   abort its requests themselves.
   ========================================================= */

'use strict';

const fs = require('fs');
const net = require('net');

const LOCAL = /^(localhost|127(?:\.\d{1,3}){3}|::1|::ffff:127(?:\.\d{1,3}){3}|0\.0\.0\.0)$/i;

/* host and port, whichever of connect()'s forms was used; null for a
   local socket path */
function target(args) {
  let first = args[0];
  if (Array.isArray(first)) first = first[0]; /* net.connect's normalised form */
  if (first && typeof first === 'object') {
    if (first.path) return null;
    return { host: first.host || 'localhost', port: first.port };
  }
  if (typeof first === 'string' && !/^\d+$/.test(first)) return null;
  return { host: typeof args[1] === 'string' ? args[1] : 'localhost', port: first };
}

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const to = target(args);
  if (!to || LOCAL.test(String(to.host).replace(/^\[|\]$/g, ''))) return connect.apply(this, args);

  const line = `${to.host}:${to.port} from ${process.argv.slice(1).join(' ')}\n`;
  if (process.env.FYND_OFFLINE_LOG) {
    try { fs.appendFileSync(process.env.FYND_OFFLINE_LOG, line); } catch (err) { /* reported below */ }
  }
  process.stderr.write(`ci-offline: refused a connection to ${line}`);
  const err = Object.assign(new Error(`connect ECONNREFUSED ${to.host}:${to.port} (refused by scripts/ci-offline.js)`), {
    code: 'ECONNREFUSED', syscall: 'connect', address: to.host, port: to.port
  });
  process.nextTick(() => this.destroy(err));
  return this;
};
