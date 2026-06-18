// Errand Browser Helper — runs in the user's REAL Chrome. It holds ONE long-lived
// streaming connection to the Errand app (which keeps this MV3 service worker alive and
// delivers commands instantly), runs each command in the active tab (read / click / type
// / screenshot), and POSTs the result back. Because this is the user's normal browser
// (their logins, no automation flags), Google and other sites treat it as a real session.
const BASE = "http://localhost:3200";

function isErrandTab(tab) {
  return !!tab?.url && tab.url.startsWith(BASE);
}

// Persist the work-tab id across service-worker restarts (session storage survives them).
async function getWorkTabId() {
  const r = await chrome.storage.session.get("workTabId");
  return r.workTabId ?? null;
}
async function setWorkTabId(id) {
  await chrome.storage.session.set({ workTabId: id });
}

// The tab the agent works in — NEVER the Errand UI tab. Reuses the focused tab if it's a
// real page; otherwise reuses/creates a dedicated work tab so the UI is left untouched.
async function resolveTab() {
  const saved = await getWorkTabId();
  if (saved != null) {
    try {
      const t = await chrome.tabs.get(saved);
      if (t && !isErrandTab(t)) return t;
    } catch {
      /* tab was closed */
    }
  }
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (active && !isErrandTab(active)) {
    await setWorkTabId(active.id);
    return active;
  }
  // The focused tab is the Errand UI — open a BACKGROUND tab in a labeled "Errand" group
  // (like Claude in Chrome) in this window. It's a background tab, so the user's focus is
  // never stolen; they can click the group to watch the agent live.
  const created = await chrome.tabs.create({ url: "about:blank", active: false });
  await setWorkTabId(created.id);
  await groupTab(created.id);
  return created;
}

// Put the agent's tab into a persistent "Errand" tab group (colored + titled).
async function groupTab(tabId) {
  try {
    const { workGroupId } = await chrome.storage.session.get("workGroupId");
    let groupId;
    if (workGroupId != null) {
      try {
        await chrome.tabGroups.get(workGroupId);
        groupId = await chrome.tabs.group({ tabIds: [tabId], groupId: workGroupId });
      } catch {
        groupId = await chrome.tabs.group({ tabIds: [tabId] });
      }
    } else {
      groupId = await chrome.tabs.group({ tabIds: [tabId] });
    }
    await chrome.tabGroups.update(groupId, { title: "Errand", color: "cyan" });
    await chrome.storage.session.set({ workGroupId: groupId });
  } catch {
    /* tab groups unavailable — proceed ungrouped */
  }
}

function waitComplete(tabId, timeout = 20000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = async () => {
      try {
        const t = await chrome.tabs.get(tabId);
        if (t.status === "complete" || Date.now() - start > timeout) return resolve();
      } catch {
        return resolve();
      }
      setTimeout(check, 300);
    };
    check();
  });
}

// --- functions injected INTO the page (must be self-contained, no outer references) ---
// NOTE: readPage/clickIdx/typeIdx are injected into the page via chrome.scripting.executeScript({func}),
// which serializes ONLY the named function's own body — module-level helpers are NOT carried along.
// So each of these is fully SELF-CONTAINED (helpers inlined), even at the cost of a little duplication.

