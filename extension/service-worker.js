const DEFAULT_BRIDGE_PORT = 47652;
const BRIDGE_PORT_KEY = "atriaBridgePort";
const EXTENSION_VERSION = chrome.runtime.getManifest().version;
const AGENT_GROUP_TITLE = "Atria Agent";
const AGENT_GROUP_COLOR = "green";

let clientIdPromise = null;
let nativePort = null;
let nativeConnected = false;
let polling = false;
let bridgeSocket = null;
let socketReconnectTimer = null;
const WAKE_ALARM = "atria.bridge.wake";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeBridgePort(value) {
  const port = Number(value || DEFAULT_BRIDGE_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return DEFAULT_BRIDGE_PORT;
  return port;
}

async function getBridgePort() {
  const stored = await chrome.storage.local.get(BRIDGE_PORT_KEY);
  return normalizeBridgePort(stored[BRIDGE_PORT_KEY]);
}

async function bridgeBase(protocol = "http") {
  const port = await getBridgePort();
  return `${protocol}://127.0.0.1:${port}`;
}

async function isBridgeReachable() {
  try {
    const base = await bridgeBase("http");
    const response = await fetch(`${base}/health`, { cache: "no-store" });
    return response.ok;
  } catch (_) {
    return false;
  }
}

function contentResult(result) {
  return { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }] };
}

function toolError(message, extra) {
  return {
    isError: true,
    content: [{ type: "text", text: extra ? `${message}\n${JSON.stringify(extra, null, 2)}` : String(message) }]
  };
}

