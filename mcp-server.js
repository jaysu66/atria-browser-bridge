#!/usr/bin/env node
/**
 * Atria Browser Bridge MCP server.
 *
 * Phase 1 local architecture:
 *   agent MCP client -> this stdio server -> local HTTP queue -> Chrome extension.
 *
 * The extension connects by polling http://127.0.0.1:47652/extension/next
 * and posts results to /extension/result. This keeps the first install simple.
 * Native Messaging support can be enabled with the included host later; the
 * tool contract remains the same.
 */

const http = require('http');
const readline = require('readline');
const crypto = require('crypto');

function argValue(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return '';
  return process.argv[index + 1] || '';
}

function resolvePort() {
  const value =
    argValue('--port') ||
    process.env.ATRIA_BROWSER_PORT ||
    process.env.ATRIA_BROWSER_BRIDGE_PORT ||
    process.env.BROWSER_BRIDGE_PORT ||
    47652;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid browser bridge port: ${value}`);
  }
  return port;
}

const HOST = process.env.ATRIA_BROWSER_HOST || '127.0.0.1';
const PORT = resolvePort();
const REQUEST_TIMEOUT_MS = Number(process.env.ATRIA_BROWSER_REQUEST_TIMEOUT_MS || 60000);
const STANDALONE = process.argv.includes('--standalone') || process.env.ATRIA_BROWSER_STANDALONE === '1';
const MIN_INTERVAL_MS = Number(process.env.ATRIA_BROWSER_MIN_INTERVAL_MS || 0);
// Bumped whenever the tool contract changes in a way an older extension cannot
// serve. browser_status compares it against what the extension reports so a
// stale extension is named as the cause instead of surfacing as odd failures.
const PROTOCOL_VERSION = 2;

const pendingQueue = [];
const waiters = [];
const pendingResults = new Map();
const extensionSockets = new Set();
const bridgeState = {
  startedAt: new Date().toISOString(),
  extensionClientId: null,
  extensionVersion: null,
  protocolVersion: null,
  lastSeenAt: null,
};

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function jsonResponse(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'content-type',
  });
  res.end(data);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (chunk) => {
      buf += chunk;
      if (buf.length > 10 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!buf.trim()) return resolve({});
      try {
        resolve(JSON.parse(buf));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function markExtension(req) {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  bridgeState.extensionClientId = url.searchParams.get('clientId') || bridgeState.extensionClientId;
  bridgeState.extensionVersion = url.searchParams.get('version') || bridgeState.extensionVersion;
  // Only record the protocol when the request actually carries one. Not every
  // endpoint the extension hits sends it — the websocket upgrade does not — and
  // defaulting on those would overwrite a known-good version with 1 and warn
  // that a current extension is stale. Absent stays absent; the check below
  // treats a never-reported version as protocol 1.
  const reported = url.searchParams.get('protocol');
  if (reported !== null) bridgeState.protocolVersion = Number(reported);
  bridgeState.lastSeenAt = new Date().toISOString();
}

function encodeWebSocketFrame(data) {
  const payload = Buffer.from(JSON.stringify(data));
  if (payload.length > 65535) throw new Error('websocket payload too large');
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

function sendSocket(socket, data) {
  if (socket.destroyed) return;
  try {
    socket.write(encodeWebSocketFrame(data));
  } catch (_) {}
}

function broadcastSocket(data) {
  for (const socket of extensionSockets) sendSocket(socket, data);
}

function attachExtensionSocket(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }
  markExtension(req);
  const accept = crypto
    .createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');
  socket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '',
      '',
    ].join('\r\n'),
  );
  extensionSockets.add(socket);
  sendSocket(socket, { type: 'hello', pending: pendingQueue.length, at: new Date().toISOString() });
  const heartbeat = setInterval(() => {
    bridgeState.lastSeenAt = new Date().toISOString();
    sendSocket(socket, { type: 'ping', pending: pendingQueue.length, at: bridgeState.lastSeenAt });
  }, 20000);
  socket.on('data', () => {
    bridgeState.lastSeenAt = new Date().toISOString();
  });
  socket.on('close', () => {
    clearInterval(heartbeat);
    extensionSockets.delete(socket);
  });
  socket.on('error', () => {
    clearInterval(heartbeat);
    extensionSockets.delete(socket);
  });
}

// wait_for deliberately blocks until a page changes — often while a human
// clears a bot check — so the transport must outlive its own timeout rather
// than cutting the call off at the default and reporting a bridge failure.
function timeoutFor(tool, args) {
  if (tool === 'wait_for') {
    const requested = Number(args?.timeoutMs || 30000);
    return Math.min(Math.max(requested, 1000), 900000) + 15000;
  }
  // A batch is many steps in one call and may contain a wait_for of its own, so
  // the default single-action budget does not apply.
  if (tool === 'browser_batch' || tool === 'browser_parallel') return Math.max(REQUEST_TIMEOUT_MS, 300000);
  return REQUEST_TIMEOUT_MS;
}

function enqueueTool(tool, args) {
  const id = crypto.randomUUID();
  const envelope = { id, tool, args: args || {}, createdAt: new Date().toISOString() };

  const promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingResults.delete(id);
      reject(new Error(`browser bridge timeout waiting for ${tool}`));
    }, timeoutFor(tool, args));
    pendingResults.set(id, { resolve, reject, timer });
  });

  if (waiters.length) {
    const waiter = waiters.shift();
    waiter(envelope);
  } else {
    pendingQueue.push(envelope);
  }

  broadcastSocket({ type: 'wake', pending: pendingQueue.length, at: new Date().toISOString() });
  return promise;
}

function nextEnvelope() {
  if (pendingQueue.length) return Promise.resolve(pendingQueue.shift());
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const index = waiters.indexOf(resolveEnvelope);
      if (index >= 0) waiters.splice(index, 1);
      resolve(null);
    }, 25000);

    function resolveEnvelope(envelope) {
      clearTimeout(timer);
      resolve(envelope);
    }

    waiters.push(resolveEnvelope);
  });
}

// Different Chrome paths and CDP versions label image payloads differently
// (mimeType / mediaType / media_type, sometimes nested under source). Callers
// should not have to know which one produced a screenshot, so normalize to one
// shape here. An empty payload becomes a text note rather than an image block
// no client can render.
function normalizeImageBlock(block) {
  if (!block || block.type !== 'image') return block;
  const source = block.source && typeof block.source === 'object' ? block.source : null;
  const mimeType =
    block.mimeType || block.mediaType || block.media_type ||
    source?.mimeType || source?.mediaType || source?.media_type || 'image/jpeg';
  const data = typeof block.data === 'string' ? block.data : typeof source?.data === 'string' ? source.data : '';
  if (!data.trim()) return { type: 'text', text: '[browser screenshot omitted: invalid image data]' };
  const { media_type, mediaType, source: _source, ...rest } = block;
  return { ...rest, type: 'image', mimeType, data };
}

function normalizeContentBlocks(result) {
  if (!result || typeof result !== 'object' || !Array.isArray(result.content)) return result;
  return { ...result, content: result.content.map(normalizeImageBlock) };
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'content-type',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    });
    res.end();
    return;
  }

  try {
    const url = new URL(req.url, `http://${HOST}:${PORT}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      jsonResponse(res, 200, { ok: true, name: 'atria-browser-bridge', bridgeState, pending: pendingQueue.length, socketClients: extensionSockets.size });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/tools/list') {
      jsonResponse(res, 200, { ok: true, tools: TOOLS });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/tools/call') {
      const body = await readJson(req);
      const name = body.name || body.tool;
      const args = body.arguments || body.args || {};
      const handler = HANDLERS[name];
      if (!handler) {
        jsonResponse(res, 404, { ok: false, error: `tool not found: ${name}` });
        return;
      }
      const result = await handler(args);
      jsonResponse(res, 200, { ok: !result?.isError, result });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/extension/next') {
      markExtension(req);
      const envelope = await nextEnvelope();
      if (!envelope) {
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
        res.end();
        return;
      }
      jsonResponse(res, 200, envelope);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/extension/result') {
      const body = await readJson(req);
      const entry = pendingResults.get(body.id);
      if (!entry) {
        jsonResponse(res, 404, { ok: false, error: 'unknown request id' });
        return;
      }
      pendingResults.delete(body.id);
      clearTimeout(entry.timer);
      entry.resolve(normalizeContentBlocks(body.result));
      jsonResponse(res, 200, { ok: true });
      return;
    }

    jsonResponse(res, 404, { ok: false, error: 'not found' });
  } catch (error) {
    jsonResponse(res, 500, { ok: false, error: error.message || String(error) });
  }
});

