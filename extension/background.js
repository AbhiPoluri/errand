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
function readPage() {
  const sel = "a, button, input, textarea, select, [role=button], [role=link], [role=textbox]";
  const elements = [];
  let idx = 0;
  for (const el of Array.from(document.querySelectorAll(sel))) {
    if (elements.length >= 60) break;
    const rect = el.getBoundingClientRect();
    const visible = rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility !== "hidden";
    if (!visible) continue;
    el.setAttribute("data-errand-idx", String(idx));
    const tag = el.tagName.toLowerCase();
    const label = (
      el.getAttribute("aria-label") ||
      el.innerText ||
      el.getAttribute("placeholder") ||
      el.value ||
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
  const el = document.querySelector('[data-errand-idx="' + i + '"]');
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
  const el = document.querySelector('[data-errand-idx="' + i + '"]');
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
        if (elements.length >= 60) break;
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