async function getClientId() {
  if (clientIdPromise) return clientIdPromise;
  clientIdPromise = (async () => {
    const stored = await chrome.storage.local.get("atriaBridgeClientId");
    if (stored.atriaBridgeClientId) return stored.atriaBridgeClientId;
    const id = `ext_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    await chrome.storage.local.set({ atriaBridgeClientId: id });
    return id;
  })();
  return clientIdPromise;
}

async function postJson(path, body) {
  const base = await bridgeBase("http");
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json().catch(() => ({}));
}

function scheduleSocketReconnect(delayMs = 2500) {
  if (socketReconnectTimer) return;
  socketReconnectTimer = setTimeout(() => {
    socketReconnectTimer = null;
    connectSocket();
  }, delayMs);
}

async function connectSocket() {
  try {
    if (bridgeSocket && (bridgeSocket.readyState === WebSocket.OPEN || bridgeSocket.readyState === WebSocket.CONNECTING)) return;
    if (!(await isBridgeReachable())) {
      scheduleSocketReconnect(5000);
      return;
    }
    const clientId = await getClientId();
    const base = await bridgeBase("ws");
    const socket = new WebSocket(`${base}/extension/socket?clientId=${encodeURIComponent(clientId)}&version=${encodeURIComponent(EXTENSION_VERSION)}`);
    bridgeSocket = socket;

    socket.onopen = () => {
      try {
        socket.send(JSON.stringify({ type: "hello", clientId, version: EXTENSION_VERSION, at: new Date().toISOString() }));
      } catch (_) {}
      pollLoop();
    };
    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data || "{}");
        if (message.type === "ping") {
          socket.send(JSON.stringify({ type: "pong", at: new Date().toISOString() }));
        }
        if (message.type === "ping" || message.type === "wake" || message.type === "hello") {
          pollLoop();
        }
      } catch (_) {
        pollLoop();
      }
    };
    socket.onerror = () => {
      try {
        socket.close();
      } catch (_) {}
    };
    socket.onclose = () => {
      if (bridgeSocket === socket) bridgeSocket = null;
      scheduleSocketReconnect();
    };
  } catch (_) {
    scheduleSocketReconnect(5000);
  }
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

async function resolveTab(tabId) {
  if (tabId !== undefined && tabId !== null) {
    return chrome.tabs.get(Number(tabId));
  }
  const active = await getActiveTab();
  if (!active) throw new Error("No active tab");
  return active;
}

async function getStoredAgentGroupId() {
  const stored = await chrome.storage.local.get("atriaAgentTabGroupId");
  const groupId = stored.atriaAgentTabGroupId;
  if (typeof groupId !== "number" || groupId < 0) return null;
  try {
    await chrome.tabGroups.get(groupId);
    return groupId;
  } catch (_) {
    await chrome.storage.local.remove("atriaAgentTabGroupId");
    return null;
  }
}

async function groupAgentTab(tabId) {
  let groupId = await getStoredAgentGroupId();
  if (groupId !== null) {
    try {
      groupId = await chrome.tabs.group({ tabIds: [tabId], groupId });
    } catch (_) {
      groupId = null;
      await chrome.storage.local.remove("atriaAgentTabGroupId");
    }
  }
  if (groupId === null) {
    groupId = await chrome.tabs.group({ tabIds: [tabId] });
  }
  await chrome.tabGroups.update(groupId, {
    title: AGENT_GROUP_TITLE,
    color: AGENT_GROUP_COLOR,
    collapsed: false
  });
  await chrome.storage.local.set({ atriaAgentTabGroupId: groupId });
  return groupId;
}

function waitForTabLoad(tabId, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const timer = setTimeout(done, timeoutMs);
    function done() {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }
    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") done();
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "atria.readPage", options: { filter: "interactive", maxChars: 1000 } });
    return;
  } catch (_) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content/accessibility-tree.js"]
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content/visual-indicator.js"]
    });
  }
}

async function sendToContent(tabId, message) {
  await ensureContentScript(tabId);
  return chrome.tabs.sendMessage(tabId, message);
}

async function setIndicator(tabId, visible) {
  try {
    await ensureContentScript(tabId);
    await chrome.tabs.sendMessage(tabId, { type: "atria.indicator", visible });
  } catch (_) {
    // Best effort only. Some pages such as chrome:// cannot receive scripts.
  }
}

async function withDebugger(tabId, fn) {
  const target = { tabId };
  let attached = false;
  try {
    await chrome.debugger.attach(target, "1.3");
    attached = true;
  } catch (error) {
    if (!String(error.message || error).includes("Another debugger is already attached")) {
      throw error;
    }
  }
  try {
    return await fn((method, params) => chrome.debugger.sendCommand(target, method, params || {}));
  } finally {
    if (attached) {
      try {
        await chrome.debugger.detach(target);
      } catch (_) {}
    }
  }
}

// Methods that would take the browser away from the user rather than drive a
// page. The bridge exists to operate tabs, not to control the browser process.
const CDP_DENIED = /^(Browser\.|Target\.(close|createTarget|disposeBrowserContext)|Page\.close|Storage\.clearDataForOrigin)/;

// withDebugger attaches and detaches around a single call, which suits one-shot
// commands but cannot receive events. Network capture and request blocking need
// the attachment to outlive the call, so those tabs get a session here and the
// attachment is released only when the last consumer stops.
const cdpSessions = new Map();

function cdpSession(tabId) {
  let session = cdpSessions.get(tabId);
  if (!session) {
    session = { tabId, consumers: new Set(), network: null, blocking: null };
    cdpSessions.set(tabId, session);
  }
  return session;
}

async function attachPersistent(tabId, consumer) {
  const session = cdpSession(tabId);
  if (!session.consumers.size) {
    try {
      await chrome.debugger.attach({ tabId }, "1.3");
    } catch (error) {
      if (!String(error?.message || error).includes("Another debugger is already attached")) throw error;
    }
  }
  session.consumers.add(consumer);
  return session;
}

async function detachPersistent(tabId, consumer) {
  const session = cdpSessions.get(tabId);
  if (!session) return;
  session.consumers.delete(consumer);
  if (session.consumers.size) return;
  cdpSessions.delete(tabId);
  try {
    await chrome.debugger.detach({ tabId });
  } catch (_) {}
}

function cdpSend(tabId, method, params) {
  return chrome.debugger.sendCommand({ tabId }, method, params || {});
}

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId !== undefined) cdpSessions.delete(source.tabId);
});

const NETWORK_MAX_RECORDS = 200;
const NETWORK_MAX_BODY_BYTES = 1024 * 1024;

function networkMatches(record, filter) {
  if (!filter) return true;
  const needle = String(filter).toLowerCase();
  return `${record.url} ${record.method} ${record.resourceType} ${record.status || ""}`.toLowerCase().includes(needle);
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const session = source.tabId !== undefined ? cdpSessions.get(source.tabId) : null;
  if (!session) return;

  if (session.blocking && method === "Fetch.requestPaused") {
    const { requestId, request, resourceType } = params || {};
    const blocked =
      session.blocking.resourceTypes.includes(String(resourceType || "").toLowerCase()) ||
      session.blocking.urlPatterns.some((pattern) => pattern.test(request?.url || ""));
    const command = blocked
      ? cdpSend(source.tabId, "Fetch.failRequest", { requestId, errorReason: "BlockedByClient" })
      : cdpSend(source.tabId, "Fetch.continueRequest", { requestId });
    if (blocked) session.blocking.blocked += 1;
    command.catch(() => {});
    return;
  }

  const capture = session.network;
  if (!capture) return;

  if (method === "Network.requestWillBeSent") {
    if (capture.records.length >= NETWORK_MAX_RECORDS) {
      capture.records.shift();
      capture.truncated = true;
    }
    capture.records.push({
      requestId: params.requestId,
      url: params.request?.url || "",
      method: params.request?.method || "",
      resourceType: String(params.type || "").toLowerCase(),
      requestHeaders: params.request?.headers || {},
      postData: params.request?.postData ? String(params.request.postData).slice(0, 4000) : undefined,
      startedAt: params.wallTime,
      status: null
    });
    return;
  }
  if (method === "Network.responseReceived") {
    const record = capture.records.find((item) => item.requestId === params.requestId);
    if (record) {
      record.status = params.response?.status ?? null;
      record.mimeType = params.response?.mimeType || "";
      record.responseHeaders = params.response?.headers || {};
    }
    return;
  }
  if (method === "Network.loadingFinished" || method === "Network.loadingFailed") {
    const record = capture.records.find((item) => item.requestId === params.requestId);
    if (record) {
      record.finished = true;
      record.encodedDataLength = params.encodedDataLength;
      if (method === "Network.loadingFailed") record.failed = params.errorText || "failed";
    }
  }
});

async function clickAt(tabId, coordinate, button = "left", clickCount = 1) {
  const x = Math.round(Number(coordinate?.x ?? coordinate?.[0]));
  const y = Math.round(Number(coordinate?.y ?? coordinate?.[1]));
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("coordinate is required");
  return withDebugger(tabId, async (cdp) => {
    await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
    await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, buttons: button === "right" ? 2 : 1, clickCount });
    await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, buttons: 0, clickCount });
  });
}

async function typeText(tabId, text) {
  return withDebugger(tabId, async (cdp) => {
    await cdp("Input.insertText", { text: String(text || "") });
  });
}

async function pressKey(tabId, key) {
  const normalized = String(key || "Enter");
  return withDebugger(tabId, async (cdp) => {
    for (const part of normalized.split(/\s+/).filter(Boolean)) {
      const pieces = part.split("+");
      const main = pieces.pop();
      const modifiers = pieces.reduce((sum, item) => {
        const token = item.toLowerCase();
        if (token === "alt" || token === "option") return sum | 1;
        if (token === "ctrl" || token === "control") return sum | 2;
        if (token === "meta" || token === "cmd" || token === "command") return sum | 4;
        if (token === "shift") return sum | 8;
        return sum;
      }, 0);
      await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: main, code: main, modifiers });
      await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: main, code: main, modifiers });
    }
  });
}

async function setFileInputFiles(tabId, args) {
  const selector = args.selector || "input[type='file']";
  const files = Array.isArray(args.files) ? args.files : [args.file].filter(Boolean);
  const normalizedFiles = files.map((file) => String(file || "").trim()).filter(Boolean);
  if (!normalizedFiles.length) throw new Error("file_upload requires file or files");

  return withDebugger(tabId, async (cdp) => {
    await cdp("DOM.enable");
    const documentResult = await cdp("DOM.getDocument", { depth: -1, pierce: true });
    const rootNodeId = documentResult?.root?.nodeId;
    if (!rootNodeId) throw new Error("Unable to inspect document for file input");
    const query = await cdp("DOM.querySelector", { nodeId: rootNodeId, selector });
    let nodeId = query?.nodeId;
    if (!nodeId && selector !== "input[type='file']") {
      const fallback = await cdp("DOM.querySelector", { nodeId: rootNodeId, selector: "input[type='file']" });
      nodeId = fallback?.nodeId;
    }
    if (!nodeId) throw new Error(`File input not found: ${selector}`);
    await cdp("DOM.setFileInputFiles", { nodeId, files: normalizedFiles });
    return { uploaded: true, selector, files: normalizedFiles, count: normalizedFiles.length };
  });
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function escapeXml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function base64Utf8(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function buildSvgSnapshot(snapshot, reason) {
  const width = Math.max(320, Math.min(Number(snapshot?.width) || 1280, 2400));
  const height = Math.max(240, Math.min(Number(snapshot?.height) || 800, 1800));
  const items = Array.isArray(snapshot?.items) ? snapshot.items : [];
  const lines = [];
  lines.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`);
  lines.push(`<rect width="100%" height="100%" fill="${escapeXml(snapshot?.background || "#ffffff")}"/>`);
  lines.push(`<text x="18" y="28" font-family="Arial, sans-serif" font-size="16" font-weight="700" fill="#1f2937">${escapeXml(snapshot?.title || "Browser snapshot")}</text>`);
  lines.push(`<text x="18" y="50" font-family="Arial, sans-serif" font-size="11" fill="#6b7280">${escapeXml(snapshot?.url || "")}</text>`);
  if (reason) lines.push(`<text x="18" y="70" font-family="Arial, sans-serif" font-size="10" fill="#9ca3af">fallback: ${escapeXml(reason)}</text>`);
  for (const item of items.slice(0, 120)) {
    const x = Math.max(0, Math.round(Number(item.x) || 0));
    const y = Math.max(80, Math.round(Number(item.y) || 0));
    const w = Math.max(20, Math.round(Number(item.width) || 120));
    const h = Math.max(16, Math.round(Number(item.height) || 24));
    const label = escapeXml(String(item.text || "").slice(0, 140));
    const stroke = item.interactive ? "#2563eb" : "#d1d5db";
    const fill = item.interactive ? "#eff6ff" : "rgba(255,255,255,0.78)";
    lines.push(`<rect x="${x}" y="${y}" width="${Math.min(w, width - x)}" height="${Math.min(h, height - y)}" rx="4" fill="${fill}" stroke="${stroke}" stroke-width="1"/>`);
    if (label) {
      const fontSize = Math.max(10, Math.min(15, h - 6));
      lines.push(`<text x="${x + 6}" y="${y + Math.min(h - 5, fontSize + 5)}" font-family="Arial, sans-serif" font-size="${fontSize}" fill="#111827">${label}</text>`);
    }
  }
  lines.push("</svg>");
  return lines.join("");
}

async function captureDomSnapshot(tab, reason) {
  const injection = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      const width = Math.max(document.documentElement.clientWidth || 0, window.innerWidth || 0);
      const height = Math.max(document.documentElement.clientHeight || 0, window.innerHeight || 0);
      const background = getComputedStyle(document.body || document.documentElement).backgroundColor || "#ffffff";
      const candidates = Array.from(document.body?.querySelectorAll("h1,h2,h3,p,a,button,input,select,textarea,label,li,summary,[role='button'],[role='link']") || []);
      const items = candidates
        .map((el) => {
          const rect = el.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return null;
          if (rect.bottom < 0 || rect.top > height || rect.right < 0 || rect.left > width) return null;
          const style = getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return null;
          const tag = el.tagName.toLowerCase();
          const interactive = ["a", "button", "input", "select", "textarea", "summary"].includes(tag) || Boolean(el.getAttribute("role"));
          const text = (el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.innerText || el.value || el.textContent || tag).trim();
          return { x: rect.left, y: rect.top, width: rect.width, height: rect.height, text, interactive };
        })
        .filter(Boolean);
      if (!items.length) {
        items.push({ x: 18, y: 92, width: width - 36, height: 80, text: (document.body?.innerText || document.title || location.href).slice(0, 500), interactive: false });
      }
      return { width, height, background, title: document.title, url: location.href, items };
    }
  });
  const svg = buildSvgSnapshot(injection[0]?.result || {}, reason);
  return {
    content: [
      { type: "image", mimeType: "image/svg+xml", data: base64Utf8(svg) },
      { type: "text", text: `Synthetic DOM snapshot from tab ${tab.id}` }
    ]
  };
}

