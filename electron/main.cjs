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

// The extension targets localhost:3200 (extension/manifest.json + background.js), so the packaged app
// binds the SAME port to keep it working unchanged. Consequence: you can't run `next dev` (also 3200)
// and the app at once — the single-instance lock + this shared port make that explicit.
const HOST = "127.0.0.1";
const PORT = 3200;

let serverProc = null;
let win = null;

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
  serverProc = utilityProcess.fork(entry, [], {
    cwd: path.dirname(entry), // the standalone server resolves its assets relative to its own dir
    stdio: "inherit",
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(PORT),
      HOSTNAME: HOST,
      ERRAND_DATA: userDataDir(), // relocate ALL app data (DB, logs, skills, caches) under userData
      OPENROUTER_API_KEY: loadApiKey(),
    },
  });
  serverProc.on("exit", (code) => {
    console.log(`[errand] core server exited (code ${code})`);
    serverProc = null;
  });
}

// Poll the loopback port until the server accepts a connection (or time out). The standalone Next
// server is ready in well under a second, but a cold first run can be slower.
function waitForServer(timeoutMs = 20000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const sock = net.connect(PORT, HOST);
      sock.once("connect", () => {
        sock.destroy();
        resolve();
      });
      sock.once("error", () => {
        sock.destroy();
        if (Date.now() - start > timeoutMs) reject(new Error("the core server did not start in time"));
        else setTimeout(attempt, 200);
      });
    };
    attempt();
  });
}

function createWindow() {
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
  win.loadURL(`http://${HOST}:${PORT}/`);
  win.on("closed", () => {
    win = null;
  });
}

app.whenReady().then(async () => {
  startServer();
  try {
    await waitForServer();
  } catch (e) {
    console.error(`[errand] ${e.message}`);
  }
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Single-window app: quit when it closes (including on macOS).
app.on("window-all-closed", () => {
  app.quit();
});

// Release the core: killing the utility process sends SIGTERM, which the core's shutdown() wiring
// (runRegistry, Phase 1b) catches to close MCP stdio children + the Playwright Chrome context so
// nothing orphans after the user quits.
app.on("before-quit", () => {
  if (serverProc) {
    try {
      serverProc.kill();
    } catch {
      /* already gone */
    }
  }
});
