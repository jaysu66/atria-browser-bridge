(function installAtriaVisualIndicator() {
  if (window.__atriaVisualIndicatorInstalled) return;
  window.__atriaVisualIndicatorInstalled = true;

  const root = document.createElement("div");
  root.id = "atria-agent-visual-indicator";
  root.style.cssText = [
    "position:fixed",
    "left:12px",
    "bottom:12px",
    "z-index:2147483647",
    "display:none",
    "align-items:center",
    "gap:8px",
    "padding:7px 10px",
    "border-radius:999px",
    "font:12px/1.2 system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif",
    "color:#173526",
    "background:rgba(223,243,232,.96)",
    "border:1px solid rgba(39,106,74,.28)",
    "box-shadow:0 8px 28px rgba(0,0,0,.14)",
    "pointer-events:none"
  ].join(";");
  root.innerHTML = '<span style="width:7px;height:7px;border-radius:50%;background:#2f855a;box-shadow:0 0 0 4px rgba(47,133,90,.14)"></span><span>Atria 正在操作浏览器</span>';

  function ensureRoot() {
    if (!document.documentElement.contains(root)) {
      document.documentElement.appendChild(root);
    }
  }

  function setVisible(visible) {
    ensureRoot();
    root.style.display = visible ? "flex" : "none";
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== "object") return false;
    if (message.type === "atria.indicator") {
      setVisible(Boolean(message.visible));
      sendResponse({ ok: true });
      return true;
    }
    return false;
  });
})();