async function autoScrollPage(tabId, steps) {
  const maxSteps = Math.max(0, Math.min(Number(steps) || 0, 40));
  if (!maxSteps) return;
  await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: async (count) => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      let lastY = -1;
      for (let i = 0; i < count; i += 1) {
        window.scrollBy(0, Math.max(500, Math.floor(window.innerHeight * 0.85)));
        await wait(450);
        if (window.scrollY === lastY) break;
        lastY = window.scrollY;
      }
      await wait(250);
      window.scrollTo(0, 0);
    },
    args: [maxSteps]
  });
}

async function extractPage(tab, args) {
  if (args.autoScroll !== false) {
    await autoScrollPage(tab.id, args.scrollSteps || 8);
  }
  const injection = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: "MAIN",
    func: (options) => {
      const maxItems = Math.max(20, Math.min(Number(options.maxItems) || 200, 2000));
      const maxTextChars = Math.max(1000, Math.min(Number(options.maxTextChars) || 50000, 300000));
      const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const trim = (value, size = 600) => clean(value).slice(0, size);
      const absUrl = (value) => {
        if (!value) return "";
        try {
          return new URL(value, document.baseURI).href;
        } catch (_) {
          return String(value);
        }
      };
      const rectOf = (el) => {
        const rect = el.getBoundingClientRect();
        return {
          x: Math.round(rect.x),
          y: Math.round(rect.y + window.scrollY),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        };
      };
      const visible = (el) => {
        if (!(el instanceof Element)) return false;
        const style = getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const labelFor = (el) => {
        if (el.labels && el.labels.length) return clean(Array.from(el.labels).map((label) => label.innerText).join(" "));
        const id = el.getAttribute("id");
        if (id) {
          const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
          if (label) return clean(label.innerText);
        }
        const wrapped = el.closest("label");
        if (wrapped) return clean(wrapped.innerText);
        return clean(el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("name") || "");
      };
      const fieldValue = (el) => {
        if (el.tagName === "SELECT") {
          return Array.from(el.selectedOptions || []).map((option) => option.value || option.textContent).join(", ");
        }
        if (el.type === "checkbox" || el.type === "radio") return Boolean(el.checked);
        return trim(el.value, 300);
      };
      const limited = (items) => items.slice(0, maxItems);
      const metaTags = {};
      for (const meta of Array.from(document.querySelectorAll("meta"))) {
        const key = meta.getAttribute("name") || meta.getAttribute("property") || meta.getAttribute("http-equiv");
        if (key) metaTags[key] = meta.getAttribute("content") || "";
      }
      const jsonLd = limited(Array.from(document.querySelectorAll('script[type*="ld+json"]'))).map((script) => {
        const raw = script.textContent || "";
        try {
          return JSON.parse(raw);
        } catch (_) {
          return { parseError: true, raw: raw.slice(0, 2000) };
        }
      });
      const headings = limited(Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6")).map((el) => ({
        level: Number(el.tagName.slice(1)),
        text: trim(el.innerText, 500),
        visible: visible(el),
        rect: rectOf(el)
      })).filter((item) => item.text));
      const paragraphs = limited(Array.from(document.querySelectorAll("p,article li,main li")).map((el) => trim(el.innerText, 1000)).filter((text) => text.length > 20));
      const links = limited(Array.from(document.querySelectorAll("a[href]")).map((el) => ({
        text: trim(el.innerText || el.getAttribute("aria-label") || el.getAttribute("title"), 300),
        href: absUrl(el.getAttribute("href")),
        title: el.getAttribute("title") || "",
        rel: el.getAttribute("rel") || "",
        target: el.getAttribute("target") || "",
        visible: visible(el),
        rect: rectOf(el)
      })).filter((item) => item.href));
      const images = limited(Array.from(document.images).map((img) => ({
        src: absUrl(img.currentSrc || img.src),
        srcset: img.getAttribute("srcset") || "",
        alt: img.getAttribute("alt") || "",
        title: img.getAttribute("title") || "",
        loading: img.getAttribute("loading") || "",
        naturalWidth: img.naturalWidth || 0,
        naturalHeight: img.naturalHeight || 0,
        visible: visible(img),
        rect: rectOf(img)
      })).filter((item) => item.src));
      const backgroundImages = limited(Array.from(document.querySelectorAll("body *")).map((el) => {
        const bg = getComputedStyle(el).backgroundImage || "";
        const matches = Array.from(bg.matchAll(/url\(["']?([^"')]+)["']?\)/g)).map((match) => absUrl(match[1]));
        if (!matches.length) return null;
        return { urls: matches, text: trim(el.innerText, 160), visible: visible(el), rect: rectOf(el) };
      }).filter(Boolean));
      const media = limited(Array.from(document.querySelectorAll("video,audio")).map((el) => ({
        tag: el.tagName.toLowerCase(),
        src: absUrl(el.currentSrc || el.src || ""),
        poster: absUrl(el.getAttribute("poster") || ""),
        controls: Boolean(el.controls),
        autoplay: Boolean(el.autoplay),
        muted: Boolean(el.muted),
        loop: Boolean(el.loop),
        duration: Number.isFinite(el.duration) ? el.duration : null,
        readyState: el.readyState,
        sources: Array.from(el.querySelectorAll("source")).map((source) => ({ src: absUrl(source.getAttribute("src")), type: source.getAttribute("type") || "" })),
        tracks: Array.from(el.querySelectorAll("track")).map((track) => ({ src: absUrl(track.getAttribute("src")), kind: track.getAttribute("kind") || "", label: track.getAttribute("label") || "" })),
        visible: visible(el),
        rect: rectOf(el)
      })));
      const embeds = limited(Array.from(document.querySelectorAll("iframe,embed,object")).map((el) => ({
        tag: el.tagName.toLowerCase(),
        src: absUrl(el.getAttribute("src") || el.getAttribute("data") || ""),
        title: el.getAttribute("title") || el.getAttribute("aria-label") || "",
        type: el.getAttribute("type") || "",
        visible: visible(el),
        rect: rectOf(el)
      })));
      const forms = limited(Array.from(document.forms).map((form) => ({
        id: form.id || "",
        name: form.getAttribute("name") || "",
        action: absUrl(form.getAttribute("action") || location.href),
        method: (form.getAttribute("method") || "get").toLowerCase(),
        fields: Array.from(form.querySelectorAll("input,select,textarea,button")).map((el) => ({
          tag: el.tagName.toLowerCase(),
          type: (el.getAttribute("type") || "").toLowerCase(),
          name: el.getAttribute("name") || "",
          id: el.id || "",
          label: labelFor(el),
          placeholder: el.getAttribute("placeholder") || "",
          value: fieldValue(el),
          required: Boolean(el.required),
          disabled: Boolean(el.disabled),
          options: el.tagName === "SELECT" ? Array.from(el.options).map((option) => ({ text: clean(option.text), value: option.value, selected: option.selected })) : undefined,
          visible: visible(el),
          rect: rectOf(el)
        }))
      })));
      const tables = limited(Array.from(document.querySelectorAll("table")).map((table) => {
        const rows = Array.from(table.rows).slice(0, 50).map((row) => Array.from(row.cells).slice(0, 20).map((cell) => trim(cell.innerText, 300)));
        return { caption: trim(table.caption?.innerText || "", 300), rows, visible: visible(table), rect: rectOf(table) };
      }));
      const interactive = limited(Array.from(document.querySelectorAll("a[href],button,input,select,textarea,summary,[role='button'],[role='link'],[contenteditable='true']")).map((el) => ({
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute("role") || "",
        text: trim(el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("title"), 300),
        href: el.tagName === "A" ? absUrl(el.getAttribute("href")) : "",
        type: el.getAttribute("type") || "",
        visible: visible(el),
        rect: rectOf(el)
      })));
      const resources = options.includeResources === false ? [] : limited(performance.getEntriesByType("resource").map((entry) => ({
        url: entry.name,
        type: entry.initiatorType,
        duration: Math.round(entry.duration),
        transferSize: entry.transferSize || 0,
        encodedBodySize: entry.encodedBodySize || 0
      })));
      const text = clean(document.body?.innerText || "").slice(0, maxTextChars);
      return {
        meta: {
          url: location.href,
          canonical: absUrl(document.querySelector('link[rel="canonical"]')?.getAttribute("href") || ""),
          title: document.title,
          lang: document.documentElement.lang || "",
          charset: document.characterSet,
          description: metaTags.description || metaTags["og:description"] || "",
          openGraph: Object.fromEntries(Object.entries(metaTags).filter(([key]) => key.startsWith("og:"))),
          twitter: Object.fromEntries(Object.entries(metaTags).filter(([key]) => key.startsWith("twitter:"))),
          viewport: { width: window.innerWidth, height: window.innerHeight, scrollHeight: document.documentElement.scrollHeight }
        },
        text: { length: text.length, visibleText: text, headings, paragraphs },
        links,
        images,
        backgroundImages,
        media,
        embeds,
        forms,
        tables,
        interactive,
        structuredData: jsonLd,
        resources,
        counts: {
          links: links.length,
          images: images.length,
          backgroundImages: backgroundImages.length,
          media: media.length,
          embeds: embeds.length,
          forms: forms.length,
          tables: tables.length,
          interactive: interactive.length,
          structuredData: jsonLd.length,
          resources: resources.length
        },
        extractedAt: new Date().toISOString()
      };
    },
    args: [{
      maxItems: args.maxItems,
      maxTextChars: args.maxTextChars || args.max_text_chars,
      includeResources: args.includeResources ?? args.include_resources,
    }]
  });
  const extracted = injection[0]?.result || {};
  // Surface the bot-check verdict here too. A crawler that only calls
  // extract_page would otherwise happily "extract" a challenge page.
  try {
    const state = await sendToContent(tab.id, { type: "atria.pageState" });
    if (state?.ok) extracted.pageState = state.state;
  } catch (_) {}
  return contentResult(extracted);
}

