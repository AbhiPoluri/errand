// Real-folder scope. A non-technical user picks WHERE Errand may work from a short
// list of folders that actually exist — never types a path. The default is the safe
// in-app sandbox. resolveWithin() still confines every op to the chosen root.
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { statSync, accessSync, realpathSync, mkdirSync, constants } from "node:fs";
import { config } from "../config.ts";

// Errand's "safe folder" is its OWN sandbox (config.workspaceRoot) — so we create it if it doesn't
// exist yet. Without this a fresh install fails EVERY default-scoped run with "couldn't open that
// folder": the picker always offers the safe folder, the UI defaults to it, but the directory was
// never made — most visibly in the packaged app, whose workspace lives under userData. This is the
// only folder Errand creates; the others are the user's real, pre-existing folders. Idempotent.
export function ensureSafeFolder(): void {
  try {
    mkdirSync(config.workspaceRoot, { recursive: true });
  } catch {
    // If it genuinely can't be created (odd permissions), the usable-dir checks below report it calmly.
  }
}

export interface FolderOption {
  key: string;
  label: string;
  path: string;
  safe: boolean; // true = the in-app sandbox
}

function dirUsable(p: string): boolean {
  try {
    if (!statSync(p).isDirectory()) return false;
    accessSync(p, constants.R_OK | constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

// The folders we OFFER — only those that exist and are writable are returned.
export function availableFolders(): FolderOption[] {
  ensureSafeFolder(); // the safe sandbox always exists once we list folders
  const home = homedir();
  const candidates: FolderOption[] = [
    { key: "workspace", label: "Errand's safe folder", path: config.workspaceRoot, safe: true },
    { key: "downloads", label: "Downloads", path: join(home, "Downloads"), safe: false },
    { key: "desktop", label: "Desktop", path: join(home, "Desktop"), safe: false },
    { key: "documents", label: "Documents", path: join(home, "Documents"), safe: false },
  ];
  return candidates.filter((c) => c.safe || dirUsable(c.path));
}

// Canonical real path for allow-list comparison; falls back to a plain resolve if the path can't
// be resolved yet (the workspace sandbox may not exist on disk until the first write).
function realOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

// Validate roots requested by the client (pre-flight). A requested root MUST be one of the folders
// Errand actually offers — the picker is an allow-list, and the server must enforce it, not trust
// whatever path the request carries (otherwise a crafted POST could point the agent — and all the
// resolveWithin confinement — at ~/.ssh, a git repo, anywhere writable). Compared by resolved real
// path so a symlink can't masquerade as an allowed folder. Then the usual usable-dir check for a
// calm "couldn't open / no permission" message.
export function checkRoots(paths: string[]): { ok: true } | { ok: false; problem: string } {
  const allowed = new Set(availableFolders().map((f) => realOrSelf(f.path)));
  for (const p of paths) {
    if (!allowed.has(realOrSelf(p))) {
      return { ok: false, problem: "That isn't one of the folders I can work in." };
    }
    if (!dirUsable(p)) {
      return { ok: false, problem: "I couldn't open that folder, or I don't have permission to change things in it." };
    }
  }
  return { ok: true };
}
