#!/usr/bin/env node
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const root = path.resolve(__dirname, '..');
const serverPath = path.join(root, 'mcp-server.js');
const smokePort = Number(process.env.ATRIA_BROWSER_SMOKE_PORT || (48652 + Math.floor(Math.random() * 1000)));

// Every tool the contract promises. A rename that misses one half of the
// codebase shows up here rather than as a puzzling failure at call time.
const EXPECTED_TOOLS = [
  'browser_status', 'tabs_context', 'tabs_create', 'tabs_close', 'tabs_activate',
  'navigate', 'read_page', 'get_page_text', 'extract_page', 'find',
  'form_input', 'file_upload', 'computer', 'javascript_tool',
  'browser_batch', 'browser_parallel', 'wait_for', 'cdp_tool',
  'network_start', 'network_stop', 'network_list', 'network_detail',
  'set_request_blocking', 'clear_request_blocking',
  'export_session', 'save_as_pdf', 'reload_extension',
];

function requestHealth(port) {
  return new Promise((resolve, reject) => {
    const req = http.request(`http://127.0.0.1:${port}/health`, (res) => {
      let buf = '';
      res.on('data', (chunk) => (buf += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(buf));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.setTimeout(3000, () => {
      req.destroy(new Error('health timeout'));
    });
    req.on('error', reject);
    req.end();
  });
}

function runMcpSmoke() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverPath], {
      cwd: root,
      env: { ...process.env, ATRIA_BROWSER_PORT: String(smokePort) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const lines = [];
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      lines.push(...chunk.toString('utf8').split(/\r?\n/).filter(Boolean));
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      try {
        if (code !== 0) throw new Error(`mcp server exited ${code}: ${stderr}`);
        const responses = lines.map((line) => JSON.parse(line));
        const init = responses.find((item) => item.id === 1);
        const list = responses.find((item) => item.id === 2);
        const status = responses.find((item) => item.id === 3);
        if (!init?.result?.serverInfo) throw new Error('missing initialize result');
        const tools = list?.result?.tools || [];
        for (const name of EXPECTED_TOOLS) {
          if (!tools.some((tool) => tool.name === name)) throw new Error(`missing tool: ${name}`);
        }
        for (const tool of tools) {
          if (!tool.description) throw new Error(`tool without description: ${tool.name}`);
          if (!tool.inputSchema || tool.inputSchema.type !== 'object') {
            throw new Error(`tool with a bad inputSchema: ${tool.name}`);
          }
        }
        const statusText = status?.result?.content?.[0]?.text || '';
        if (!statusText.includes(`127.0.0.1:${smokePort}`)) {
          throw new Error('browser_status did not include local endpoint');
        }
        // The version handshake is what tells a user their extension is stale,
        // so a missing field here would silently disable that warning.
        const parsedStatus = JSON.parse(statusText);
        if (typeof parsedStatus.protocolVersion !== 'number') {
          throw new Error('browser_status did not report protocolVersion');
        }
        resolve({ tools: tools.length, serverInfo: init.result.serverInfo, protocolVersion: parsedStatus.protocolVersion });
      } catch (error) {
        reject(error);
      }
    });

    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'browser_status', arguments: {} } }) + '\n');
    child.stdin.end();
  });
}

async function run() {
  const result = await runMcpSmoke();
  console.log(
    `MCP smoke ok: ${result.tools} tools (${EXPECTED_TOOLS.length} required present), ` +
      `protocol=${result.protocolVersion}, server=${result.serverInfo.name}@${result.serverInfo.version}`
  );

  const standalone = spawn(process.execPath, [serverPath, '--standalone'], {
    cwd: root,
    env: { ...process.env, ATRIA_BROWSER_PORT: String(smokePort) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  standalone.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 600));
    const health = await requestHealth(smokePort);
    if (!health.ok) throw new Error('health ok=false');
    console.log(`HTTP health ok: ${health.name}`);
  } finally {
    standalone.kill();
  }
  if (stderr.trim()) console.error(stderr.trim());
}

run().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
