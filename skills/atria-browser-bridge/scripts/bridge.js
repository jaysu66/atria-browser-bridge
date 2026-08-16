#!/usr/bin/env node
/**
 * Atria Browser Bridge CLI — call the local bridge over HTTP from a skill.
 *
 *   node bridge.js <tool> [inline-json | @args-file.json]
 *   node bridge.js --health
 *   node bridge.js --start
 *
 * Why this exists instead of raw curl:
 *   - decodes screenshot images to a file on disk (the model can Read a path,
 *     not a base64 blob)
 *   - writes the full raw response to a file so large / non-ASCII output
 *     survives console encoding and truncation
 *   - auto-starts the bridge server when it is not running
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const HOST = process.env.ATRIA_BROWSER_HOST || '127.0.0.1';
const PORT = Number(process.env.ATRIA_BROWSER_PORT || 47652);
const HOME =
  process.env.ATRIA_BROWSER_BRIDGE_HOME ||
  path.join(os.homedir(), 'Desktop', 'atria-browser-bridge-oss');
const SERVER = path.join(HOME, 'mcp-server.js');
const OUT_DIR = path.join(os.tmpdir(), 'atria-bridge');
const MAX_STDOUT = 30000;

function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request(
      {
        host: HOST,
        port: PORT,
        path: urlPath,
        method,
        headers: payload
          ? { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': payload.length }
          : {},
      },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(buf));
          } catch (_) {
            reject(new Error(`non-JSON response (${res.statusCode}): ${buf.slice(0, 300)}`));
          }
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function health() {
  return request('GET', '/health');
}

async function start() {
  if (!fs.existsSync(SERVER)) {
    throw new Error(
      `bridge server not found at ${SERVER}. Set ATRIA_BROWSER_BRIDGE_HOME to the repo root.`,
    );
  }
  spawn(process.execPath, [SERVER, '--standalone'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  }).unref();
  for (let i = 0; i < 20; i++) {
    await sleep(250);
    try {
      return await health();
    } catch (_) {
      /* keep waiting */
    }
  }
  throw new Error('bridge server did not come up within 5s');
}

function parseArgs(raw) {
  if (!raw) return {};
  const text = raw.startsWith('@') ? fs.readFileSync(raw.slice(1), 'utf8') : raw;
  try {
    return JSON.parse(text);
  } catch (error) {
    // "Bad escaped character in JSON at position 286" is useless on its own.
    // Show the offending stretch, and name the usual cause: a regex escape like
    // \s or \d written straight into a JSON string, where it has to be \\s.
    const at = Number((error.message.match(/position (\d+)/) || [])[1]);
    if (!Number.isFinite(at)) throw error;
    const snippet = text.slice(Math.max(0, at - 40), at + 40).replace(/\n/g, '\\n');
    const caret = ' '.repeat(Math.min(at, 40)) + '^';
    const stray = /\\[^"\\/bfnrtu]/.exec(text.slice(Math.max(0, at - 2), at + 2));
    throw new Error(
      `${error.message}\n  ...${snippet}...\n     ${caret}` +
        (stray ? `\n  Looks like a lone backslash escape (${stray[0]}). Inside a JSON string a regex escape must be doubled: \\\\s, \\\\d.` : '')
    );
  }
}

function extractPdf(text) {
  if (typeof text !== 'string' || !text.includes('pdfBase64')) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed.pdfBase64 === 'string' ? parsed : null;
  } catch (_) {
    return null;
  }
}

/** Pull image and PDF payloads out to disk; keep everything else as-is. */
function materialize(result, stamp) {
  const content = Array.isArray(result && result.content) ? result.content : [];
  const parts = [];
  content.forEach((block, i) => {
    if (block.type === 'image' && block.data) {
      const ext = (block.mimeType || 'image/jpeg').includes('png') ? 'png' : 'jpg';
      const file = path.join(OUT_DIR, `shot-${stamp}-${i}.${ext}`);
      fs.writeFileSync(file, Buffer.from(block.data, 'base64'));
      parts.push(`[image saved] ${file}`);
    } else if (block.type === 'text') {
      // save_as_pdf hands back base64 inside a JSON text block; same reasoning as
      // images — write it out and report the path instead of flooding the caller.
      const pdf = extractPdf(block.text);
      if (pdf) {
        const file = path.join(OUT_DIR, `page-${stamp}-${i}.pdf`);
        fs.writeFileSync(file, Buffer.from(pdf.pdfBase64, 'base64'));
        parts.push(`[pdf saved] ${file}${pdf.pageTitle ? ` (${pdf.pageTitle})` : ''}`);
      } else {
        parts.push(block.text);
      }
    } else {
      parts.push(JSON.stringify(block));
    }
  });
  return parts.join('\n');
}

async function main() {
  const [first, rawArgs] = process.argv.slice(2);
  if (!first) throw new Error('usage: node bridge.js <tool> [inline-json | @file.json]');

  if (first === '--health') {
    console.log(JSON.stringify(await health()));
    return;
  }
  if (first === '--start') {
    console.log(JSON.stringify(await start()));
    return;
  }

  // `--js <file.js> [tabId]` sidesteps JSON escaping entirely: the script is read
  // as a file and the request is built here, so regex escapes like \s never have
  // to survive a hand-written JSON string.
  if (first === '--js') {
    const [, file, tabId] = process.argv.slice(2);
    if (!file) throw new Error('usage: node bridge.js --js <file.js> [tabId]');
    const code = fs.readFileSync(file, 'utf8');
    const jsBody = { name: 'javascript_tool', arguments: { text: code, ...(tabId ? { tabId: Number(tabId) } : {}) } };
    const jsResponse = await request('POST', '/tools/call', jsBody);
    fs.mkdirSync(OUT_DIR, { recursive: true });
    process.stdout.write(`${materialize(jsResponse.result, `${process.pid}-js`)}\n`);
    return;
  }

  const body = { name: first, arguments: parseArgs(rawArgs) };
  let response;
  try {
    response = await request('POST', '/tools/call', body);
  } catch (error) {
    if (error.code === 'ECONNREFUSED') {
      await start();
      response = await request('POST', '/tools/call', body);
    } else if (error.code === 'ECONNRESET') {
      // A keep-alive socket the server closed underneath us. The request never
      // reached a tool, so retrying once is safe rather than a double action.
      response = await request('POST', '/tools/call', body);
    } else {
      throw error;
    }
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = `${process.pid}-${Date.now()}`;
  const rawFile = path.join(OUT_DIR, `resp-${stamp}.json`);
  fs.writeFileSync(rawFile, JSON.stringify(response, null, 2), 'utf8');

  // stdout carries the tool result and nothing else, so a caller can pipe it
  // straight into a JSON parser. Bridge metadata goes to stderr.
  const text = materialize(response.result, stamp);
  const truncated = text.length > MAX_STDOUT;
  process.stdout.write(`${truncated ? text.slice(0, MAX_STDOUT) : text}\n`);
  if (truncated) process.stderr.write(`[truncated] ${text.length} chars, showing ${MAX_STDOUT}\n`);
  if (response.ok === false) process.stderr.write('[isError] see raw response\n');
  process.stderr.write(`[raw] ${rawFile}\n`);
}

main().catch((error) => {
  console.error(`bridge error: ${error.message}`);
  process.exit(1);
});