function readPage() {
  const CAP = 80;
  // STRONG = standard interactive elements (real buttons/links/inputs + ARIA roles).
  const STRONG =
    "a, button, input, textarea, select, [role=button], [role=link], [role=textbox], [role=menuitem], [role=menuitemcheckbox], [role=menuitemradio], [role=combobox], [role=switch], [role=checkbox], [role=radio], [role=tab], [role=option]";
  // WEAK = custom clickables with NO ARIA role — e.g. Gmail's confirm-dialog buttons are
  // `<div jsaction="click:…">` with no role, invisible to STRONG. We surface a WEAK element only
  // when it's a labelled LEAF (has a short text label and contains no STRONG control), so we catch
  // the real div-button without flooding the list with jsaction wrapper containers.
  const WEAK = "[jsaction], [onclick]";
  const seen = new Set();
  const isVisible = (el) => {
    const rect = el.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none";
  };
  const labelOf = (el) =>
    (el.getAttribute("aria-label") || el.innerText || el.getAttribute("placeholder") || el.value || el.getAttribute("title") || el.getAttribute("name") || "").trim();
  // Collect interactive descendants of `root`, DESCENDING INTO SHADOW ROOTS (web-component UIs put
  // their controls inside shadow DOM, which querySelectorAll can't reach). Bounded so a huge page can't stall.
  const collect = (root, out, budget) => {
    let nodes;
    try {
      nodes = root.querySelectorAll("*");
    } catch {
      return;
    }
    for (const el of nodes) {
      if (out.length >= budget) return;
      if (el.shadowRoot) collect(el.shadowRoot, out, budget);
      if (seen.has(el)) continue;
      if (!el.matches || !isVisible(el)) continue;
      if (el.matches(STRONG)) {
        seen.add(el);
        out.push(el);
      } else if (el.matches(WEAK)) {
        const lab = labelOf(el);
        // a real custom button is a labelled leaf — not a big jsaction wrapper around real controls
        if (lab && lab.length <= 60 && !el.querySelector(STRONG)) {
          seen.add(el);
          out.push(el);
        }
      }
    }
  };
  // 1) Controls inside an OPEN overlay (dialog/menu/flyout/listbox) go FIRST — so when a click opens
  //    a confirmation dialog (e.g. Gmail's "Unsubscribe?") or a Settings panel, its controls LEAD the
  //    list instead of being pushed past the cap by the persistent toolbar/nav (what made it loop).
  const overlays = [];
  const overlayRoots = [];
  try {
    // ARIA modals + menus. alertdialog matters: Gmail/Material CONFIRM dialogs use role="alertdialog".
    for (const o of document.querySelectorAll(
      '[role=dialog], [role=alertdialog], [aria-modal="true"], [role=menu], [role=listbox], [role=menubar], [role=tablist]',
    )) {
      if (isVisible(o)) overlayRoots.push(o);
    }
    // Fallback for a role-less modal: the top-most visible fixed/positioned box that holds buttons.
    // Only runs when no ARIA modal was found (so it's cheap on the common path), and is bounded.
    if (!overlayRoots.some((o) => /dialog/.test(o.getAttribute("role") || "") || o.getAttribute("aria-modal") === "true")) {
      let best = null;
      let bestZ = 0;
      let scanned = 0;
      for (const el of document.querySelectorAll("div, section, form")) {
        if (++scanned > 4000) break; // bound the worst case on huge pages
        if (!isVisible(el)) continue;
        const cs = getComputedStyle(el);
        if (cs.position !== "fixed" && cs.position !== "absolute") continue;
        const z = parseInt(cs.zIndex, 10) || 0;
        if (z < 1) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 200 || r.height < 80) continue; // skip tiny toasts/badges
        if (!el.querySelector("button, [role=button]")) continue; // a real action surface
        if (z >= bestZ) {
          bestZ = z;
          best = el;
        }
      }
      if (best) overlayRoots.unshift(best);
    }
    for (const o of overlayRoots) collect(o, overlays, CAP);
  } catch {}
  // 2) Then the rest of the page (shadow-pierced, deduped against the overlays via `seen`).
  const rest = [];
  collect(document, rest, 240);
  const ordered = overlays.concat(rest);

  const elements = [];
  let idx = 0;
  for (const el of ordered) {
    if (idx >= CAP) break;
    el.setAttribute("data-errand-idx", String(idx));
    const tag = el.tagName.toLowerCase();
    const label = (
      el.getAttribute("aria-label") ||
      el.innerText ||
      el.getAttribute("placeholder") ||
      el.value ||
      el.getAttribute("title") ||
      el.getAttribute("name") ||
      ""
    )
      .trim()
      .slice(0, 80);
    const kind = tag === "input" ? el.getAttribute("type") || "text" : tag;
    elements.push({ index: idx, kind, label });
    idx++;
  }
  return { title: document.title, text: (document.body?.innerText || "").slice(0, 4000), elements };
}

function clickIdx(i) {
  // Inlined deep finder (executeScript injects only this function's body).
  const find = (root) => {
    let d = null;
    try {
      d = root.querySelector('[data-errand-idx="' + i + '"]');
    } catch {}
    if (d) return d;
    let nodes;
    try {
      nodes = root.querySelectorAll("*");
    } catch {
      return null;
    }
    for (const el of nodes) {
      if (el.shadowRoot) {
        const f = find(el.shadowRoot);
        if (f) return f;
      }
    }
    return null;
  };
  const el = find(document);
  if (!el) return { ok: false, error: "no such element" };
  el.scrollIntoView({ block: "center" }); // reveal off-screen targets before clicking
  el.click();
  return { ok: true };
}
function scrollPage(to, amount) {
  const step = amount || Math.round(window.innerHeight * 0.8);
  if (to === "top") window.scrollTo({ top: 0 });
  else if (to === "bottom") window.scrollTo({ top: document.body.scrollHeight });
  else if (to === "up") window.scrollBy({ top: -step });
  else window.scrollBy({ top: step });
  return { ok: true, atBottom: window.scrollY + window.innerHeight >= document.body.scrollHeight - 4 };
}
function typeIdx(i, text) {
  const find = (root) => {
    let d = null;
    try {
      d = root.querySelector('[data-errand-idx="' + i + '"]');
    } catch {}
    if (d) return d;
    let nodes;
    try {
      nodes = root.querySelectorAll("*");
    } catch {
      return null;
    }
    for (const el of nodes) {
      if (el.shadowRoot) {
        const f = find(el.shadowRoot);
        if (f) return f;
      }
    }
    return null;
  };
  const el = find(document);
  if (!el) return { ok: false, error: "no such element" };
  el.focus();
  el.value = text;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true };
}

