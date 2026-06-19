// Errand — Electron main process (macOS-first). The first wrap hosts the EXISTING Next app: the main
// process forks the production standalone server (.next/standalone/server.js) as a UTILITY PROCESS on
// a fixed loopback port, and the renderer (a BrowserWindow) loads it over http — exactly as a browser
// would. So the agent core + SQLite + MCP children + the Playwright Chrome context all live in ONE
// long-lived Node realm (the utility process), isolated from the UI thread, and the Chrome extension
// keeps talking to the same local origin (localhost:3200) with no change.
//
// Boot order (app.whenReady): set ERRAND_DATA=userData + inject the key -> fork the server -> wait
// until it accepts connections -> open the window. Quit: kill the utility process, whose SIGTERM
// triggers the core's shutdown() wiring (Phase 1b) to release MCP children + the browser context.
const { app, BrowserWindow, utilityProcess, safeStorage } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const net = require("node:net");

// Identify as "Errand", not "Electron" — sets the macOS app menu name (in a packaged build the bundle
// name does this; this also covers the dev `npm run app` run) and routes app.getPath('userData') to
// ~/Library/Application Support/Errand. Must run before the app is ready / any getPath call.
app.setName("Errand");

// The extension targets localhost:3200 (extension/manifest.json + background.js), so the packaged app
// binds the SAME port to keep it working unchanged. Consequence: you can't run `next dev` (also 3200)
// and the app at once — the single-instance lock + this shared port make that explicit.
const HOST = "127.0.0.1";
const PORT = 3200;

let serverProc = null;
let win = null;
let quitting = false; // set on before-quit so a restart-in-progress can't spawn a server during shutdown
let restarting = false; // set while restartServer() is re-forking, so the exit isn't seen as a crash
let booting = false; // set during the boot wait so a startup crash is owned by the boot path, not respawn
let crashRestarts = 0; // consecutive unexpected core crashes (reset once a fork stays up a while)
const MAX_CRASH_RESTARTS = 3;

// node:sqlite WAL allows exactly one writer; a second app instance would contend on errand.db. Refuse
// to start a second instance and focus the existing window instead.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
app.on("second-instance", () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

function userDataDir() {
  return app.getPath("userData");
}

// The OpenRouter key: prefer an OS-keychain-encrypted blob in userData (never plaintext on disk),
// fall back to the env for dev. The renderer NEVER sees it — it's injected into the server process's
// env only. (A Settings UI to set/store the key is a follow-up; for now `errand-key:set` writes it.)
function loadApiKey() {
  const keyFile = path.join(userDataDir(), "openrouter.key");
  try {
    if (fs.existsSync(keyFile) && safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(fs.readFileSync(keyFile));
    }
  } catch (e) {
    console.warn("[errand] could not decrypt the stored key:", e.message);
  }
  return process.env.OPENROUTER_API_KEY || "";
}

// Encrypt + persist a new key to the same keychain-backed blob loadApiKey() reads. Called from the
// core server (over the utility-process channel) when the user enters a key in Settings — the
// renderer never handles the encrypted bytes, and the key is never written in plaintext.
function saveApiKey(key) {
  const trimmed = (key || "").trim();
  if (!trimmed) return false;
  if (!safeStorage.isEncryptionAvailable()) {
    console.warn("[errand] safeStorage unavailable — cannot persist the key");
    return false;
  }
  const dir = userDataDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "openrouter.key"), safeStorage.encryptString(trimmed), { mode: 0o600 });
  return true;
}

// Restart the core server so the next loadApiKey() injection picks up a changed key/config. CRITICAL:
// wait for the old process to EXIT (and release port 3200) before re-forking — forking immediately
// races the OS releasing the listener socket and can fail to bind (EADDRINUSE), leaving no backend.
// `go` runs startServer exactly once, and never while the app is quitting (so a kill-on-quit can't
// spawn a fresh server during shutdown).
function restartServer() {
  const old = serverProc;
  if (!old) {
    startServer();
    return;
  }
  restarting = true; // so the old fork's exit handler treats this as intentional, not a crash
  let done = false;
  const go = () => {
    if (done) return;
    done = true;
    restarting = false;
    if (!quitting) startServer();
  };
  old.once("exit", go);
  try {
    old.kill();
  } catch {
    go(); // already dead — no exit event coming
  }
}

// The standalone server entry. Unpackaged (dev): in the repo's .next. Packaged: unpacked from the asar
// under resources/ (electron-builder asarUnpack — see package.json build config in Phase 2c).
function serverEntry() {
  const candidates = [
    path.join(__dirname, "..", ".next", "standalone", "server.js"),
    path.join(process.resourcesPath || "", "app", ".next", "standalone", "server.js"),
  ];
  return candidates.find((c) => c && fs.existsSync(c)) || candidates[0];
}

