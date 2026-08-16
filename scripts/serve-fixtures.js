#!/usr/bin/env node
// Serves fixtures/ over http so the extension can reach them without the
// "allow access to file URLs" permission, which is off by default.
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', 'fixtures');
const port = Number(process.env.ATRIA_FIXTURE_PORT || 8099);

const server = http.createServer((req, res) => {
  const name = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
  const file = path.join(root, name);
  if (!file.startsWith(root)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(file, (error, buf) => {
    if (error) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(buf);
  });
});

// Someone already serving this port is the normal case when a fixture server was
// left running, and it serves the same directory. Reuse it instead of taking the
// whole acceptance run down with an unhandled error event.
let reused = false;
server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    reused = true;
    if (require.main === module) console.log(`fixtures already served on http://127.0.0.1:${port}`);
    return;
  }
  throw error;
});

server.listen(port, '127.0.0.1', () => {
  if (require.main === module) console.log(`fixtures on http://127.0.0.1:${port}`);
});

module.exports = { server, port, isReused: () => reused };
