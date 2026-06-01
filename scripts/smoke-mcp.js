#!/usr/bin/env node
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const root = path.resolve(__dirname, '..');
const serverPath = path.join(root, 'mcp-server.js');
const smokePort = Number(process.env.ATRIA_BROWSER_SMOKE_PORT || (48652 + Math.floor(Math.random() * 1000)));

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
        for (const name of ['browser_status', 'tabs_context', 'navigate', 'read_page', 'extract_page', 'file_upload', 'computer', 'browser_batch']) {
          if (!tools.some((tool) => tool.name === name)) throw new Error(`missing tool: ${name}`);
        }
        if (!status?.result?.content?.[0]?.text?.includes(`127.0.0.1:${smokePort}`)) {
          throw new Error('browser_status did not include local endpoint');
        }
        resolve({ tools: tools.length, serverInfo: init.result.serverInfo });
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
  console.log(`MCP smoke ok: ${result.tools} tools, server=${result.serverInfo.name}@${result.serverInfo.version}`);

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
