// Files pack — the no-auth core: organize a folder, read documents, and the reversible
// mutations (rename/move/copy/delete-to-Review, all journaled for Undo).
import type { Capability } from "./types.ts";
import { fileTools } from "../tools/files.ts";

export const filesPack: Capability = {
  id: "files",
  label: "Files",
  description:
    "Look through a folder; read text, PDF, and Word documents; search for a file by name or by what's inside it; find duplicates; zip files up and unpack zips; and create, rename, move, copy, or delete files — every change is undoable.",
  tools: fileTools,
};
