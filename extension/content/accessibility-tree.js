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

  // "prune" — element and its whole subtree are genuinely hidden.
  // "descend" — element itself is not worth reporting, but its children may be
  //             on screen, so keep walking.
  // "show"   — element is visible and reportable.
  function visibilityOf(el) {
    if (!(el instanceof Element)) return "prune";
    const style = window.getComputedStyle(el);
    // display:none and visibility:hidden really do hide descendants, so cutting
    // the subtree is correct. A zero-size box or a transparent wrapper does not:
    // overlay and portal containers routinely have no box of their own while the
    // dialog inside them is fully on screen. Pruning on those was why buttons in
    // popovers never reached the tree.
    if (style.display === "none" || style.visibility === "hidden") return "prune";
    if (Number(style.opacity) === 0) return "descend";
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return "descend";
    return "show";
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
    // 15 was too shallow for real apps: on a plain React page 4 of 52 visible
    // interactive elements already sat below it, and anything inside a dialog
    // sits deeper still. Output size is bounded by maxChars, not by depth.
    const maxDepth = Math.max(1, Math.min(Number(opts.depth || 30), 100));
    const filter = opts.filter || "all";

    function visit(node, depth) {
      if (!(node instanceof Element)) return;
      if (depth > maxDepth || SKIP_TAGS.has(node.tagName)) return;
      const isRootNode = node === document.body || node === document.documentElement;
      const visibility = isRootNode ? "show" : visibilityOf(node);
      if (visibility === "prune") return;

      const role = roleOf(node);
      const interactive = isInteractive(node, role);
      const name = labelFor(node).slice(0, 180);
      const include =
        visibility === "show" &&
        (filter === "interactive" ? interactive : interactive || name || role !== "generic");
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
    const options = opts || {};
    // A dialog's contents sit at the end of a large app's DOM, so a whole-page
    // tree hits maxChars and truncates them away — the overlay looks absent
    // when it is merely last. rootSelector reads just that subtree instead.
    let root = document.body || document.documentElement;
    let rootMatched = null;
    if (options.rootSelector) {
      const scoped = document.querySelector(options.rootSelector);
      rootMatched = Boolean(scoped);
      if (scoped) root = scoped;
    }
    state.entries = walk(root, options);
    const maxChars = Math.max(1000, Math.min(Number(options.maxChars || 50000), 200000));
    const lines = state.entries.map((entry) => entry.line);
    let text = lines.join("\n");
    let truncated = false;
    let droppedLines = 0;
    if (text.length > maxChars) {
      // Truncation cuts from the end, which is where dialogs and late-mounted
      // overlays live. Say how much went missing so it reads as "there is more"
      // rather than "that was the whole page".
      const kept = text.slice(0, maxChars);
      droppedLines = lines.length - kept.split("\n").length;
      text = `${kept}\n...[truncated: ${droppedLines} more elements. Narrow with rootSelector, or use filter:"interactive"]`;
      truncated = true;
    }
    return {
      url: location.href,
      title: document.title,
      tree: text,
      entries: state.entries.filter((entry) => entry.ref).slice(0, 2000),
      truncated,
      droppedLines,
      rootSelector: options.rootSelector || null,
      rootMatched,
      pageState: pageState()
    };
  }

  function findByQuery(query) {
    if (!state.entries.length) generatePageTree({ filter: "all", maxChars: 50000 });
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

  function readValue(el) {
    if (el.isContentEditable) return el.textContent || "";
    if ("value" in el && typeof el.value === "string") return el.value;
    return "";
  }

  function insertIntoEditable(el, text) {
    // Rich editors (ProseMirror, Lexical, Slate, Quill) own their DOM and drop
    // direct textContent writes on the next render. execCommand("insertText")
    // goes through beforeinput/input, which is the path their models listen on.
    el.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    selection.removeAllRanges();
    selection.addRange(range);
    let applied = false;
    try {
      applied = document.execCommand("insertText", false, text);
    } catch (_) {
      applied = false;
    }
    if (!applied) el.textContent = text;
  }

  function setNativeValue(el, text) {
    // React and friends patch the value setter and revert plain assignments on
    // re-render. Going through the prototype setter is what makes their state
    // actually pick the change up.
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value") || {};
    if (typeof setter.set === "function") setter.set.call(el, text);
    else el.value = text;
  }

  function setValue(ref, value) {
    const el = resolveRef(ref);
    if (!el) return { ok: false, code: "not_found", message: `ref not found: ${ref}` };
    const tag = el.tagName;
    const type = (el.getAttribute("type") || "").toLowerCase();
    const wanted = String(value);

    if (type === "checkbox" || type === "radio") {
      el.checked = Boolean(value);
    } else if (tag === "SELECT") {
      el.value = wanted;
    } else if (el.isContentEditable) {
      insertIntoEditable(el, wanted);
    } else if ("value" in el) {
      el.focus();
      setNativeValue(el, wanted);
    } else {
      return { ok: false, code: "not_form_control", message: `${ref} is not writable` };
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));

    if (type === "checkbox" || type === "radio") {
      const applied = el.checked === Boolean(value);
      if (applied) return { ok: true, verified: true, ref, checked: el.checked };
      return { ok: false, verified: false, code: "write_not_applied", ref, checked: el.checked, message: `${ref} did not take the checked state` };
    }

    // Read the field back. An editor that ignores synthetic input still lets the
    // DOM write "succeed", so the write means nothing until the value is
    // confirmed present. Reporting success without this check is how a caller
    // ends up submitting an empty form believing it was filled.
    const actual = readValue(el);
    if (actual.trim() === wanted.trim()) {
      return { ok: true, verified: true, ref, length: actual.length };
    }
    return {
      ok: false,
      verified: false,
      code: "write_not_applied",
      ref,
      expectedLength: wanted.length,
      actualLength: actual.length,
      actual: actual.slice(0, 200),
      message: `${ref} still reads back differently after the write — the editor most likely rejected synthetic input. Retry with computer(action:"type", ref:"${ref}"), which clicks the field and types over real CDP input.`
    };
  }

  function rectForRef(ref) {
    const el = resolveRef(ref);
    if (!el) return { ok: false, code: "not_found", message: `ref not found: ${ref}` };
    el.scrollIntoView({ block: "center", inline: "center" });
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      return { ok: false, code: "not_visible", message: `${ref} has no layout box; it may be hidden or detached` };
    }
    const x = Math.round(rect.left + rect.width / 2);
    const y = Math.round(rect.top + rect.height / 2);
    // Whatever sits at that point is what a real click will hit. If it is not
    // the target or related to it, something is covering the element and the
    // click would land on the overlay instead.
    const hit = document.elementFromPoint(x, y);
    const covered = !hit || !(hit === el || el.contains(hit) || hit.contains(el));
    return {
      ok: true,
      ref,
      x,
      y,
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      covered,
      hit: covered && hit ? hit.tagName.toLowerCase() : null
    };
  }

  // Heuristics for "this page is a bot check, not the content you asked for".
  // Kept as a table so a new provider is one row, not a code change.
  const CHALLENGE_RULES = [
    { kind: "cloudflare", title: /just a moment|checking your browser|attention required/i, selector: "#cf-challenge-running, .cf-browser-verification, [class*='cf-chl'], #challenge-form" },
    { kind: "generic_captcha", selector: "iframe[src*='recaptcha'], iframe[src*='hcaptcha'], iframe[title*='captcha' i], .g-recaptcha, .h-captcha" },
    { kind: "generic_captcha", text: /verify (that )?you are (a )?human|are you a robot|请完成安全验证|人机验证/i }
  ];

  function detectChallenge() {
    const title = document.title || "";
    for (const rule of CHALLENGE_RULES) {
      if (rule.title && rule.title.test(title)) return rule.kind;
      if (rule.selector && document.querySelector(rule.selector)) return rule.kind;
      if (rule.text) {
        const body = (document.body?.innerText || "").slice(0, 4000);
        if (rule.text.test(body)) return rule.kind;
      }
    }
    return null;
  }

  function pageState() {
    return {
      challenge: detectChallenge(),
      readyState: document.readyState,
      url: location.href,
      title: document.title
    };
  }

  function checkCondition(cond) {
    const state = pageState();
    if (cond.challengeGone) return { met: !state.challenge, state };
    if (cond.urlRegex) {
      const met = new RegExp(cond.urlRegex).test(location.href);
      return { met: cond.gone ? !met : met, state };
    }
    if (cond.selector) {
      const found = Boolean(document.querySelector(cond.selector));
      return { met: cond.gone ? !found : found, state };
    }
    if (cond.text) {
      const body = document.body?.innerText || "";
      const found = body.includes(String(cond.text));
      return { met: cond.gone ? !found : found, state };
    }
    return { met: false, state, error: "no condition given" };
  }

  function readValueByRef(ref) {
    const el = resolveRef(ref);
    if (!el) return { ok: false, code: "not_found", message: `ref not found: ${ref}` };
    const value = readValue(el);
    return { ok: true, ref, value: value.slice(0, 2000), length: value.length };
  }

  function scrollToRef(ref) {
    const el = resolveRef(ref);
    if (!el) return { ok: false, code: "not_found", message: `ref not found: ${ref}` };
    el.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
    return { ok: true, ref };
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
        sendResponse({ ok: true, result: { url: location.href, title: document.title, text: text.slice(0, maxChars), truncated: text.length > maxChars, pageState: pageState() } });
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
      if (message.type === "atria.checkCondition") {
        sendResponse({ ok: true, ...checkCondition(message.condition || {}) });
        return true;
      }
      if (message.type === "atria.pageState") {
        sendResponse({ ok: true, state: pageState() });
        return true;
      }
      if (message.type === "atria.viewportCentre") {
        sendResponse({ ok: true, x: Math.round(window.innerWidth / 2), y: Math.round(window.innerHeight / 2) });
        return true;
      }
      if (message.type === "atria.refRect") {
        sendResponse(rectForRef(message.ref));
        return true;
      }
      if (message.type === "atria.readValue") {
        sendResponse(readValueByRef(message.ref));
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
