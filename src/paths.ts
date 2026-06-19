// Single source of truth for WHERE Errand keeps its data on disk. Today everything roots at
// process.cwd() (the repo, under `next dev`) or the user's homedir. Under a packaged Electron app
// cwd is unstable (often "/" for a Finder-launched .app) and the bundle is read-only, so the main
// process must repoint all app-managed paths to a stable, writable location (app.getPath
// "userData"). It does that by setting ERRAND_DATA once; every path below derives from it.
//
// Each path also keeps a SPECIFIC env override (ERRAND_DB, WORKSPACE_ROOT, …) for fine control and
// back-compat with existing setups/tests. Precedence: specific override > ERRAND_DATA-derived >
// cwd/home default. Read LAZILY (functions, not module constants) so a host or test that sets the
// env before first use is always honored regardless of import order — the same property that made
// store.ts read process.env.ERRAND_DB inline rather than through a frozen config value.
import { join } from "node:path";
import { homedir } from "node:os";
import process from "node:process";

// The base directory all app-managed data derives from. Default = cwd (dev: the repo root).
function dataRoot(): string {
  return process.env.ERRAND_DATA ?? process.cwd();
}

// SQLite DB (+ its -wal/-shm sidecars). Must be on a durable, writable filesystem.
export function dbPath(): string {
  return process.env.ERRAND_DB ?? join(dataRoot(), "errand.db");
}

// Sandbox root for file/shell tools — everything destructive is confined here (incl. the
// .errand-review/<runId> undo store written beneath it).
export function workspaceRoot(): string {
  return process.env.WORKSPACE_ROOT ?? join(dataRoot(), "workspace");
}

// Saved skills (named, reusable SKILL.md procedures). App-managed, not a user folder.
export function skillsRoot(): string {
  return process.env.ERRAND_SKILLS ?? join(dataRoot(), "skills");
}

// JSONL run traces (debugging + the resumable transcript).
export function logsRoot(): string {
  return process.env.ERRAND_LOGS ?? join(dataRoot(), "logs");
}

// tesseract.js language-model + worker cache (so OCR doesn't refetch each cold start).
export function ocrCacheRoot(): string {
  return process.env.ERRAND_CACHE ?? join(dataRoot(), ".tesseract-cache");
}

// Persistent Chrome profiles for the agent's real-login browser. Defaults to the user's HOME (so the
// profile survives where the user expects it), NOT dataRoot — but a host can repoint it (Electron
// moves it under userData). The browser layer appends `.errand-<channel>` to this.
export function browserProfileRoot(): string {
  return process.env.ERRAND_BROWSER_PROFILES ?? homedir();
}
