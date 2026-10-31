/* =========================================================
   Fynd — test helper: a process that starts the throwaway SFTP server
   (./temp-sftp-server.js), says what it made, then ends one way:

     hold    waits, until a signal ends it (SIGINT, SIGTERM, SIGHUP)
     throw   throws an error nobody catches
     exit    calls process.exit(3) without stopping anything itself

   so scripts/test-rakuten-sftp.js can check the account and the server
   are gone afterwards, however the process ended.
   ========================================================= */

'use strict';

const server = require('./temp-sftp-server');

const how = process.argv[2];
const h = server.start();
process.stdout.write(`${JSON.stringify({ name: h.name, port: h.port, pid: h.pid, home: h.home, dir: h.dir })}\n`);
if (how === 'hold') setInterval(() => {}, 1000);
else if (how === 'throw') setTimeout(() => { throw new Error('FIXTURE failure after setup'); }, 100);
else if (how === 'exit') setTimeout(() => process.exit(3), 100);
else { h.stop(); process.exit(2); }
