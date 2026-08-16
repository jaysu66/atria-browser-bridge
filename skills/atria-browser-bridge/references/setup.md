# Setup and troubleshooting

## One-time: load the Chrome extension

The bridge server auto-starts, but the extension is a manual install the **user** must do once. Walk them through it:

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the `extension/` folder inside the bridge repo
   (default `~/Desktop/atria-browser-bridge-oss/extension`)
5. Click the extension icon once to open the popup — it should show **connected**

Step 5 matters: the popup opening is what makes the service worker start polling the local server. Until then `browser_status` shows `lastSeenAt: null` and every tool returns *"Browser extension is not connected"*.

## Diagnosing a dead connection

Run these in order:

```bash
node "<skill-dir>/scripts/bridge.js" --health
```

- **Connection refused** → the server is down. Run `--start`.
- **`ok: true`, `lastSeenAt: null`** → the server is up, Chrome is not attached. The extension is not loaded, is disabled, or its service worker went idle. Have the user open the extension popup again.
- **`ok: true`, recent `lastSeenAt`** → both sides are live; the failure is in the tool call itself, not the connection.

If the service worker keeps going idle, toggle the extension off and on in `chrome://extensions`.

## Port conflicts

The server binds `127.0.0.1:47652`. If something else holds that port, pick another and keep both sides in sync:

```powershell
$env:ATRIA_BROWSER_PORT = "47653"
```

The extension reads the port from its popup settings — change it there too, or the two halves will not find each other.

## Optional: native messaging host

By default the extension talks to the server over localhost HTTP. To switch to Chrome Native Messaging:

1. Copy the extension ID from `chrome://extensions`
2. Run `scripts/install-native-host.ps1 -ExtensionId <id>` from the bridge repo
3. Restart Chrome, or toggle the extension off and on

The tool contract is identical either way — this only changes the transport.

## Verifying the repo itself

From the bridge repo root:

```bash
node scripts/smoke-mcp.js
```

Expected: `MCP smoke ok: 14 tools` plus `HTTP health ok`. If the tool count differs from 14, the skill's tool table in `SKILL.md` is out of date with the server.

## Stopping the server

The auto-started server is detached and survives the session. To stop it:

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*mcp-server.js*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId }
```

Only do this when the user asks — killing it mid-task breaks any in-flight browser work.

## Using it as an MCP server instead

The same `mcp-server.js` is a standard MCP stdio server. Registering it gives native tool calls with inline image rendering, at the cost of a config step and always-on tool definitions in context:

```bash
claude mcp add browser -- node ~/Desktop/atria-browser-bridge-oss/mcp-server.js
```

The skill and the MCP registration can coexist — they drive the same server. Do not run both against different ports.