async function run(cmd) {
  const tab = await resolveTab();
  if (!tab) return { ok: false, error: "no active tab" };
  if (cmd.type === "navigate") {
    await chrome.tabs.update(tab.id, { url: cmd.args.url });
    await waitComplete(tab.id);
    return { ok: true };
  }
  if (cmd.type === "screenshot") {
    try {
      // Only capture when the agent's tab is the one on screen — otherwise skip rather than
      // activate it (which would steal focus). Click the Errand group to watch live.
      const [active] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
      if (!active || active.id !== tab.id) return { ok: true };
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 50 });
      return { ok: true, dataUrl };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }
  if (cmd.type === "read") {
    // Read EVERY frame (Gmail/email bodies live in iframes). Merge into one numbered list,
    // remembering which frame each element lives in so click/type can target it.
    const results = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: readPage });
    let title = "";
    let text = "";
    const elements = [];
    const map = [];
    for (const r of results) {
      if (!r || !r.result) continue;
      if (r.frameId === 0 && r.result.title) title = r.result.title;
      if (r.result.text) text += r.result.text + "\n";
      for (const el of r.result.elements || []) {
        if (elements.length >= 80) break;
        map.push({ frameId: r.frameId, localIdx: el.index });
        elements.push({ index: elements.length, kind: el.kind, label: el.label });
      }
    }
    await chrome.storage.session.set({ errandFrameMap: map });
    return { ok: true, title, text: text.slice(0, 5000), elements };
  }
  if (cmd.type === "click" || cmd.type === "type") {
    const { errandFrameMap } = await chrome.storage.session.get("errandFrameMap");
    const m = errandFrameMap && errandFrameMap[cmd.args.index];
    if (!m) return { ok: false, error: "no such element — read the page again" };
    const func = cmd.type === "click" ? clickIdx : typeIdx;
    const args = cmd.type === "click" ? [m.localIdx] : [m.localIdx, cmd.args.text];
    const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [m.frameId] }, func, args });
    if (cmd.type === "click" && r.result && r.result.ok) await waitComplete(tab.id, 5000); // a click may navigate
    return r.result;
  }
  if (cmd.type === "scroll") {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: scrollPage,
      args: [cmd.args.to || "down", cmd.args.amount || 0],
    });
    return r.result;
  }
  return { ok: false, error: "unknown command" };
}

async function handle(cmd) {
  let result;
  try {
    result = await run(cmd);
  } catch (e) {
    result = { ok: false, error: String((e && e.message) || e) };
  }
  try {
    await fetch(BASE + "/api/ext/result", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: cmd.id, result }),
    });
  } catch {
    /* Errand unreachable */
  }
}

let connected = false;

// Hold one long-lived streaming connection. The in-flight fetch keeps the service worker
// alive; commands arrive as SSE `data:` frames. Reconnects on drop.
async function connectStream() {
  if (connected) return;
  connected = true;
  try {
    const res = await fetch(BASE + "/api/ext/stream");
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const data = frame.split("\n").find((l) => l.startsWith("data:"));
        if (data) {
          try {
            handle(JSON.parse(data.slice(5).trim())); // don't await — keep reading the stream
          } catch {
            /* ignore malformed frame */
          }
        }
      }
    }
  } catch {
    /* connection error — will retry below */
  }
  connected = false;
  setTimeout(connectStream, 1000); // reconnect
}

connectStream();
// Insurance: if Chrome ever suspends the worker, an alarm wakes it and reconnects.
chrome.alarms.create("errand-keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(connectStream);
chrome.runtime.onStartup.addListener(connectStream);
chrome.runtime.onInstalled.addListener(connectStream);
