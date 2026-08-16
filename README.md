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
- **Visible when driving.** An on-page indicator shows when the agent is operating the browser, and agent-opened tabs are grouped separately from yours.
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

**Tabs and navigation**

| Tool | What it does |
| --- | --- |
| `browser_status` | Health of the MCP server, local bridge, extension connection, and protocol versions. |
| `tabs_context` | List Chrome tabs and every agent tab group. |
| `tabs_create` | Open a tab, grouped under a task-named tab group. |
| `tabs_activate` | Bring a tab to the front and focus its window. |
| `tabs_close` | Close a tab. |
| `navigate` | Navigate / back / forward, with optional per-domain throttling and tab self-heal. |

**Reading**

| Tool | What it does |
| --- | --- |
| `read_page` | Accessibility tree with stable element `ref`s. |
| `get_page_text` | Visible page text — fast way to check page state. |
| `extract_page` | Structured extraction: meta, text, links, images, media, forms, tables, JSON-LD, resources, detected listing `items[]` and `pagination.next`. Scopeable to a container; incremental mode for infinite scroll. |
| `find` | Find elements by text query. |

**Acting** — clicks and keystrokes are real CDP input, so they carry `isTrusted=true`.

| Tool | What it does |
| --- | --- |
| `computer` | Click, right-click, double-click, type, key, scroll, wait, screenshot (croppable to an element). |
| `form_input` | Set a field by `ref`, verified by reading back. |
| `file_upload` | Attach local files to a file input. |
| `wait_for` | Block until text / selector / URL matches, or until a bot check clears. |
| `javascript_tool` | Run JS in the page main world for probing. |

**Crawling**

| Tool | What it does |
| --- | --- |
| `network_start` / `network_stop` / `network_list` / `network_detail` | Record requests and read response bodies — read the JSON API directly instead of parsing HTML. |
| `set_request_blocking` / `clear_request_blocking` | Drop images, fonts, media and tracker URLs. |
| `browser_batch` | Run tools in sequence in one round trip, optionally continuing past errors. |
| `browser_parallel` | Run one batch per tab, concurrently. |
| `export_session` | Cookies + UA for an origin, for bulk HTTP fetching. Off until enabled in the popup. |

**Escape hatches**

| Tool | What it does |
| --- | --- |
| `cdp_tool` | Raw Chrome DevTools Protocol passthrough. |
| `save_as_pdf` | Render the page to PDF. |

## Standalone HTTP mode

For debugging without an MCP client, run the bridge with `--standalone` and call it over HTTP:

```bash
curl -X POST http://127.0.0.1:47652/tools/call \
  -H 'Content-Type: application/json' \
  -d '{"name":"tabs_context","arguments":{}}'
```

## Safety boundaries

- **The bridge does not redact anything.** Page content is returned verbatim, form field values included — passwords, one-time codes and card numbers among them. Whatever is on the page reaches your agent, and therefore your model provider and your session logs. Drive it only on pages you would be willing to paste into a chat.
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

## Use it as a Claude Code / Kimi CLI skill

If your agent supports skills, `skills/atria-browser-bridge/` is a drop-in that
needs no MCP registration. Copy it into the harness's skill directory:

```bash
cp -r skills/atria-browser-bridge ~/.claude/skills/          # Claude Code
cp -r skills/atria-browser-bridge ~/.kimi-code/skills/       # Kimi CLI
```

It ships a helper script that starts the bridge on demand, writes screenshots
and PDFs to disk (a model cannot read a base64 blob), and keeps stdout clean
JSON so a driver script can pipe it straight into a parser. See
[docs/使用指南.md](docs/使用指南.md) for the full walkthrough.

## Roadmap

- Domain-level permission manager
- Per-action audit: DOM hit, screenshot, and authorization status per step
- Network / console ring buffer
- Cloud relay so remote agents can drive a user-authorized local browser
- Reusable per-site recipes

## License

MIT — see [LICENSE](LICENSE).

Built by **[Atria](https://github.com/jaysu66)** — an enterprise multi-agent workspace. Atria Browser Bridge is the browser layer, open-sourced for any agent to use.
