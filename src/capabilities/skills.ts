// Skills pack — named, reusable procedures (SKILL.md) the agent can list, apply, and save. No auth.
import type { Capability } from "./types.ts";
import { skillTools } from "../tools/skills.ts";

export const skillsPack: Capability = {
  id: "skills",
  label: "Skills",
  description: "Use your saved how-to procedures (skills) for routine tasks, and save new ones.",
  tools: skillTools,
};
