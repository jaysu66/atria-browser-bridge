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

const pendingQueue = [];
const waiters = [];
const pendingResults = new Map();
const extensionSockets = new Set();
const bridgeState = {
  startedAt: new Date().toISOString(),
  extensionClientId: null,
  extensionVersion: null,
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

function enqueueTool(tool, args) {
  const id = crypto.randomUUID();
  const envelope = { id, tool, args: args || {}, createdAt: new Date().toISOString() };

  const promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingResults.delete(id);
      reject(new Error(`browser bridge timeout waiting for ${tool}`));
    }, REQUEST_TIMEOUT_MS);
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
      entry.resolve(body.result);
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
        group: { type: 'boolean', default: true, description: 'When true, put the tab into the Atria Agent Chrome tab group.' },
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
    description: 'Navigate a tab to a URL, or go back/forward.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number' },
        url: { type: 'string' },
        direction: { type: 'string', enum: ['back', 'forward'] },
        timeoutMs: { type: 'number', default: 30000 },
      },
    },
  },
  {
    name: 'read_page',
    description: 'Read the current page as an accessibility-style tree with stable refs such as [ref_1]. Returns page content verbatim, including form field values.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number' },
        filter: { type: 'string', enum: ['all', 'interactive'], default: 'all' },
        depth: { type: 'number', default: 15 },
        maxChars: { type: 'number', default: 50000 },
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
    description: 'Extract a structured crawl snapshot from the page: metadata, text sections, links, images, media, forms, tables, embeds, interactive elements, JSON-LD, and loaded resources.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number' },
        maxItems: { type: 'number', default: 200 },
        maxTextChars: { type: 'number', default: 50000 },
        includeResources: { type: 'boolean', default: true },
        autoScroll: { type: 'boolean', default: true },
        scrollSteps: { type: 'number', default: 8 },
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
    description: 'Perform browser actions: left_click, right_click, double_click, type, key, scroll, scroll_to, wait, screenshot.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number' },
        action: {
          type: 'string',
          enum: ['left_click', 'right_click', 'double_click', 'type', 'key', 'scroll', 'scroll_to', 'wait', 'screenshot'],
        },
        ref: { type: 'string' },
        coordinate: {},
        text: { type: 'string' },
        key: { type: 'string' },
        direction: { type: 'string' },
        amount: { type: 'number' },
        duration: { type: 'number' },
      },
      required: ['action'],
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
    description: 'Run browser tools sequentially. Stops at the first error. No nested browser_batch.',
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
      },
      required: ['actions'],
    },
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
        serverInfo: { name: 'atria-browser-bridge', version: '0.1.0' },
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
