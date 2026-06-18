// Real-folder scope. A non-technical user picks WHERE Errand may work from a short
// list of folders that actually exist — never types a path. The default is the safe
// in-app sandbox. resolveWithin() still confines every op to the chosen root.
import { homedir } from "node:os";
import { join } from "node:path";
import { statSync, accessSync, constants } from "node:fs";
import { config } from "../config.ts";

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
  const home = homedir();
  const candidates: FolderOption[] = [
    { key: "workspace", label: "Errand's safe folder", path: config.workspaceRoot, safe: true },
    { key: "downloads", label: "Downloads", path: join(home, "Downloads"), safe: false },
    { key: "desktop", label: "Desktop", path: join(home, "Desktop"), safe: false },
    { key: "documents", label: "Documents", path: join(home, "Documents"), safe: false },
  ];
  return candidates.filter((c) => c.safe || dirUsable(c.path));
}

// Validate roots requested by the client (pre-flight). Returns a plain problem if any
// folder is missing/unwritable, so the failure is calm and pre-commitment.
export function checkRoots(paths: string[]): { ok: true } | { ok: false; problem: string } {
  for (const p of paths) {
    if (!dirUsable(p)) {
      return { ok: false, problem: "I couldn't open that folder, or I don't have permission to change things in it." };
    }
  }
  return { ok: true };
}