server.on('upgrade', (req, socket) => {
  try {
    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    if (url.pathname !== '/extension/socket') {
      socket.destroy();
      return;
    }
    attachExtensionSocket(req, socket);
  } catch (_) {
    socket.destroy();
  }
});

// Node closes an idle keep-alive socket after 5s by default. A caller that
// reuses its connection between calls — anything driving the bridge in a loop —
// can send on a socket the server is closing at that same moment and see an
// intermittent ECONNRESET that looks like a bug in whatever tool it was calling.
// Holding the socket open longer than any realistic gap between calls removes
// the race. headersTimeout must stay above keepAliveTimeout.
server.keepAliveTimeout = 65000;
server.headersTimeout = 70000;

server.listen(PORT, HOST);

function callBrowser(tool, args) {
  if (!bridgeState.lastSeenAt) {
    return Promise.resolve({
      isError: true,
      content: [
        {
          type: 'text',
          text: `Browser extension is not connected. Start this server, load the extension/ folder in Chrome, then open the popup once. Local endpoint: http://${HOST}:${PORT}/health`,
        },
      ],
    });
  }
  // A global politeness floor belongs on the server, where every tab and every
  // concurrent task passes through it, not in each caller's loop.
  if (tool === 'navigate' && args && args.minIntervalMsPerDomain === undefined && MIN_INTERVAL_MS > 0) {
    args = { ...args, minIntervalMsPerDomain: MIN_INTERVAL_MS };
  }
  return enqueueTool(tool, args);
}

