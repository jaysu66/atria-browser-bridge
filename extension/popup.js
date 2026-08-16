const DEFAULT_BRIDGE_PORT = 47652;
const BRIDGE_PORT_KEY = "atriaBridgePort";

const bridgeStatus = document.getElementById("bridge-status");
const extensionId = document.getElementById("extension-id");
const tabStatus = document.getElementById("tab-status");
const pingButton = document.getElementById("ping");
const portInput = document.getElementById("bridge-port");
const sessionExportToggle = document.getElementById("allow-session-export");
const SESSION_EXPORT_KEY = "atriaAllowSessionExport";

extensionId.textContent = chrome.runtime.id;

function normalizePort(value) {
  const port = Number(value || DEFAULT_BRIDGE_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return DEFAULT_BRIDGE_PORT;
  return port;
}

async function getBridgePort() {
  const stored = await chrome.storage.local.get(BRIDGE_PORT_KEY);
  return normalizePort(stored[BRIDGE_PORT_KEY]);
}

async function setBridgePort(value) {
  const port = normalizePort(value);
  await chrome.storage.local.set({ [BRIDGE_PORT_KEY]: port });
  try {
    await chrome.runtime.sendMessage({ type: "atria.setBridgePort", port });
  } catch (_) {}
  return port;
}

function bridgeBase(port) {
  return `http://127.0.0.1:${port}`;
}

async function refresh() {
  const port = await getBridgePort();
  portInput.value = String(port);
  try {
    await chrome.runtime.sendMessage({ type: "atria.wake" });
  } catch (_) {}

  bridgeStatus.textContent = "检测中";
  bridgeStatus.className = "status";
  try {
    const response = await fetch(`${bridgeBase(port)}/health`, { cache: "no-store" });
    const data = await response.json();
    if (data && data.ok) {
      bridgeStatus.textContent = "已连接";
      bridgeStatus.className = "status ok";
    } else {
      bridgeStatus.textContent = "未连接";
    }
  } catch (_) {
    bridgeStatus.textContent = "未启动";
  }

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  tabStatus.textContent = tab ? String(tab.id) : "无";
  tabStatus.className = tab ? "status ok" : "status";

  const stored = await chrome.storage.local.get(SESSION_EXPORT_KEY);
  sessionExportToggle.checked = Boolean(stored[SESSION_EXPORT_KEY]);
}

sessionExportToggle.addEventListener("change", async () => {
  await chrome.storage.local.set({ [SESSION_EXPORT_KEY]: sessionExportToggle.checked });
});

pingButton.addEventListener("click", refresh);
portInput.addEventListener("change", async () => {
  portInput.value = String(await setBridgePort(portInput.value));
  refresh();
});
refresh();