async function captureScreenshot(tab) {
  let data = "";
  let method = "tabs.captureVisibleTab";
  // captureVisibleTab only takes a windowId, so it grabs whatever tab is visible
  // there and ignores tab.id. On a background tab that returns a picture of the
  // page the user is actually looking at. Restrict it to the active tab and let
  // CDP handle the rest, since Page.captureScreenshot targets the tab directly.
  if (tab.active) {
    try {
      const dataUrl = await withTimeout(
        chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 70 }),
        5000,
        "tabs.captureVisibleTab timeout"
      );
      [, data = ""] = dataUrl.split(",");
    } catch (_) {
      data = "";
    }
  }
  if (!data) {
    method = "debugger.Page.captureScreenshot";
    try {
      const result = await withTimeout(
        withDebugger(tab.id, async (cdp) => {
          await cdp("Page.enable");
          return cdp("Page.captureScreenshot", { format: "jpeg", quality: 70, fromSurface: true });
        }),
        10000,
        "debugger.Page.captureScreenshot timeout"
      );
      data = result?.data || "";
    } catch (error) {
      return captureDomSnapshot(tab, error.message || String(error));
    }
  }
  if (!data) return captureDomSnapshot(tab, "screenshot capture returned empty image");
  return {
    content: [
      { type: "image", mimeType: "image/jpeg", data },
      { type: "text", text: `Viewport screenshot from tab ${tab.id} via ${method}` }
    ]
  };
}

