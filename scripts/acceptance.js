#!/usr/bin/env node
/**
 * Browser-side acceptance suite.
 *
 * smoke-mcp.js proves the MCP contract without a browser. This proves the
 * behaviour that only exists once Chrome and the extension are in the loop —
 * every fix and feature here was a real reported failure, so each case is a
 * regression guard rather than a demo.
 *
 * Requires: bridge running, extension loaded and connected.
 *   node scripts/acceptance.js
 */
const http = require('http');

const PORT = Number(process.env.ATRIA_BROWSER_PORT || 47652);
const FIXTURE_PORT = Number(process.env.ATRIA_FIXTURE_PORT || 8099);
const base = (name) => `http://127.0.0.1:${FIXTURE_PORT}/${name}`;
const GROUP = 'Atria acceptance';

function call(name, args) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify({ name, arguments: args || {} }), 'utf8');
    const req = http.request(
      {
        host: '127.0.0.1', port: PORT, path: '/tools/call', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
      },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (buf += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(buf));
          } catch (error) {
            reject(new Error(`bad response for ${name}: ${buf.slice(0, 200)}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

const text = (r) => (r?.result?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
const json = (r) => { try { return JSON.parse(text(r)); } catch (_) { return null; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}\n      ${String(detail).replace(/\s+/g, ' ').slice(0, 150)}`);
}

// browser_status is answered by the server alone, so it says nothing about
// whether the extension is ready to take work — after a reload its poll loop
// needs a moment to come back. Wait for a command it actually has to serve.
async function waitForExtension(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    const probe = await call('tabs_context', {});
    if (!probe?.result?.isError) return;
    last = text(probe).slice(0, 120);
    await sleep(750);
  }
  throw new Error(`extension did not become ready within ${timeoutMs}ms: ${last}`);
}

