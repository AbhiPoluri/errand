// Skills = named, reusable procedures the agent can apply. Each is a folder under the skills dir with
// a SKILL.md (optional `---` frontmatter: name/description/when_to_use, then a markdown body of steps).
// Mirrors Anthropic Agent Skills so they're portable. App-managed location (NOT a user folder) —
// reads ERRAND_SKILLS / defaults to <cwd>/skills (computed here, not via config, so tests run offline).
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface Skill {
  name: string;
  description: string;
  whenToUse: string;
  body: string;
  slug: string; // the folder name
}

export function skillsDir(): string {
  return process.env.ERRAND_SKILLS ?? join(process.cwd(), "skills");
}

export const MAX_SKILL_BYTES = 100_000; // a SKILL.md larger than this is pathological — skip it on read

// Parse a SKILL.md: optional leading `---` frontmatter (single-line key: value) then the body.
function parseSkillMd(slug: string, raw: string): Skill {
  // Normalize CRLF → LF first so a Windows-authored SKILL.md still matches the frontmatter fences.
  const md = raw.replace(/\r\n/g, "\n");
  let name = slug;
  let description = "";
  let whenToUse = "";
  let body = md.trim();
  const m = md.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (m) {
    body = m[2].trim();
    for (const line of m[1].split("\n")) {
      const kv = line.match(/^([A-Za-z_]+):\s*(.*)$/);
      if (!kv) continue;
      const key = kv[1].toLowerCase();
      const val = kv[2].trim().replace(/^["']|["']$/g, "");
      if (key === "name") name = val || slug;
      else if (key === "description") description = val;
      else if (key === "when_to_use" || key === "whentouse") whenToUse = val;
    }
  }
  return { name, description, whenToUse, body, slug };
}

export function listSkills(): Skill[] {
  const dir = skillsDir();
  if (!existsSync(dir)) return [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: Skill[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const md = join(dir, e.name, "SKILL.md");
    if (!existsSync(md)) continue;
    try {
      const text = readFileSync(md, "utf8");
      if (text.length > MAX_SKILL_BYTES) continue;
      out.push(parseSkillMd(e.name, text));
    } catch {
      /* skip an unreadable skill rather than failing the whole list */
    }
  }
  return out;
}

export function getSkill(name: string): Skill | null {
  const want = name.trim().toLowerCase();
  return listSkills().find((s) => s.name.toLowerCase() === want || s.slug.toLowerCase() === want) ?? null;
}

// One line per skill for the system prompt, so the model knows what's available without a tool call.
export function skillsSummary(): string {
  const skills = listSkills();
  if (!skills.length) return "";
  return skills
    .map((s) => `- ${s.name}${s.description ? `: ${s.description}` : ""}${s.whenToUse ? ` (use when: ${s.whenToUse})` : ""}`)
    .join("\n");
}

// A filesystem-safe folder name from a skill name ("Tidy Downloads" -> "tidy-downloads").
export function slugForName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "skill";
}
