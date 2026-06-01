# Atria Browser Bridge

> Give any AI agent eyes and hands in your **real, logged-in Chrome** — via the Model Context Protocol (MCP). Zero dependencies.

![Atria Browser Bridge](assets/hero.png)

Most browser tools for agents spin up a fresh, empty headless browser. **Atria Browser Bridge drives the Chrome you already use** — with your sessions, your logins, your cookies — through a tiny local MCP server and a Chrome extension. Your agent can read pages, fill forms, upload files, click, scroll, and extract structured data on real sites behind a login, while a visible indicator shows when the agent is acting.

It speaks plain **MCP over stdio**, so it works with **any MCP-compatible agent** — Claude Code, Cursor, Cline, Codex, or your own client.

---

## Why

- **Real browser, real sessions.** Operate logged-in SaaS dashboards, creator platforms, internal tools — no re-authentication, no headless detection.
- **Works with any agent.** Standard MCP stdio server. Point any MCP client at it.
- **Stable element refs, not brittle selectors.** Reads the accessibility tree and hands the agent durable `ref`s to click/type against.
- **Structured page extraction.** One call returns meta, text, links, images, media, forms, tables, JSON-LD, and resources.
- **Safe by default.** Sensitive fields (passwords, OTP, card numbers) are redacted; a visible on-page indicator shows when the agent is driving; agent-opened tabs are grouped separately from yours.
- **Zero dependencies.** Pure Node.js (built-ins only). No `npm install` needed to run.

## How it works

```text
  AI agent / MCP client
        │  MCP (stdio JSON-RPC)
        ▼
  mcp-server.js          ← this repo: MCP server + local HTTP queue + WebSocket
        │  localhost
        ▼
  Chrome MV3 extension   ← this repo: service worker + content scripts
        │
        ▼
  Your real Chrome tabs / DOM / Chrome DevTools Protocol
```

## Quick start

### 1. Start the local bridge

```bash
git clone https://github.com/jaysu66/atria-browser-bridge.git
cd atria-browser-bridge
node mcp-server.js --standalone
```

Health check:

```bash
curl http://127.0.0.1:47652/health
```

### 2. Load the Chrome extension

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the `extension/` folder in this repo
5. Open the extension popup once — it should show **connected** to the local bridge

### 3. Connect your agent

It's a standard MCP stdio server. Add it to any MCP client:

**Claude Code**

```bash
claude mcp add browser -- node /absolute/path/to/atria-browser-bridge/mcp-server.js
```

**Cursor / Cline / Windsurf** (`mcp.json`)

```json
{
  "mcpServers": {
    "browser": {
      "command": "node",
      "args": ["/absolute/path/to/atria-browser-bridge/mcp-server.js"]
    }
  }
}
```

**Codex** (`~/.codex/config.toml`)

```toml
[mcp_servers.browser]
command = "node"
args = ["/absolute/path/to/atria-browser-bridge/mcp-server.js"]
```

**Any other MCP client** — run `node mcp-server.js` as a stdio server; it implements `initialize`, `tools/list`, and `tools/call`.

## Tools

| Tool | What it does |
| --- | --- |
| `browser_status` | Health of the MCP server, local bridge, and extension connection. |
| `tabs_context` | List Chrome tabs and the agent's tab group. |
| `tabs_create` | Open a new tab (auto-grouped under the agent's tab group). |
| `tabs_close` | Close a tab. |
| `navigate` | Navigate / back / forward. |
| `read_page` | Read the accessibility tree and return stable element `ref`s. |
| `get_page_text` | Read visible page text — fast way to check page state. |
| `extract_page` | Structured extraction: meta, text, links, images, media, forms, tables, JSON-LD, resources. |
| `find` | Find elements by text / natural-language query. |
| `form_input` | Set values on inputs, textareas, selects, contenteditable — by `ref`. |
| `file_upload` | Attach local files to a file input (via Chrome DevTools Protocol). |
| `computer` | Click, right-click, double-click, keyboard, scroll, wait, screenshot. |
| `javascript_tool` | Run JS in the page main world for precise probing / location. |
| `browser_batch` | Run several browser tools in sequence, stopping on error. |

## Standalone HTTP mode

For debugging without an MCP client, run the bridge with `--standalone` and call it over HTTP:

```bash
curl -X POST http://127.0.0.1:47652/tools/call \
  -H 'Content-Type: application/json' \
  -d '{"name":"tabs_context","arguments":{}}'
```

## Safety boundaries

- `password`, `hidden`, `one-time-code`, and `cc-*` fields are redacted in the page tree.
- The server filters out token / secret / API key / authorization strings from extracted text.
- A visible on-page indicator shows when the agent is operating the browser.
- Agent-opened tabs are grouped separately to avoid mixing with your own tabs.
- It does **not** bypass CAPTCHAs, logins, security checks, anti-fraud, or paywalls.

For high-impact actions (publish, pay, delete, grant access, send messages), your agent should confirm page state and user intent before the final click.

## Optional: Native Messaging host

The extension talks to the local server over localhost HTTP by default. To use Chrome Native Messaging instead:

1. Copy the extension ID from `chrome://extensions`
2. Run `scripts/install-native-host.ps1 -ExtensionId <your-extension-id>`
3. Restart Chrome (or toggle the extension off/on)

## Verify

```bash
node scripts/smoke-mcp.js
# MCP smoke ok: 14 tools, server=atria-browser-bridge@0.1.0
# HTTP health ok: atria-browser-bridge
```

## Roadmap

- Domain-level permission manager
- Per-action audit: DOM hit, screenshot, and authorization status per step
- Network / console ring buffer
- Cloud relay so remote agents can drive a user-authorized local browser
- Reusable per-site recipes

## License

MIT — see [LICENSE](LICENSE).

Built by **[Atria](https://github.com/jaysu66)** — an enterprise multi-agent workspace. Atria Browser Bridge is the browser layer, open-sourced for any agent to use.
