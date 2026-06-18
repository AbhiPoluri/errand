// GET /api/skills — the saved skills (name + description + when-to-use) for the Settings list.
import { NextResponse } from "next/server";
import { listSkills } from "../../../src/server/skills.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const skills = listSkills().map((s) => ({ name: s.name, description: s.description, whenToUse: s.whenToUse }));
  return NextResponse.json({ skills });
}
