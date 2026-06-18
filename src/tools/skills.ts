// Skill tools: list/use saved procedures (read-only, ungated) and save a new one (gated, journaled).
// A skill is just instructions the model then follows with its EXISTING tools — no new transport.
import { join } from "node:path";
import { mkdirSync, writeFileSync, rmSync, rmdirSync, existsSync, readdirSync } from "node:fs";
import { z } from "zod";
import type { Tool, ToolResult } from "./index.ts";
import { listSkills, getSkill, skillsDir, slugForName, MAX_SKILL_BYTES } from "../server/skills.ts";

interface SkillBrief {
  name: string;
  description: string;
  whenToUse: string;
}

export const listSkillsTool: Tool<Record<string, never>, { skills: SkillBrief[] }> = {
  name: "list_skills",
  modelDescription: "List the saved skills (named, reusable procedures) available to apply with use_skill.",
  jsonSchema: { type: "object", properties: {}, additionalProperties: false },
  argsSchema: z.object({}),
  gated: false,
  describe: () => ({ action: "Look at your saved skills", reversibility: "reversible" }),
  summarize: (r) => (r.ok ? `Found ${r.data?.skills.length ?? 0} skill(s).` : "I couldn't read the skills."),
  run: async (): Promise<ToolResult<{ skills: SkillBrief[] }>> => {
    const skills = listSkills().map((s) => ({ name: s.name, description: s.description, whenToUse: s.whenToUse }));
    return { ok: true, data: { skills } };
  },
};

export const useSkillTool: Tool<{ name: string }, { name: string; body: string }> = {
  name: "use_skill",
  modelDescription:
    "Load a saved skill by name — returns its step-by-step procedure for you to follow with your existing tools.",
  jsonSchema: {
    type: "object",
    required: ["name"],
    additionalProperties: false,
    properties: { name: { type: "string", description: "The skill's name." } },
  },
  argsSchema: z.object({ name: z.string().min(1) }),
  gated: false,
  describe: (a) => ({ action: `Use the "${a.name}" skill`, reversibility: "reversible" }),
  summarize: (r) => (r.ok ? `Loaded the "${r.data?.name}" skill.` : (r.summary ?? "I couldn't find that skill.")),
  run: async (a): Promise<ToolResult<{ name: string; body: string }>> => {
    const skill = getSkill(a.name);
    if (!skill) return { ok: false, error: "no_skill", summary: `I don't have a skill named "${a.name}".` };
    return { ok: true, data: { name: skill.name, body: skill.body } };
  },
};

export const saveSkillTool: Tool<
  { name: string; description?: string; when_to_use?: string; body: string },
  { name: string; path: string }
> = {
  name: "save_skill",
  modelDescription:
    "Save a reusable procedure as a named skill (a SKILL.md) so it can be applied later with use_skill.",
  jsonSchema: {
    type: "object",
    required: ["name", "body"],
    additionalProperties: false,
    properties: {
      name: { type: "string", description: "Short skill name." },
      description: { type: "string", description: "One line on what it does." },
      when_to_use: { type: "string", description: "When this skill applies." },
      body: { type: "string", description: "The step-by-step procedure (markdown)." },
    },
  },
  argsSchema: z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    when_to_use: z.string().optional(),
    body: z.string().min(1),
  }),
  gated: true,
  describe: (a) => ({
    action: `Save a skill called "${a.name}"`,
    items: [a.name],
    consequences: "You can undo this.",
    reversibility: "reversible",
  }),
  summarize: (r) => (r.ok ? `Saved the "${r.data?.name}" skill.` : (r.summary ?? "I couldn't save that skill.")),
  run: async (a, ctx): Promise<ToolResult<{ name: string; path: string }>> => {
    try {
      const slug = slugForName(a.name); // strips path separators → can't escape the skills dir
      const dir = join(skillsDir(), slug);
      const file = join(dir, "SKILL.md");
      if (existsSync(file)) return { ok: false, error: "exists", summary: `A skill called "${a.name}" already exists.` };
      // Single-line frontmatter values (newlines would break the `key: value` parse).
      const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
      const front = [
        "---",
        `name: ${oneLine(a.name)}`,
        a.description ? `description: ${oneLine(a.description)}` : "",
        a.when_to_use ? `when_to_use: ${oneLine(a.when_to_use)}` : "",
        "---",
      ].filter(Boolean).join("\n");
      const contents = `${front}\n\n${a.body.trim()}\n`;
      // Reject at write time what the reader would silently skip (>MAX_SKILL_BYTES), so a "Saved" can
      // never lie about a skill that will never show up again.
      if (contents.length > MAX_SKILL_BYTES) {
        return { ok: false, error: "too_large", summary: "That skill is too long to save." };
      }
      // Whether the slug folder already held content — so Undo removes ONLY the SKILL.md we write,
      // never recursively wiping a pre-existing folder (which could contain unrelated user files).
      const dirExisted = existsSync(dir);
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, contents, "utf8");
      ctx.journal.record({
        op: "copy",
        description: `Saved skill "${a.name}"`,
        reversibility: "reversible",
        manifest: { kind: "copy", to: file }, // the FILE we created, not the dir (safe restart-undo)
        inverse: async () => {
          rmSync(file, { force: true });
          // Tidy up the folder only if WE created it and it's now empty — never delete pre-existing content.
          if (!dirExisted) {
            try {
              if (readdirSync(dir).length === 0) rmdirSync(dir);
            } catch {
              /* leave it if anything is still there */
            }
          }
        },
      });
      return { ok: true, data: { name: a.name, path: file } };
    } catch (e) {
      return { ok: false, error: String((e as any)?.message ?? e) };
    }
  },
};

export const skillTools = [listSkillsTool, useSkillTool, saveSkillTool];