function startServer() {
  const entry = serverEntry();
  if (!fs.existsSync(entry)) {
    console.error(`[errand] standalone server not found at ${entry} — run \`npm run build:web\` first.`);
    return;
  }
  const thisProc = utilityProcess.fork(entry, [], {
    cwd: path.dirname(entry), // the standalone server resolves its assets relative to its own dir
    stdio: "inherit",
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(PORT),
      HOSTNAME: HOST,
      ERRAND_DATA: userDataDir(), // relocate ALL app data (DB, logs, skills, caches) under userData
      OPENROUTER_API_KEY: loadApiKey(),
      // Stop Next's standalone server from installing its OWN SIGTERM/SIGINT handler (which would
      // server.close()->process.exit(0) as soon as HTTP drains, racing our shutdown() before the
      // Playwright context.close() frees the profile lock). The core's runRegistry onSignal is the
      // sole exit owner: it runs shutdown(), THEN exits, giving cleanup a real chance to finish.
      NEXT_MANUAL_SIG_HANDLE: "1",
    },
  });
  serverProc = thisProc;
  const startedAt = Date.now();
  thisProc.on("exit", (code) => {
    console.log(`[errand] core server exited (code ${code})`);
    const wasCurrent = serverProc === thisProc;
    if (wasCurrent) serverProc = null;
    // Intentional/already-owned exits are handled elsewhere: an app quit (quitting), a set-key restart
    // (restarting — its own exit listener re-forks), a STARTUP crash (booting — owned by the boot path,
    // which shows the error window; respawning here too would leave a phantom server behind it), or the
    // exit of a fork we already replaced (!wasCurrent). Only an UNEXPECTED crash of the LIVE, booted
    // fork falls through to recovery below.
    if (quitting || restarting || booting || !wasCurrent) return;
    if (Date.now() - startedAt > 30000) crashRestarts = 0; // it ran fine for a while → a fresh fault
    if (crashRestarts < MAX_CRASH_RESTARTS) {
      crashRestarts++;
      const delay = Math.min(4000, 250 * 2 ** (crashRestarts - 1));
      console.error(`[errand] core crashed — respawning (attempt ${crashRestarts}/${MAX_CRASH_RESTARTS}) in ${delay}ms`);
      setTimeout(() => {
        if (!quitting && !serverProc) startServer();
      }, delay);
    } else if (win && !win.isDestroyed()) {
      console.error("[errand] core crashed repeatedly — giving up; showing the error view");
      win.loadURL(errorURL("Errand’s core stopped unexpectedly and couldn’t restart. Please reopen the app."));
    }
  });
  // The core server (utility process) forwards a Settings key-entry here, where safeStorage lives.
  // INVARIANT: this listener MUST be registered inside startServer so every fork (boot + each
  // restart) gets it on the new UtilityProcess — moving it to a one-time boot registration would
  // silently break set-key after the first restart.
  thisProc.on("message", (msg) => {
    if (msg && msg.type === "errand:set-key" && typeof msg.key === "string") {
      const ok = saveApiKey(msg.key);
      // Acknowledge the outcome so the Settings route reports an honest result instead of a blind "ok".
      // Post BEFORE restarting: a failure doesn't restart, so the reply gets through; on success the
      // restart may kill the route first, but its short timeout treats that as success.
      try {
        thisProc.postMessage({ type: "errand:set-key:result", id: msg.id, ok });
      } catch {
        /* channel already torn down */
      }
      if (ok) {
        console.log("[errand] stored a new API key from Settings; restarting the core to apply it");
        restartServer();
      }
    }
  });
}

// Is something ALREADY listening on our loopback port? Used as a boot preflight: before we fork, a
// listener can only be a FOREIGN process (a stray `next dev` or an orphaned core from an unclean prior
// quit), never us. Forking onto it would EADDRINUSE-kill our fork and silently bind the window to the
// stranger's server (wrong data dir, no injected key), so we refuse and show an error instead.
function portInUse() {
  return new Promise((resolve) => {
    const sock = net.connect(PORT, HOST);
    sock.once("connect", () => {
      sock.destroy();
      resolve(true);
    });
    sock.once("error", () => {
      sock.destroy();
      resolve(false);
    });
  });
}