async function executeTool(name, args) {
  if (name === "browser_status") {
    const active = await getActiveTab();
    return contentResult({
      ok: true,
      extensionId: chrome.runtime.id,
      version: EXTENSION_VERSION,
      nativeConnected,
      activeTab: active ? { id: active.id, url: active.url, title: active.title, windowId: active.windowId } : null
    });
  }

  if (name === "tabs_context") {
    const tabs = await chrome.tabs.query({});
    let agentGroup = null;
    const groupId = await getStoredAgentGroupId();
    if (groupId !== null) {
      try {
        const group = await chrome.tabGroups.get(groupId);
        agentGroup = { id: group.id, title: group.title, color: group.color, collapsed: group.collapsed, windowId: group.windowId };
      } catch (_) {
        agentGroup = null;
      }
    }
    return contentResult({
      agentGroup,
      tabs: tabs.map((tab) => ({
        id: tab.id,
        windowId: tab.windowId,
        groupId: tab.groupId,
        isAgentTab: agentGroup ? tab.groupId === agentGroup.id : false,
        active: tab.active,
        title: tab.title,
        url: tab.url
      }))
    });
  }

  if (name === "tabs_create") {
    const tab = await chrome.tabs.create({ url: args.url || "about:blank", active: args.active !== false });
    let groupId = tab.groupId;
    // 强制进 Atria Agent group,LLM 不可绕过(忽略 args.group 旧字段)
    if (tab.id !== undefined) {
      groupId = await groupAgentTab(tab.id);
    }
    return contentResult({ id: tab.id, windowId: tab.windowId, groupId, agentGroupTitle: groupId >= 0 ? AGENT_GROUP_TITLE : null, url: tab.url, title: tab.title });
  }

  if (name === "tabs_close") {
    if (args.tabId === undefined || args.tabId === null) throw new Error("tabId is required");
    await chrome.tabs.remove(Number(args.tabId));
    return contentResult({ closed: true, tabId: Number(args.tabId) });
  }

  if (name === "navigate") {
    const tab = await resolveTab(args.tabId);
    if (args.direction === "back") {
      await chrome.tabs.goBack(tab.id);
      await waitForTabLoad(tab.id, 10000);
      return contentResult({ navigated: true, direction: "back", tabId: tab.id });
    }
    if (args.direction === "forward") {
      await chrome.tabs.goForward(tab.id);
      await waitForTabLoad(tab.id, 10000);
      return contentResult({ navigated: true, direction: "forward", tabId: tab.id });
    }
    if (!args.url) throw new Error("url is required");
    const wait = waitForTabLoad(tab.id, Number(args.timeoutMs || 30000));
    await chrome.tabs.update(tab.id, { url: args.url });
    await wait;
    const next = await chrome.tabs.get(tab.id);
    return contentResult({ navigated: true, tabId: tab.id, url: next.url, title: next.title });
  }

  if (name === "read_page") {
    const tab = await resolveTab(args.tabId);
    const result = await sendToContent(tab.id, {
      type: "atria.readPage",
      options: {
        filter: args.filter || "all",
        depth: args.depth || 15,
        maxChars: args.maxChars || args.max_chars || 50000
      }
    });
    if (!result?.ok) return toolError(result?.message || "read_page failed", result);
    return {
      content: [
        {
          type: "text",
          text: [
            `URL: ${result.result.url}`,
            `Title: ${result.result.title}`,
            "",
            result.result.tree
          ].join("\n")
        }
      ]
    };
  }

  if (name === "get_page_text") {
    const tab = await resolveTab(args.tabId);
    const result = await sendToContent(tab.id, { type: "atria.getPageText", maxChars: args.maxChars || args.max_chars || 50000 });
    if (!result?.ok) return toolError(result?.message || "get_page_text failed", result);
    return contentResult(result.result);
  }

  if (name === "extract_page") {
    const tab = await resolveTab(args.tabId);
    return extractPage(tab, args);
  }

  if (name === "find") {
    const tab = await resolveTab(args.tabId);
    const result = await sendToContent(tab.id, { type: "atria.find", query: args.query });
    if (!result?.ok) return toolError(result?.message || "find failed", result);
    return contentResult(result.result);
  }

  if (name === "form_input") {
    const tab = await resolveTab(args.tabId);
    const result = await sendToContent(tab.id, { type: "atria.formInput", ref: args.ref, value: args.value });
    if (!result?.ok) return toolError(result?.message || "form_input failed", result);
    return contentResult({ filled: true, verified: true, ref: args.ref, length: result.length, checked: result.checked });
  }

  if (name === "file_upload") {
    const tab = await resolveTab(args.tabId);
    const result = await setFileInputFiles(tab.id, args);
    return contentResult(result);
  }

  if (name === "javascript_tool") {
    const tab = await resolveTab(args.tabId);
    const text = args.text || args.code || "";
    const injection = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: async (source) => eval(source),
      args: [text]
    });
    return contentResult({ result: injection[0]?.result });
  }

  if (name === "computer") {
    const tab = await resolveTab(args.tabId);
    const action = args.action;
    await setIndicator(tab.id, true);
    try {
      if (action === "screenshot") return await captureScreenshot(tab);
      if (action === "wait") {
        await sleep(Math.min(Number(args.duration || args.durationMs || 1000), 10000));
        return contentResult({ waited: true });
      }
      if (action === "left_click" || action === "right_click" || action === "double_click") {
        let coordinate = args.coordinate;
        // A ref is resolved to live viewport coordinates and then clicked over
        // CDP, same as a coordinate click. Dispatching el.click() here instead
        // would make the ref path silently weaker than the coordinate path:
        // canvas tiles, drag surfaces and many custom widgets ignore synthetic
        // events entirely. Resolving on every call also means stale coordinates
        // cannot be reused across a relayout.
        if (args.ref) {
          const spot = await sendToContent(tab.id, { type: "atria.refRect", ref: args.ref });
          if (!spot?.ok) return toolError(spot?.message || "click failed", spot);
          if (spot.covered) {
            return toolError(
              `${args.ref} is covered by <${spot.hit}> at (${spot.x}, ${spot.y}) — a real click would hit that instead. Dismiss the overlay first.`,
              spot
            );
          }
          coordinate = { x: spot.x, y: spot.y };
        }
        await clickAt(tab.id, coordinate, action === "right_click" ? "right" : "left", action === "double_click" ? 2 : 1);
        await sleep(800);
        return contentResult({ clicked: true, ...(args.ref ? { ref: args.ref } : {}), coordinate });
      }
      if (action === "type") {
        const text = args.text || "";
        if (args.ref) {
          const spot = await sendToContent(tab.id, { type: "atria.refRect", ref: args.ref });
          if (!spot?.ok) return toolError(spot?.message || "type failed", spot);
          await clickAt(tab.id, { x: spot.x, y: spot.y });
          await sleep(150);
        }
        await typeText(tab.id, text);
        if (!args.ref) return contentResult({ typed: true });
        // Typing is only believable once the field reads back. Real key events
        // append rather than replace, so the check is containment, not equality.
        await sleep(150);
        const check = await sendToContent(tab.id, { type: "atria.readValue", ref: args.ref });
        const actual = check?.ok ? check.value : "";
        if (text && !actual.includes(text)) {
          return toolError(
            `typed into ${args.ref} but it reads back without the text (${actual.length} chars present). The field may have rejected the input or moved focus.`,
            { typed: false, ref: args.ref, verified: false, actual: actual.slice(0, 200) }
          );
        }
        return contentResult({ typed: true, ref: args.ref, verified: true, length: actual.length });
      }
      if (action === "key") {
        await pressKey(tab.id, args.text || args.key || "Enter");
        return contentResult({ pressed: true, key: args.text || args.key || "Enter" });
      }
      if (action === "scroll") {
        const result = await sendToContent(tab.id, {
          type: "atria.scroll",
          direction: args.scroll_direction || args.direction || "down",
          amount: args.scroll_amount || args.amount || 600
        });
        if (!result?.ok) return toolError(result?.message || "scroll failed", result);
        return contentResult({ scrolled: true });
      }
      if (action === "scroll_to") {
        const result = await sendToContent(tab.id, { type: "atria.scrollToRef", ref: args.ref });
        if (!result?.ok) return toolError(result?.message || "scroll_to failed", result);
        return contentResult({ scrolled: true, ref: args.ref });
      }
      return toolError(`Unsupported computer action: ${action}`);
    } finally {
      await setIndicator(tab.id, false);
    }
  }

  if (name === "wait_for") {
    const tab = await resolveTab(args.tabId);
    const timeoutMs = Math.max(1000, Math.min(Number(args.timeoutMs || 30000), 900000));
    const pollMs = Math.max(200, Math.min(Number(args.pollMs || 1000), 10000));
    const condition = {
      text: args.text,
      selector: args.selector,
      urlRegex: args.urlRegex,
      gone: Boolean(args.gone),
      challengeGone: Boolean(args.challengeGone)
    };
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      try {
        last = await sendToContent(tab.id, { type: "atria.checkCondition", condition });
        if (last?.error) return toolError(last.error, { code: "BAD_ARGS" });
        if (last?.met) {
          return contentResult({ ok: true, waitedMs: timeoutMs - (deadline - Date.now()), state: last.state });
        }
      } catch (error) {
        // A navigation tears the content script down mid-poll; that is expected
        // while waiting for a page to change, so keep polling until the deadline.
        last = { state: { error: error?.message || String(error) } };
      }
      await sleep(pollMs);
    }
    return toolError(`wait_for timed out after ${timeoutMs}ms`, { code: "TIMEOUT", ok: false, reason: "timeout", state: last?.state || null });
  }

  if (name === "cdp_tool") {
    const tab = await resolveTab(args.tabId);
    const method = String(args.method || "");
    if (!method) return toolError("method is required", { code: "BAD_ARGS" });
    if (CDP_DENIED.test(method)) {
      return toolError(`CDP method refused: ${method}. This bridge drives pages, not the browser process.`, { code: "CDP_REFUSED" });
    }
    // Reuse a persistent session when one exists so capture and blocking are not
    // torn down by a one-shot call attaching and detaching underneath them.
    if (cdpSessions.has(tab.id)) {
      const result = await cdpSend(tab.id, method, args.params || {});
      return contentResult({ method, result });
    }
    const result = await withDebugger(tab.id, (cdp) => cdp(method, args.params || {}));
    return contentResult({ method, result });
  }

  if (name === "network_start") {
    const tab = await resolveTab(args.tabId);
    const session = await attachPersistent(tab.id, "network");
    session.network = { records: [], truncated: false, filter: args.filter || null };
    await cdpSend(tab.id, "Network.enable", {});
    return contentResult({ capturing: true, tabId: tab.id, maxRecords: NETWORK_MAX_RECORDS });
  }

  if (name === "network_stop") {
    const tab = await resolveTab(args.tabId);
    const session = cdpSessions.get(tab.id);
    if (!session?.network) return contentResult({ capturing: false, tabId: tab.id });
    const captured = session.network.records.length;
    session.network = null;
    try {
      await cdpSend(tab.id, "Network.disable", {});
    } catch (_) {}
    await detachPersistent(tab.id, "network");
    return contentResult({ capturing: false, tabId: tab.id, captured });
  }

  if (name === "network_list") {
    const tab = await resolveTab(args.tabId);
    const capture = cdpSessions.get(tab.id)?.network;
    if (!capture) return toolError("network capture is not running for this tab; call network_start first", { code: "NOT_CAPTURING" });
    const filter = args.filter || capture.filter;
    const rows = capture.records.filter((record) => networkMatches(record, filter));
    return contentResult({
      tabId: tab.id,
      truncated: capture.truncated,
      total: capture.records.length,
      matched: rows.length,
      requests: rows.map((record) => ({
        requestId: record.requestId,
        method: record.method,
        status: record.status,
        resourceType: record.resourceType,
        mimeType: record.mimeType,
        bytes: record.encodedDataLength,
        failed: record.failed,
        url: record.url
      }))
    });
  }

  if (name === "network_detail") {
    const tab = await resolveTab(args.tabId);
    const capture = cdpSessions.get(tab.id)?.network;
    if (!capture) return toolError("network capture is not running for this tab; call network_start first", { code: "NOT_CAPTURING" });
    const record = capture.records.find((item) => item.requestId === args.requestId);
    if (!record) return toolError(`unknown requestId: ${args.requestId}`, { code: "NOT_FOUND" });
    const detail = { ...record };
    if (args.includeBody) {
      try {
        const body = await cdpSend(tab.id, "Network.getResponseBody", { requestId: args.requestId });
        const text = String(body?.body || "");
        detail.body = text.slice(0, NETWORK_MAX_BODY_BYTES);
        detail.bodyBase64Encoded = Boolean(body?.base64Encoded);
        detail.bodyTruncated = text.length > NETWORK_MAX_BODY_BYTES;
      } catch (error) {
        detail.bodyError = error?.message || String(error);
      }
    }
    return contentResult(detail);
  }

  if (name === "set_request_blocking") {
    const tab = await resolveTab(args.tabId);
    const resourceTypes = (args.resourceTypes || []).map((item) => String(item).toLowerCase());
    const urlPatterns = (args.urlPatterns || []).map(
      (pattern) => new RegExp(String(pattern).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*"), "i")
    );
    if (!resourceTypes.length && !urlPatterns.length) {
      return toolError("give at least one of resourceTypes or urlPatterns", { code: "BAD_ARGS" });
    }
    const session = await attachPersistent(tab.id, "blocking");
    session.blocking = { resourceTypes, urlPatterns, blocked: 0 };
    // Fetch.enable pauses every request so the handler can decide. Patterns stay
    // wide open here because resourceType filtering happens in the handler.
    await cdpSend(tab.id, "Fetch.enable", { patterns: [{ urlPattern: "*" }] });
    return contentResult({ blocking: true, tabId: tab.id, resourceTypes, urlPatterns: args.urlPatterns || [] });
  }

  if (name === "clear_request_blocking") {
    const tab = await resolveTab(args.tabId);
    const session = cdpSessions.get(tab.id);
    if (!session?.blocking) return contentResult({ blocking: false, tabId: tab.id });
    const blocked = session.blocking.blocked;
    session.blocking = null;
    try {
      await cdpSend(tab.id, "Fetch.disable", {});
    } catch (_) {}
    await detachPersistent(tab.id, "blocking");
    return contentResult({ blocking: false, tabId: tab.id, blocked });
  }

  if (name === "browser_batch") {
    const outputs = [];
    const actions = Array.isArray(args.actions) ? args.actions : [];
    for (const item of actions) {
      const result = await executeTool(item.name, item.input || item.arguments || {});
      outputs.push({ name: item.name, result });
      if (result?.isError) break;
    }
    return contentResult(outputs);
  }

  return toolError(`Tool not implemented in extension: ${name}`);
}

