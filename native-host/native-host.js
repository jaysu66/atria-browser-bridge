#!/usr/bin/env node
/**
 * Optional Chrome Native Messaging host.
 *
 * The Phase 1 extension can talk to the local MCP server directly over
 * localhost HTTP. This host is a compatibility path for the standard Chrome
 * Native Messaging architecture: extension <-> native host <-> local HTTP
 * queue. Install it with scripts/install-native-host.ps1 after Chrome assigns
 * an extension id.
 */

const http = require('http');

const HOST = process.env.ATRIA_BROWSER_HOST || '127.0.0.1';
const PORT = Number(process.env.ATRIA_BROWSER_PORT || 47652);
const CLIENT_ID = `native_${process.pid}`;
const VERSION = '0.1.0';

let input = Buffer.alloc(0);

function writeFrame(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}

function httpJson(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const req = http.request(
      {
        hostname: HOST,
        port: PORT,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      },
      (res) => {
        let buf = '';
        res.on('data', (chunk) => (buf += chunk));
        res.on('end', () => {
          if (res.statusCode === 204) return resolve(null);
          try {
            resolve(buf ? JSON.parse(buf) : {});
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function pollLoop() {
  while (true) {
    try {
      const envelope = await httpJson('GET', `/extension/next?clientId=${encodeURIComponent(CLIENT_ID)}&version=${VERSION}`);
      if (envelope) writeFrame(envelope);
    } catch (_) {
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
  }
}

async function handleMessage(message) {
  if (message && message.type === 'hello') {
    await httpJson('POST', '/extension/result', {
      id: `native_hello_${Date.now()}`,
      ok: true,
      result: { content: [{ type: 'text', text: 'native host connected' }] },
    }).catch(() => {});
    return;
  }
  if (message && message.id) {
    await httpJson('POST', '/extension/result', message).catch(() => {});
  }
}

process.stdin.on('data', (chunk) => {
  input = Buffer.concat([input, chunk]);
  while (input.length >= 4) {
    const length = input.readUInt32LE(0);
    if (input.length < 4 + length) return;
    const body = input.slice(4, 4 + length).toString('utf8');
    input = input.slice(4 + length);
    try {
      handleMessage(JSON.parse(body));
    } catch (_) {}
  }
});

pollLoop();
