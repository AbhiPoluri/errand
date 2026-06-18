// Skills verification — SKILL.md parsing, the list/use/save tools, the prompt summary, and that
// save_skill is journaled-reversible. Isolated to a temp ERRAND_SKILLS dir; no DB, no network.
// Run: `npm run skill:test`.
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Point the skills layer at a throwaway dir BEFORE importing the modules that read it lazily.
const SKILLS = mkdtempSync(join(tmpdir(), "errand-skills-"));
process.env.ERRAND_SKILLS = SKILLS;

const { listSkills, getSkill, skillsSummary, slugForName } = await import("./server/skills.ts");
const { listSkillsTool, useSkillTool, saveSkillTool } = await import("./tools/skills.ts");
const { Registry } = await import("./tools/index.ts");
const { Journal } = await import("./journal.ts");

let failures = 0;
const check = (label: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
  if (!cond) failures++;
};
const ctx: any = { signal: new AbortController().signal, journal: new Journal(), runId: "skill-test", workspaceRoot: SKILLS, roots: [SKILLS] };

function writeSkill(slug: string, md: string) {
  const dir = join(SKILLS, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), md);
}

async function main() {
  // --- parsing ---
  writeSkill(
    "tidy-downloads",
    `---\nname: Tidy Downloads\ndescription: Sort the Downloads folder by type\nwhen_to_use: the user asks to clean up downloads\n---\n\n1. List the files\n2. Make folders by type\n3. Move them`,
  );
  writeSkill("no-frontmatter", `Just a body, no frontmatter.`);
  const skills = listSkills();
  check("found 2 skills", skills.length === 2, skills.map((s) => s.name).join(","));
  const tidy = getSkill("Tidy Downloads");
  check("parsed name", tidy?.name === "Tidy Downloads");
  check("parsed description", tidy?.description === "Sort the Downloads folder by type");
  check("parsed when_to_use", tidy?.whenToUse === "the user asks to clean up downloads");
  check("body excludes frontmatter", !!tidy && tidy.body.startsWith("1. List the files") && !tidy.body.includes("---"));
  check("getSkill works by slug too", getSkill("tidy-downloads")?.name === "Tidy Downloads");
  check("no-frontmatter skill falls back to slug name", getSkill("no-frontmatter")?.name === "no-frontmatter");

  // --- prompt summary ---
  const summary = skillsSummary();
  check("summary lists the skill with when-to-use", summary.includes("Tidy Downloads") && summary.includes("use when:"));

  // --- list_skills tool ---
  const reg = new Registry().register(listSkillsTool).register(useSkillTool).register(saveSkillTool);
  check("3 skill tools register", reg.schemas().length === 3);
  const lr = await listSkillsTool.run({} as any, ctx);
  check("list_skills returns the skills", lr.ok && lr.data?.skills.length === 2);
  check("list_skills + use_skill are NOT gated", listSkillsTool.gated === false && useSkillTool.gated === false);

  // --- use_skill tool ---
  const ur = await useSkillTool.run({ name: "Tidy Downloads" }, ctx);
  check("use_skill returns the body", !!(ur.ok && ur.data?.body.startsWith("1. List the files")));
  const umiss = await useSkillTool.run({ name: "nope" }, ctx);
  check("use_skill on a missing skill fails calmly", !umiss.ok);

  // --- save_skill tool (gated + journaled) ---
  check("save_skill is GATED", saveSkillTool.gated === true);
  const j = new Journal();
  const sr = await saveSkillTool.run(
    { name: "Weekly Report", description: "Draft my weekly report", when_to_use: "fridays", body: "1. Gather notes\n2. Summarize" },
    { ...ctx, journal: j },
  );
  check("save_skill ok", sr.ok, sr.ok ? "" : (sr as any).summary);
  check("the new SKILL.md exists", existsSync(join(SKILLS, slugForName("Weekly Report"), "SKILL.md")));
  check("the saved skill is now listed + parses", getSkill("Weekly Report")?.description === "Draft my weekly report");
  check("save_skill recorded one reversible op", j.reversibleCount() === 1);
  // Re-saving the same name refuses (non-clobber).
  const dup = await saveSkillTool.run({ name: "Weekly Report", body: "x" }, { ...ctx, journal: new Journal() });
  check("save_skill refuses to overwrite an existing skill", !dup.ok);
  // Undo removes it.
  await j.undoAll();
  check("undo removed the saved skill", !getSkill("Weekly Report"));

  // --- review fix #8: a CRLF (Windows) SKILL.md still parses its frontmatter ---
  writeSkill("crlf", "---\r\nname: CRLF Skill\r\ndescription: from windows\r\n---\r\n\r\nstep one\r\nstep two");
  const crlf = getSkill("CRLF Skill");
  check("CRLF frontmatter parses (name)", crlf?.name === "CRLF Skill", crlf?.name);
  check("CRLF body excludes the frontmatter markers", !!crlf && !crlf.body.includes("---") && crlf.body.includes("step one"));

  // --- review fix #7: an oversized body is rejected at write time (reader would skip it) ---
  const huge = await saveSkillTool.run({ name: "Too Big", body: "x".repeat(200_000) }, { ...ctx, journal: new Journal() });
  check("save_skill rejects an oversized body", !huge.ok);

  // --- review fix #5: undo must NOT recursively delete pre-existing files in a colliding slug dir ---
  const collideDir = join(SKILLS, slugForName("Notes Skill"));
  mkdirSync(collideDir, { recursive: true });
  writeFileSync(join(collideDir, "user-data.txt"), "DO NOT DELETE");
  const j2 = new Journal();
  const sr2 = await saveSkillTool.run({ name: "Notes Skill", body: "a procedure" }, { ...ctx, journal: j2 });
  check("save_skill into a pre-existing folder ok", sr2.ok);
  await j2.undoAll();
  check("undo removed the SKILL.md", !existsSync(join(collideDir, "SKILL.md")));
  check("undo PRESERVED the pre-existing user file (no recursive wipe)", existsSync(join(collideDir, "user-data.txt")));

  rmSync(SKILLS, { recursive: true, force: true });
  console.log(`\nRESULT: ${failures === 0 ? "ALL PASS" : failures + " FAILED"}`);
  if (failures) process.exitCode = 1;
}

main().catch((e) => {
  console.error("skill:test crashed:", e);
  process.exitCode = 1;
});