const TOOLS = [
  {
    name: 'browser_status',
    description: 'Get local bridge and Chrome extension connection status.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'tabs_context',
    description: 'List Chrome tabs visible to the browser bridge, including the Atria Agent tab group. Call this before choosing a tabId.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'tabs_create',
    description: 'Create a new Chrome tab, optionally with a URL.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        active: { type: 'boolean', default: true },
        groupTitle: { type: 'string', description: 'Label for this task\'s tab group. Reuse one title for a whole task so its tabs stay together and separate from other tasks. Defaults to "Atria Agent".' },
      },
    },
  },
  {
    name: 'tabs_close',
    description: 'Close a Chrome tab by tabId.',
    inputSchema: {
      type: 'object',
      properties: { tabId: { type: 'number' } },
      required: ['tabId'],
    },
  },
  {
    name: 'navigate',
    description: 'Navigate a tab to a URL, or go back/forward. The result carries pageState, so a bot check is visible immediately without a second call.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number' },
        url: { type: 'string' },
        direction: { type: 'string', enum: ['back', 'forward'] },
        timeoutMs: { type: 'number', default: 30000 },
        recreateIfGone: { type: 'boolean', default: false, description: 'If the tab was closed, open a replacement instead of failing with TAB_GONE.' },
        groupTitle: { type: 'string', description: 'Group title to use when recreating the tab.' },
        minIntervalMsPerDomain: { type: 'number', description: 'Politeness delay between navigations to the same hostname. Defaults to ATRIA_BROWSER_MIN_INTERVAL_MS.' },
      },
    },
  },
  {
    name: 'tabs_activate',
    description: 'Bring a tab to the front and focus its window. Use this to put a page in front of the user when they need to act on it — solving a bot check, for example — instead of describing which tab to open.',
    inputSchema: {
      type: 'object',
      properties: { tabId: { type: 'number' } },
      required: ['tabId'],
    },
  },
  {
    name: 'read_page',
    description: 'Read the page as an accessibility-style tree with stable refs such as [ref_1]. Content is verbatim, form values included. If a dialog or popover seems missing, it is usually last in a large DOM and got truncated — pass rootSelector to read just that subtree, or filter:"interactive".',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number' },
        filter: { type: 'string', enum: ['all', 'interactive'], default: 'all' },
        depth: { type: 'number', default: 30 },
        maxChars: { type: 'number', default: 50000 },
        rootSelector: { type: 'string', description: 'Read only this element\'s subtree. Use for dialogs, popovers and overlays in a large page.' },
      },
    },
  },
  {
    name: 'get_page_text',
    description: 'Read visible page text for extraction and crawling.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number' },
        maxChars: { type: 'number', default: 50000 },
      },
    },
  },
  {
    name: 'extract_page',
    description: 'Extract a structured crawl snapshot: metadata, text sections, links, images, media, forms, tables, embeds, interactive elements, JSON-LD, loaded resources, plus detected listing items and the next-page link. On a list page, set scopeSelector to the card container — the surrounding chrome is usually most of the text and none of the data.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number' },
        maxItems: { type: 'number', default: 200 },
        maxTextChars: { type: 'number', default: 50000 },
        includeResources: { type: 'boolean', default: true },
        autoScroll: { type: 'boolean', default: true },
        scrollSteps: { type: 'number', default: 8 },
        scopeSelector: { type: 'string', description: 'Restrict extraction to this container. Page-level metadata stays document-wide.' },
        incremental: { type: 'boolean', default: false, description: 'Return only items not seen on previous calls for this tab. For infinite scroll.' },
      },
    },
  },
  {
    name: 'find',
    description: 'Find page elements by a simple natural-language/text query against the latest page tree.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number' },
        query: { type: 'string' },
      },
      required: ['query'],
    },
  },
  {
    name: 'form_input',
    description: 'Set an input/select/textarea/contenteditable value by ref.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number' },
        ref: { type: 'string' },
        value: {},
      },
      required: ['ref', 'value'],
    },
  },
  {
    name: 'file_upload',
    description: 'Set local files on a file input via Chrome DevTools Protocol. Use selector when the input has no visible ref.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number' },
        selector: { type: 'string', default: 'input[type="file"]' },
        file: { type: 'string' },
        files: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  {
    name: 'computer',
    description: 'Perform browser actions with real CDP input — clicks, typing and scrolling all dispatch trusted events, so they work where synthetic DOM events are ignored (canvas tiles, drag surfaces, rich editors, virtual lists). **Prefer act_until for anything whose success is checkable**: it locates, acts, verifies and retries in one call, so coordinates cannot go stale between steps and the check cannot run before the click settles. Set untilGone for deselect/close/collapse. click_where is the one-shot version; scroll_until drives a virtual list until something appears.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number' },
        action: {
          type: 'string',
          enum: [
            'left_click', 'right_click', 'double_click', 'type', 'key',
            'scroll', 'scroll_until', 'scroll_to', 'click_where', 'act_until', 'wait', 'screenshot',
          ],
        },
        op: { type: 'string', description: 'act_until: the operation to repeat — left_click (default), right_click, double_click, type, key.' },
        until: {
          type: 'object',
          description: 'act_until: the condition that means it worked. One of js (arrow function), selector, or text.',
          properties: { js: { type: 'string' }, selector: { type: 'string' }, text: { type: 'string' } },
        },
        untilGone: { type: 'boolean', default: false, description: 'act_until: wait for the condition to STOP holding. Use for deselect, close and collapse — the opposite direction is a common source of wrong-way retries.' },
        maxAttempts: { type: 'number', default: 3, description: 'act_until: how many times to retry before failing.' },
        selector: { type: 'string', description: 'click_where / scroll_until: CSS selector for the target.' },
        predicateJs: { type: 'string', description: 'click_where: arrow function picking the element, e.g. "el => el.src.includes(\'abc\')". Use when no selector or ref can name it.' },
        verifyJs: { type: 'string', description: 'click_where: arrow function checked after the click; the call fails if it does not hold.' },
        maxSteps: { type: 'number', default: 20, description: 'scroll_until: how many wheel steps before giving up.' },
        settleMs: { type: 'number', description: 'Pause after each scroll step or click.' },
        ref: { type: 'string', description: 'Target element. For screenshot, crops to this element.' },
        coordinate: {},
        text: { type: 'string' },
        key: { type: 'string' },
        direction: { type: 'string' },
        amount: { type: 'number' },
        duration: { type: 'number' },
        clip: {
          type: 'object',
          description: 'screenshot only: crop to this viewport rect.',
          properties: { x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } },
        },
        quality: { type: 'number', default: 70, description: 'screenshot only: JPEG quality.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'reload_extension',
    description: 'Restart the Chrome extension so edited extension code takes effect, without the user having to click reload at chrome://extensions. Only useful when developing this bridge. It interrupts any command in flight, so do not call it while another task is driving the browser.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'export_session',
    description: 'Export cookies and user agent for an origin so bulk fetching can move to a plain HTTP client, which is far faster than driving pages. Off by default and refused with PERMISSION_DENIED until the user enables it in the extension popup — the export is the site\'s login credentials in cleartext.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number' },
        origin: { type: 'string', description: 'Origin to export. Defaults to the tab\'s own origin.' },
      },
    },
  },
  {
    name: 'save_as_pdf',
    description: 'Render a tab to PDF via CDP and return it. Useful for archiving evidence of a page exactly as it rendered.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number' },
        paperFormat: { type: 'string', enum: ['letter', 'legal', 'tabloid', 'a3', 'a4'], default: 'letter' },
        landscape: { type: 'boolean', default: false },
        scale: { type: 'number', default: 1 },
        printBackground: { type: 'boolean', default: true },
      },
    },
  },
  {
    name: 'javascript_tool',
    description: 'Evaluate JavaScript in the page main world. Returns are passed through verbatim.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number' },
        text: { type: 'string' },
      },
      required: ['text'],
    },
  },
  {
    name: 'browser_batch',
    description: 'Run browser tools sequentially in one round trip. Stops at the first error unless continueOnError is set. No nested browser_batch.',
    inputSchema: {
      type: 'object',
      properties: {
        actions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              input: { type: 'object' },
            },
            required: ['name'],
          },
        },
        continueOnError: { type: 'boolean', default: false, description: 'Run every step and report ok per step instead of stopping at the first failure.' },
      },
      required: ['actions'],
    },
  },
  {
    name: 'browser_parallel',
    description: 'Run several batches at the same time, one per tab. Use for crawling many pages at once: open N tabs, then give each its own navigate/extract sequence. Each batch is independent — one failing does not affect the others.',
    inputSchema: {
      type: 'object',
      properties: {
        batches: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              tabId: { type: 'number', description: 'Applied to every step in this batch.' },
              continueOnError: { type: 'boolean', default: true },
              actions: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { name: { type: 'string' }, input: { type: 'object' } },
                  required: ['name'],
                },
              },
            },
            required: ['actions'],
          },
        },
      },
      required: ['batches'],
    },
  },
  {
    name: 'wait_for',
    description: 'Block until a page condition holds, then return. Use challengeGone:true after read_page reports pageState.challenge — tell the user to solve the bot check, then wait instead of polling in a loop. Also waits on text, a CSS selector, or a URL pattern; set gone:true to wait for the condition to stop holding.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number' },
        text: { type: 'string', description: 'Wait until this text appears in the page body.' },
        selector: { type: 'string', description: 'Wait until this CSS selector matches.' },
        urlRegex: { type: 'string', description: 'Wait until the tab URL matches this pattern.' },
        gone: { type: 'boolean', default: false, description: 'Invert: wait for the condition to stop holding.' },
        challengeGone: { type: 'boolean', default: false, description: 'Wait until no bot-check page is detected.' },
        timeoutMs: { type: 'number', default: 30000, description: 'Up to 900000. Use a long value when a human has to act.' },
        pollMs: { type: 'number', default: 1000 },
      },
    },
  },
  {
    name: 'cdp_tool',
    description: 'Send a raw Chrome DevTools Protocol command to a tab. Escape hatch for anything the named tools do not cover (Page.printToPDF, Emulation.*, Runtime.evaluate with awaitPromise). Browser-process and target-lifecycle methods are refused.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number' },
        method: { type: 'string', description: 'CDP method, e.g. "Page.captureScreenshot"' },
        params: { type: 'object' },
      },
      required: ['method'],
    },
  },
  {
    name: 'network_start',
    description: 'Begin recording network requests for a tab. Most list pages are driven by XHR/fetch JSON — capturing it lets you read the API payload directly instead of parsing HTML.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number' },
        filter: { type: 'string', description: 'Default substring filter applied by network_list.' },
      },
    },
  },
  {
    name: 'network_stop',
    description: 'Stop recording network requests for a tab and discard the buffer.',
    inputSchema: { type: 'object', properties: { tabId: { type: 'number' } } },
  },
  {
    name: 'network_list',
    description: 'List captured requests. Keeps the most recent 200 per tab; truncated:true means older entries were dropped.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number' },
        filter: { type: 'string', description: 'Substring matched against url, method, resourceType and status.' },
      },
    },
  },
  {
    name: 'network_detail',
    description: 'Full record for one captured request, optionally including the response body (capped at 1 MB).',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number' },
        requestId: { type: 'string' },
        includeBody: { type: 'boolean', default: false },
      },
      required: ['requestId'],
    },
  },
  {
    name: 'set_request_blocking',
    description: 'Block resource types or URL patterns in a tab. Images, fonts and media are most of a page\'s bytes; dropping them makes crawling several times faster. Survives navigation until cleared.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number' },
        resourceTypes: {
          type: 'array',
          items: { type: 'string' },
          description: 'CDP resource types, lowercased: image, font, media, stylesheet, script, xhr, fetch.',
        },
        urlPatterns: { type: 'array', items: { type: 'string' }, description: 'Glob-style patterns, e.g. "*analytics*".' },
      },
    },
  },
  {
    name: 'clear_request_blocking',
    description: 'Stop blocking requests in a tab and report how many were blocked.',
    inputSchema: { type: 'object', properties: { tabId: { type: 'number' } } },
  },
];