// Poll the loopback port until OUR fork accepts a connection (or time out / it dies). The standalone
// Next server is ready in well under a second, but a cold first run can be slower. Critically: reject
// if `serverProc` exits before we connect (e.g. EADDRINUSE → process.exit(1)) so the caller shows an
// error rather than the boot "succeeding" against whatever else happens to hold the port.
function waitForServer(timeoutMs = 20000) {
  const start = Date.now();
  const proc = serverProc; // the fork we're waiting on
  return new Promise((resolve, reject) => {
    let settled = false;
    const onExit = () => {
      if (settled) return;
      settled = true;
      reject(new Error("the core server exited during startup"));
    };
    if (proc) proc.once("exit", onExit);
    const cleanup = () => {
      if (proc) proc.removeListener("exit", onExit);
    };
    const attempt = () => {
      if (settled) return;
      const sock = net.connect(PORT, HOST);
      sock.once("connect", () => {
        sock.destroy();
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      });
      sock.once("error", () => {
        sock.destroy();
        if (settled) return;
        if (Date.now() - start > timeoutMs) {
          settled = true;
          cleanup();
          reject(new Error("the core server did not start in time"));
        } else {
          setTimeout(attempt, 200);
        }
      });
    };
    attempt();
  });
}

// A self-contained error page (data: URL) for the sandboxed window when there's no server to load —
// a port conflict at boot, a boot timeout, or a core that crashed past its restart budget.
function errorURL(message) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Errand</title>
<style>
  html,body{margin:0;height:100%}
  body{background:#F4EFE6;color:#3a352c;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
       display:flex;align-items:center;justify-content:center;text-align:center;padding:2rem}
  .box{max-width:30rem}
  h1{font-size:1.1rem;margin:0 0 .5rem}
  p{margin:.25rem 0;color:#6b6457}
</style></head><body><div class="box">
  <h1>Errand couldn’t start</h1>
  <p>${message}</p>
  <p>If another copy of Errand (or <code>next dev</code> on port ${PORT}) is running, quit it and reopen Errand.</p>
</div></body></html>`;
  return "data:text/html;charset=utf-8," + encodeURIComponent(html);
}

function createWindow(errorMessage = null) {
  win = new BrowserWindow({
    width: 1100,
    height: 820,
    minWidth: 720,
    minHeight: 560,
    title: "Errand",
    backgroundColor: "#F4EFE6", // the app's paper bg, so there's no white flash before load
    webPreferences: {
      // The renderer is just the Next UI talking to the loopback server over http — it needs no Node
      // access, so lock it down. (If a later milestone moves the run stream to IPC, add a preload.)
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  // When the core couldn't start, load an explicit error page instead of the server URL — never bind
  // the window to whatever else might be holding the port.
  win.loadURL(errorMessage ? errorURL(errorMessage) : `http://${HOST}:${PORT}/`);
  win.on("closed", () => {
    win = null;
  });
}

app.whenReady().then(async () => {
  // Preflight: anything already on :3200 before we fork is a FOREIGN listener — don't fork onto it
  // (our fork would EADDRINUSE-die) and don't load the stranger's server; show an error instead.
  if (await portInUse()) {
    console.error(`[errand] port ${PORT} is already in use — another Errand or \`next dev\`?`);
    createWindow(`Port ${PORT} is already in use.`);
    return;
  }
  booting = true; // the boot path owns this fork's exit until it's confirmed up (no respawn during startup)
  startServer();
  let bootError = null;
  try {
    await waitForServer();
  } catch (e) {
    bootError = e.message;
    console.error(`[errand] ${e.message}`);
    // A crash-exit already nulled serverProc (its exit handler); a TIMEOUT leaves the fork ALIVE but
    // unresponsive (hung). Kill that zombie so it can't linger behind the error window holding :3200 +
    // the SQLite WAL writer. booting is still true here, and we null serverProc, so neither the crash
    // handler nor before-quit treats this exit as something to respawn or wait on.
    if (serverProc) {
      try {
        serverProc.kill();
      } catch {
        /* already gone */
      }
      serverProc = null;
    }
  } finally {
    booting = false;
  }
  createWindow(bootError);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Single-window app: quit when it closes (including on macOS).
app.on("window-all-closed", () => {
  app.quit();
});

// Release the core before we quit: killing the utility process sends SIGTERM, which the core's
// shutdown() wiring (runRegistry, Phase 1b) catches to close MCP stdio children + the Playwright Chrome
// context (releasing the profile lock) so nothing orphans. That cleanup is ASYNC, so we hold the quit
// (preventDefault) and wait for the core to actually exit before quitting — with a timeout that
// force-kills so a hung cleanup can never trap the user in an un-quittable app.
app.on("before-quit", (event) => {
  quitting = true; // so a mid-restart/crash exit handler doesn't re-spawn the server during shutdown
  const proc = serverProc;
  if (!proc) return; // nothing to clean up — let the quit proceed normally
  event.preventDefault();
  let done = false;
  let timer;
  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    app.exit(0);
  };
  timer = setTimeout(() => {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    finish();
  }, 4000);
  proc.once("exit", finish);
  try {
    proc.kill(); // SIGTERM → core shutdown() → process exits → finish()
  } catch {
    finish(); // already gone — quit now
  }
});