async function handleEnvelope(envelope) {
  const result = await executeTool(envelope.tool || envelope.name, envelope.args || envelope.arguments || {});
  return {
    id: envelope.id,
    ok: !result?.isError,
    result
  };
}

async function pollOnce() {
  const clientId = await getClientId();
  const base = await bridgeBase("http");
  const response = await fetch(`${base}/extension/next?clientId=${encodeURIComponent(clientId)}&version=${encodeURIComponent(EXTENSION_VERSION)}`, {
    cache: "no-store"
  });
  if (response.status === 204) return;
  if (!response.ok) throw new Error(`bridge HTTP ${response.status}`);
  const envelope = await response.json();
  const payload = await handleEnvelope(envelope).catch((error) => ({
    id: envelope.id,
    ok: false,
    result: toolError(error?.message || String(error))
  }));
  await postJson("/extension/result", payload);
}

async function pollLoop() {
  if (polling) return;
  polling = true;
  while (true) {
    try {
      await pollOnce();
      await sleep(350);
    } catch (_) {
      await sleep(1500);
    }
  }
}

function scheduleWakeAlarm() {
  try {
    chrome.alarms.create(WAKE_ALARM, { periodInMinutes: 0.5 });
  } catch (_) {}
}

function connectNative() {
  if (nativePort) return;
  try {
    nativePort = chrome.runtime.connectNative("com.atria.browser_bridge");
    nativePort.onMessage.addListener(async (message) => {
      if (!message || !message.id) return;
      const payload = await handleEnvelope(message).catch((error) => ({
        id: message.id,
        ok: false,
        result: toolError(error?.message || String(error))
      }));
      nativePort.postMessage(payload);
    });
    nativePort.onDisconnect.addListener(() => {
      nativeConnected = false;
      nativePort = null;
      pollLoop();
    });
    nativeConnected = true;
    nativePort.postMessage({ type: "hello", extensionId: chrome.runtime.id, version: EXTENSION_VERSION });
  } catch (_) {
    nativeConnected = false;
    pollLoop();
  }
}

chrome.runtime.onInstalled.addListener(() => {
  getClientId();
  connectNative();
  connectSocket();
  scheduleWakeAlarm();
});

chrome.runtime.onStartup.addListener(() => {
  connectNative();
  connectSocket();
  scheduleWakeAlarm();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message && message.type === "atria.setBridgePort") {
    const port = normalizeBridgePort(message.port);
    chrome.storage.local.set({ [BRIDGE_PORT_KEY]: port }).then(() => {
      try {
        bridgeSocket?.close();
      } catch (_) {}
      bridgeSocket = null;
      connectSocket();
      pollLoop();
      sendResponse({ ok: true, port });
    });
    return true;
  }
  if (message && message.type === "atria.wake") {
    connectNative();
    connectSocket();
    pollLoop();
    scheduleWakeAlarm();
    sendResponse({ ok: true, nativeConnected, socketConnected: bridgeSocket?.readyState === WebSocket.OPEN });
    return true;
  }
  return false;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === WAKE_ALARM) {
    connectSocket();
    pollLoop();
  }
});

connectNative();
connectSocket();
scheduleWakeAlarm();
pollLoop();