async function main() {
  const health = await call('browser_status', {});
  const status = json(health);
  if (!status?.bridgeState?.lastSeenAt) {
    throw new Error('extension is not connected — load it at chrome://extensions and open the popup once');
  }
  await waitForExtension();
  if ((status.extensionProtocolVersion ?? 1) < status.protocolVersion) {
    throw new Error(`extension speaks protocol ${status.extensionProtocolVersion}, server expects ${status.protocolVersion} — reload the extension`);
  }

  const opened = [];
  const open = async (url, active = false) => {
    const tab = json(await call('tabs_create', { url, active, groupTitle: GROUP }));
    opened.push(tab.id);
    // Pin a viewport for the tab under test. Otherwise the suite silently
    // depends on the size of whatever window Chrome happens to have open — a
    // minimized one reports 0x0, every coordinate becomes meaningless, and
    // clicking and scrolling fail for reasons that have nothing to do with the
    // code being tested.
    await call('cdp_tool', {
      tabId: tab.id,
      method: 'Emulation.setDeviceMetricsOverride',
      params: { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false },
    });
    await sleep(1200);
    return tab;
  };

  try {
    // Tree traversal: every card must be reachable, including the deepest.
    const listing = await open(base('listing-page.html'), true);
    const tree = text(await call('read_page', { tabId: listing.id, filter: 'interactive', maxChars: 60000 }));
    const refs = (tree.match(/\[ref_\d+\]/g) || []).length;
    check('read_page reaches every card', refs >= 30 && tree.includes('/supplier/30'), `${refs} refs`);

    // scopeSelector must cut the payload, and items/pagination must be right.
    const full = json(await call('extract_page', { tabId: listing.id, autoScroll: false, includeResources: false, maxItems: 100 }));
    const scoped = json(await call('extract_page', { tabId: listing.id, autoScroll: false, includeResources: false, maxItems: 100, scopeSelector: '.grid' }));
    // Assert the property, not a percentage: the page chrome is gone and no
    // card data went with it. A ratio threshold would only measure how much
    // boilerplate this particular fixture happens to carry.
    const shrink = Math.round((1 - scoped.text.length / full.text.length) * 100);
    const chromeGone = full.text.visibleText.includes('廉洁举报') && !scoped.text.visibleText.includes('廉洁举报');
    check(
      'scopeSelector drops the page chrome and keeps the data',
      scoped.scope.matched && chromeGone && scoped.items.length === full.items.length,
      `text -${shrink}%, chrome removed=${chromeGone}, items ${full.items.length} -> ${scoped.items.length}`
    );
    check('items detection finds the cards, not the spacers', scoped.items.length === 30, `${scoped.items.length} items`);
    check('pagination finds the next page', /page=3/.test(scoped.pagination.next || ''), scoped.pagination.next);

    // A write is only real once it reads back.
    const form = await open(base('redaction-form.html'), true);
    const formTree = text(await call('read_page', { tabId: form.id, filter: 'interactive' }));
    const refOf = (needle) => {
      const line = formTree.split('\n').find((l) => l.includes(needle) && l.includes('[ref_'));
      return line ? (line.match(/\[(ref_\d+)\]/) || [])[1] : null;
    };
    const wrote = await call('form_input', { tabId: form.id, ref: refOf('用户名'), value: '验证写入-中文' });
    const dom = json(await call('javascript_tool', { tabId: form.id, text: 'document.querySelector("[name=username]").value' }));
    check(
      'form_input writes, including non-ASCII',
      !wrote.result.isError && String(dom?.result || '').includes('验证写入'),
      `tool=${text(wrote)} dom=${JSON.stringify(dom?.result)}`
    );

    // Simulate a controlled editor that overwrites the value, which is what
    // ProseMirror and Lexical effectively do. readOnly would NOT work here: it
    // blocks user input, not assignment, so the write would legitimately stick.
    await call('javascript_tool', {
      tabId: form.id,
      text: 'const n=document.querySelector("[name=nickname]"); n.addEventListener("input",()=>{n.value="reverted"}); "armed"',
    });
    const rejected = await call('form_input', { tabId: form.id, ref: refOf('老张'), value: 'should-not-stick' });
    check('form_input refuses to claim a write that did not stick', rejected.result.isError && text(rejected).includes('write_not_applied'), text(rejected));

    // The original bug: captureVisibleTab ignores tabId.
    const bg = await open(base('fake-challenge.html'), false);
    const shot = await call('computer', { tabId: bg.id, action: 'screenshot' });
    const method = (text(shot).match(/via ([\w.+]+)/) || [])[1];
    // What matters is that the image is of the requested tab, not how it was
    // obtained. CDP capture and activate-then-capture both target it; plain
    // captureVisibleTab on a background tab returns the wrong page, and a DOM
    // snapshot is not a screenshot at all.
    const targeted = ['debugger.Page.captureScreenshot', 'activate+captureVisibleTab'].includes(method);
    const hasImage = (shot.result.content || []).some((b) => b.type === 'image' && (b.data || '').length > 2000);
    check('background-tab screenshot targets that tab', targeted && hasImage, `via ${method}, image=${hasImage}`);

    const state = json(await call('get_page_text', { tabId: bg.id, maxChars: 500 }));
    check('bot check is detected', state.pageState.challenge === 'cloudflare', state.pageState.title);

    // Arm the clear inside the page: the extension runs one bridge command at a
    // time, so a call issued during the wait would queue behind it.
    await call('javascript_tool', { tabId: bg.id, text: 'setTimeout(atriaClearChallenge, 3000); "armed"' });
    const waited = await call('wait_for', { tabId: bg.id, challengeGone: true, timeoutMs: 20000, pollMs: 500 });
    check('wait_for returns when the challenge clears', !waited.result.isError, text(waited));

    // Capture, then the same page again with blocking on.
    const heavy = await open('about:blank', false);
    await call('network_start', { tabId: heavy.id });
    await call('navigate', { tabId: heavy.id, url: base('heavy-page.html'), timeoutMs: 20000 });
    await sleep(2500);
    const captured = json(await call('network_list', { tabId: heavy.id }));
    check('network capture records requests', captured.requests.length > 0, `${captured.requests.length} requests`);
    await call('network_stop', { tabId: heavy.id });

    const blocked = await open('about:blank', false);
    await call('set_request_blocking', { tabId: blocked.id, resourceTypes: ['image', 'font'] });
    await call('network_start', { tabId: blocked.id });
    await call('navigate', { tabId: blocked.id, url: base('heavy-page.html'), timeoutMs: 20000 });
    await sleep(2500);
    const blockedList = json(await call('network_list', { tabId: blocked.id }));
    const cleared = json(await call('clear_request_blocking', { tabId: blocked.id }));
    const images = blockedList.requests.filter((r) => r.resourceType === 'image');
    check('request blocking drops images', cleared.blocked > 0 && images.every((r) => r.failed), `${cleared.blocked} blocked`);
    await call('network_stop', { tabId: blocked.id });

    // The fixture only loads more tiles on a real wheel event, so this fails
    // outright if scroll ever goes back to window.scrollBy in the page.
    const virtual = await open(base('virtual-list.html'), true);
    const before = json(await call('javascript_tool', { tabId: virtual.id, text: 'document.querySelectorAll(".tile").length' }));
    const scrolled = await call('computer', { tabId: virtual.id, action: 'scroll_until', selector: '[data-tile="60"]', maxSteps: 15 });
    const after = json(await call('javascript_tool', { tabId: virtual.id, text: 'document.querySelectorAll(".tile").length' }));
    check(
      'scroll_until drives a virtual list with real wheel events',
      !scrolled.result.isError && Number(after.result) > Number(before.result),
      `tiles ${before?.result} -> ${after?.result}, ${text(scrolled)}`
    );

    const clicked = await call('computer', {
      tabId: virtual.id, action: 'click_where',
      predicateJs: 'el => el.dataset && el.dataset.tile === "7"',
      selector: '.tile',
      verifyJs: '() => document.querySelector(\'[data-tile="7"]\') !== null',
    });
    check('click_where locates by predicate and clicks for real', !clicked.result.isError, text(clicked));

    const evaluated = json(await call('cdp_tool', { tabId: listing.id, method: 'Runtime.evaluate', params: { expression: '1+1', returnByValue: true } }));
    const refused = await call('cdp_tool', { tabId: listing.id, method: 'Browser.close' });
    check('cdp_tool works and refuses browser-process methods', evaluated?.result?.result?.value === 2 && refused.result.isError, 'Runtime.evaluate ok, Browser.close refused');
  } finally {
    for (const tabId of opened) await call('tabs_close', { tabId }).catch(() => {});
  }

  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  if (failed) process.exit(1);
}

const fixtures = require('./serve-fixtures.js');
main()
  .catch((error) => {
    console.error(`acceptance failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => fixtures.server.close());
