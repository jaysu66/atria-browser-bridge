(function installAtriaAccessibilityTree() {
  if (window.__atriaAccessibilityTreeInstalled) return;
  window.__atriaAccessibilityTreeInstalled = true;

  const state = {
    nextRef: 1,
    elementToRef: new WeakMap(),
    identity: {},
    entries: []
  };

  window.__atriaBridgeState = state;

  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "META", "LINK", "HEAD", "TEMPLATE"]);
  const INTERACTIVE_TAGS = new Set(["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "SUMMARY", "DETAILS", "OPTION"]);
  const INTERACTIVE_ROLES = new Set([
    "button",
    "link",
    "menuitem",
    "option",
    "radio",
    "checkbox",
    "tab",
    "textbox",
    "combobox",
    "slider",
    "spinbutton",
    "searchbox",
    "switch"
  ]);

  function isVisible(el) {
    if (!(el instanceof Element)) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    return true;
  }

  function roleOf(el) {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit.toLowerCase();
    const tag = el.tagName;
    if (tag === "A" && el.getAttribute("href")) return "link";
    if (tag === "BUTTON") return "button";
    if (tag === "TEXTAREA") return "textbox";
    if (tag === "SELECT") return "combobox";
    if (tag === "INPUT") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "range") return "slider";
      if (type === "search") return "searchbox";
      if (["submit", "button", "reset"].includes(type)) return "button";
      return "textbox";
    }
    if (/^H[1-6]$/.test(tag)) return "heading";
    if (tag === "IMG") return "img";
    if (tag === "NAV") return "navigation";
    if (tag === "MAIN") return "main";
    if (tag === "FORM") return "form";
    return "generic";
  }

  function labelFor(el) {
    const aria = el.getAttribute("aria-label");
    if (aria) return aria.trim();
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent || "")
        .join(" ")
        .trim();
      if (text) return text;
    }
    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label && label.textContent.trim()) return label.textContent.trim();
    }
    const parentLabel = el.closest("label");
    if (parentLabel && parentLabel.textContent.trim()) return parentLabel.textContent.trim();
    if ("placeholder" in el && el.placeholder) return el.placeholder.trim();
    if ("value" in el && typeof el.value === "string" && el.value && el.tagName !== "BUTTON") {
      return el.value.trim();
    }
    if (el.getAttribute("alt")) return el.getAttribute("alt").trim();
    if (el.getAttribute("title")) return el.getAttribute("title").trim();
    return (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
  }

  function isInteractive(el, role) {
    if (INTERACTIVE_TAGS.has(el.tagName)) return true;
    if (INTERACTIVE_ROLES.has(role)) return true;
    if (el.hasAttribute("onclick") || el.hasAttribute("contenteditable")) return true;
    const tabindex = el.getAttribute("tabindex");
    return tabindex !== null && tabindex !== "-1";
  }

  function refFor(el) {
    let ref = state.elementToRef.get(el) || el.getAttribute("data-atria-ref");
    if (!ref) {
      ref = `ref_${state.nextRef++}`;
      state.elementToRef.set(el, ref);
      try {
        el.setAttribute("data-atria-ref", ref);
      } catch (_) {}
    }
    state.identity[ref] = fingerprint(el);
    return ref;
  }

  function fingerprint(el) {
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || "",
      role: el.getAttribute("role") || roleOf(el),
      ariaLabel: el.getAttribute("aria-label") || "",
      testId: el.getAttribute("data-testid") || el.getAttribute("data-test") || "",
      text: (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80)
    };
  }

  function resolveRef(ref) {
    const selector = `[data-atria-ref="${CSS.escape(ref)}"]`;
    return document.querySelector(selector);
  }

  function attrsFor(el) {
    const attrs = [];
    const type = el.getAttribute("type");
    const href = el.getAttribute("href");
    const checked = el.checked === true;
    const selected = el.selected === true;
    if (type) attrs.push(`type="${type}"`);
    if (href) attrs.push(`href="${href}"`);
    if (checked) attrs.push("checked");
    if (selected) attrs.push("selected");
    return attrs.length ? " " + attrs.join(" ") : "";
  }

  function walk(root, opts) {
    const entries = [];
    const maxDepth = Math.max(1, Math.min(Number(opts.depth || 15), 40));
    const filter = opts.filter || "all";

    function visit(node, depth) {
      if (!(node instanceof Element)) return;
      if (depth > maxDepth || SKIP_TAGS.has(node.tagName)) return;
      const isRootNode = node === document.body || node === document.documentElement;
      if (!isRootNode && !isVisible(node)) return;

      const role = roleOf(node);
      const interactive = isInteractive(node, role);
      const name = labelFor(node).slice(0, 180);
      const include = filter === "interactive" ? interactive : interactive || name || role !== "generic";
      if (include) {
        const ref = interactive ? refFor(node) : null;
        const line = `${" ".repeat(depth)}${role}${name ? ` "${name}"` : ""}${ref ? ` [${ref}]` : ""}${attrsFor(node)}`;
        entries.push({
          ref,
          role,
          name,
          tag: node.tagName.toLowerCase(),
          interactive,
          text: name,
          line
        });
      }

      for (const child of Array.from(node.children)) visit(child, depth + 1);
    }

    visit(root, 0);
    return entries;
  }

  function generatePageTree(opts) {
    state.entries = walk(document.body || document.documentElement, opts || {});
    const maxChars = Math.max(1000, Math.min(Number(opts?.maxChars || 50000), 200000));
    let text = state.entries.map((entry) => entry.line).join("\n");
    let truncated = false;
    if (text.length > maxChars) {
      text = text.slice(0, maxChars) + "\n...[truncated]";
      truncated = true;
    }
    return {
      url: location.href,
      title: document.title,
      tree: text,
      entries: state.entries.filter((entry) => entry.ref).slice(0, 500),
      truncated
    };
  }

  function findByQuery(query) {
    if (!state.entries.length) generatePageTree({ filter: "all", depth: 15, maxChars: 50000 });
    const q = String(query || "").toLowerCase().trim();
    if (!q) return [];
    return state.entries
      .filter((entry) => {
        const haystack = [entry.ref, entry.role, entry.name, entry.tag, entry.text].filter(Boolean).join(" ").toLowerCase();
        return haystack.includes(q);
      })
      .filter((entry) => entry.ref)
      .slice(0, 20);
  }

  function setValue(ref, value) {
    const el = resolveRef(ref);
    if (!el) return { ok: false, code: "not_found", message: `ref not found: ${ref}` };
    const tag = el.tagName;
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (type === "checkbox" || type === "radio") {
      el.checked = Boolean(value);
    } else if (tag === "SELECT") {
      el.value = String(value);
    } else if (el.isContentEditable) {
      el.textContent = String(value);
    } else if ("value" in el) {
      el.value = String(value);
    } else {
      return { ok: false, code: "not_form_control", message: `${ref} is not writable` };
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, ref, matches_n: 1, match_level: "exact" };
  }

  function clickRef(ref) {
    const el = resolveRef(ref);
    if (!el) return { ok: false, code: "not_found", message: `ref not found: ${ref}` };
    el.scrollIntoView({ block: "center", inline: "center" });
    el.click();
    return { ok: true, ref, matches_n: 1, match_level: "exact" };
  }

  function scrollToRef(ref) {
    const el = resolveRef(ref);
    if (!el) return { ok: false, code: "not_found", message: `ref not found: ${ref}` };
    el.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
    return { ok: true, ref, matches_n: 1, match_level: "exact" };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== "object") return false;
    try {
      if (message.type === "atria.readPage") {
        sendResponse({ ok: true, result: generatePageTree(message.options || {}) });
        return true;
      }
      if (message.type === "atria.getPageText") {
        const maxChars = Math.max(1000, Math.min(Number(message.maxChars || 50000), 200000));
        const text = (document.body?.innerText || "").replace(/\n{3,}/g, "\n\n");
        sendResponse({ ok: true, result: { url: location.href, title: document.title, text: text.slice(0, maxChars), truncated: text.length > maxChars } });
        return true;
      }
      if (message.type === "atria.find") {
        sendResponse({ ok: true, result: { matches: findByQuery(message.query) } });
        return true;
      }
      if (message.type === "atria.formInput") {
        sendResponse(setValue(message.ref, message.value));
        return true;
      }
      if (message.type === "atria.clickRef") {
        sendResponse(clickRef(message.ref));
        return true;
      }
      if (message.type === "atria.scrollToRef") {
        sendResponse(scrollToRef(message.ref));
        return true;
      }
      if (message.type === "atria.scroll") {
        const amount = Number(message.amount || 600);
        const direction = message.direction === "up" ? -1 : 1;
        window.scrollBy({ top: direction * amount, behavior: "smooth" });
        sendResponse({ ok: true, scrolled: true });
        return true;
      }
    } catch (error) {
      sendResponse({ ok: false, code: "content_error", message: error && error.message ? error.message : String(error) });
      return true;
    }
    return false;
  });
})();
