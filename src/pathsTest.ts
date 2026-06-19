// Verifies the Phase 1 path-centralization (paths.ts) + non-fatal config. Every app-data path must
// derive from ERRAND_DATA (so an Electron host relocates all of it with one env var), a SPECIFIC
// override must win over ERRAND_DATA, and config must import WITHOUT throwing when the key is absent.
// Lazy env reads mean a single process can re-read after changing the env. Run: `npm run paths:test`.
import { join } from "node:path";
import { homedir } from "node:os";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? "  — " + detail : ""}`);
  if (!ok) failures++;
};

const PATH_ENVS = ["ERRAND_DATA", "ERRAND_DB", "WORKSPACE_ROOT", "ERRAND_SKILLS", "ERRAND_LOGS", "ERRAND_CACHE", "ERRAND_BROWSER_PROFILES"];

async function main(): Promise<void> {
  for (const k of PATH_ENVS) delete process.env[k];
  const paths = await import("./paths.ts");
  const cwd = process.cwd();

  // 1. Defaults derive from cwd (dev behavior — unchanged), profile from home.
  check("dbPath defaults under cwd", paths.dbPath() === join(cwd, "errand.db"));
  check("workspaceRoot defaults under cwd", paths.workspaceRoot() === join(cwd, "workspace"));
  check("skillsRoot defaults under cwd", paths.skillsRoot() === join(cwd, "skills"));
  check("logsRoot defaults under cwd", paths.logsRoot() === join(cwd, "logs"));
  check("ocrCacheRoot defaults under cwd", paths.ocrCacheRoot() === join(cwd, ".tesseract-cache"));
  check("browserProfileRoot defaults to home", paths.browserProfileRoot() === homedir());

  // 2. ERRAND_DATA relocates everything at once (lazy read — same fns, new env). This is the one
  //    knob an Electron host sets to app.getPath('userData').
  process.env.ERRAND_DATA = "/tmp/errand-data-X";
  check("ERRAND_DATA relocates dbPath", paths.dbPath() === "/tmp/errand-data-X/errand.db");
  check("ERRAND_DATA relocates workspaceRoot", paths.workspaceRoot() === "/tmp/errand-data-X/workspace");
  check("ERRAND_DATA relocates skillsRoot", paths.skillsRoot() === "/tmp/errand-data-X/skills");
  check("ERRAND_DATA relocates logsRoot", paths.logsRoot() === "/tmp/errand-data-X/logs");
  check("ERRAND_DATA relocates ocrCacheRoot", paths.ocrCacheRoot() === "/tmp/errand-data-X/.tesseract-cache");
  check("ERRAND_DATA does NOT move the browser profile (stays home)", paths.browserProfileRoot() === homedir());

  // 3. A specific override wins over ERRAND_DATA (fine-grained control + back-compat).
  process.env.ERRAND_DB = "/tmp/custom/my.db";
  process.env.ERRAND_BROWSER_PROFILES = "/tmp/profiles";
  check("ERRAND_DB wins over ERRAND_DATA for the DB", paths.dbPath() === "/tmp/custom/my.db");
  check("the other paths still follow ERRAND_DATA", paths.workspaceRoot() === "/tmp/errand-data-X/workspace");
  check("ERRAND_BROWSER_PROFILES overrides home", paths.browserProfileRoot() === "/tmp/profiles");

  // 4. config imports WITHOUT throwing when the key is absent (the old required() threw at import,
  //    bricking every route). Note: config.loadEnvFile() reloads the repo .env, so the dev key is
  //    re-populated here — we can only assert the import is non-fatal and hasApiKey is a boolean.
  let threw = false;
  let cfg: typeof import("./config.ts") | null = null;
  try {
    cfg = await import("./config.ts");
  } catch {
    threw = true;
  }
  check("config import does not throw (no required() at module init)", !threw && cfg !== null);
  check("hasApiKey() returns a boolean", typeof cfg?.hasApiKey() === "boolean");
  check("config.workspaceRoot resolved (non-empty)", typeof cfg?.config.workspaceRoot === "string" && cfg.config.workspaceRoot.length > 0);

  console.log(`\nRESULT: ${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