const HANDLERS = Object.fromEntries(TOOLS.map((tool) => [tool.name, (args) => callBrowser(tool.name, args)]));
HANDLERS.browser_status = async () => ({
  content: [
    {
      type: 'text',
      text: JSON.stringify(
        {
          ok: true,
          endpoint: `http://${HOST}:${PORT}`,
          protocolVersion: PROTOCOL_VERSION,
          extensionProtocolVersion: bridgeState.protocolVersion ?? null,
          versionWarning:
            bridgeState.lastSeenAt && (bridgeState.protocolVersion ?? 1) < PROTOCOL_VERSION
              ? `The connected extension speaks protocol ${bridgeState.protocolVersion ?? 1} but this server expects ${PROTOCOL_VERSION}. Reload the extension at chrome://extensions to pick up the newer tools.`
              : null,
          minIntervalMsPerDomain: MIN_INTERVAL_MS,
          bridgeState,
          pending: pendingQueue.length,
          waitingExtensionPolls: waiters.length,
          pendingResults: pendingResults.size,
        },
        null,
        2,
      ),
    },
  ],
});

let initialized = false;
const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch (_) {
    return;
  }

  const { id, method, params } = msg;

  if (method === 'initialize') {
    initialized = true;
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'atria-browser-bridge', version: '0.2.0' },
      },
    });
    return;
  }

  if (id === undefined || id === null) return;

  if (!initialized) {
    send({ jsonrpc: '2.0', id, error: { code: -32002, message: 'server not initialized' } });
    return;
  }

  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    return;
  }

  if (method === 'tools/call') {
    const toolName = params && params.name;
    const toolArgs = (params && params.arguments) || {};
    const handler = HANDLERS[toolName];
    if (!handler) {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `tool not found: ${toolName}` } });
      return;
    }
    try {
      const result = await handler(toolArgs);
      send({ jsonrpc: '2.0', id, result });
    } catch (error) {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          isError: true,
          content: [{ type: 'text', text: `browser tool error: ${error.message || String(error)}` }],
        },
      });
    }
    return;
  }

  if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} });
    return;
  }

  send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}

if (!STANDALONE) process.stdin.on('end', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
