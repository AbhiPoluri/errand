// Dreaming — Errand's reflective consolidation. When enabled, it re-reads recent
// conversations + existing memories and (1) extracts durable facts/preferences/habits,
// (2) DE-DUPLICATES — merging near-identical memories into one and removing the redundant
// ones, (3) surfaces a couple of gentle proactive ideas. One model call; results saved.
import { z } from "zod";
import { client } from "../client.ts";
import { config } from "../config.ts";
import * as store from "./store.ts";

// The dream model output is the riskiest untyped input in the app — it drives DESTRUCTIVE
// de-dup (delete/rewrite of stored memories). Validate PER ELEMENT so one malformed item doesn't
// discard the whole pass (small models often emit one bad entry alongside good ones): the
// destructive path is still validated (group ids coerced to strings, items must have text), but
// valid memories/dedups still apply. `text` on a group is optional (delete-only groups allowed);
// `kind`/`prompt` are nullish so a model emitting null instead of "" still passes.
const DreamMemory = z.object({ text: z.string(), kind: z.string().nullish() });
const DreamGroup = z.object({
  ids: z.array(z.any()).transform((a) => a.filter((x): x is string => typeof x === "string")),
  text: z.string().nullish(),
});
const DreamSuggestion = z.object({ text: z.string(), prompt: z.string().nullish() });
const validItems = <T>(arr: unknown, schema: z.ZodType<T>): T[] =>
  (Array.isArray(arr) ? arr : []).map((x) => schema.safeParse(x)).flatMap((r) => (r.success ? [r.data] : []));

const SCHEMA_HINT = `Return ONLY a JSON object of this shape:
{
  "newMemories": [{"text": "one short durable fact about the user", "kind": "preference|fact|pattern"}],
  "duplicateGroups": [{"ids": ["id-a", "id-b"], "text": "one merged version that replaces the whole group"}],
  "suggestions": [{"text": "a gentle, concrete idea phrased to the user", "prompt": "a ready-to-run errand for it, or empty string"}]
}`;

export async function dream(): Promise<{ added: number; merged: number; removed: number; suggested: number }> {
  const convos = store.recentConversations(8);
  const memList = store.listMemories();
  if (!convos.trim() && memList.length < 2) return { added: 0, merged: 0, removed: 0, suggested: 0 };

  const system =
    "You are the reflective memory of Errand, a calm personal assistant. Review the recent conversations and the existing memories (each has an id). Do three things: " +
    "(1) Extract only HIGH-SIGNAL, durable facts/preferences/habits worth remembering long-term — never transient details of a single task. " +
    "(2) DE-DUPLICATE thoroughly: cluster ALL memories that express the same fact into one duplicateGroups entry — list every one of their ids together with a single merged 'text' that replaces the whole cluster. Each distinct fact must end up represented exactly once. Never put memories about DIFFERENT things in the same group, and never leave two memories that say the same thing ungrouped. " +
    "(3) Suggest at most 3 of the BEST gentle, concrete proactive ideas grounded in real patterns — quality over quantity, fewer is better. " +
    "Plain language, no jargon.";
  const memBlock = memList.length
    ? memList.map((m) => `[${m.id}] ${m.text}`).join("\n")
    : "(none)";
  const user = `EXISTING MEMORIES (id in brackets):\n${memBlock}\n\nRECENT CONVERSATIONS:\n${convos || "(none)"}\n\n${SCHEMA_HINT}`;

  let raw: string;
  try {
    const res = await client.chat.completions.create({
      model: config.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
      temperature: 0.3,
    });
    raw = res.choices[0]?.message?.content ?? "{}";
  } catch {
    return { added: 0, merged: 0, removed: 0, suggested: 0 };
  }

  let out: any;
  try {
    out = JSON.parse(raw);
  } catch {
    return { added: 0, merged: 0, removed: 0, suggested: 0 };
  }
  const newMemories = validItems(out?.newMemories, DreamMemory);
  const groups = validItems(out?.duplicateGroups, DreamGroup);
  const suggestionList = validItems(out?.suggestions, DreamSuggestion);

  const ids = new Set(memList.map((m) => m.id));

  // De-duplicate by collapsing each cluster to its first id (rewritten to the merged text)
  // and deleting the rest. We always keep one per group, so this can't wipe a fact.
  let merged = 0;
  let removed = 0;
  for (const g of groups) {
    const gids = g.ids.filter((id) => ids.has(id)); // only operate on ids in the current set
    if (gids.length === 0) continue;
    const keep = gids[0];
    if (g.text && g.text.trim()) {
      await store.updateMemory(keep, g.text);
      merged++;
    }
    for (const rid of gids.slice(1)) {
      store.deleteMemory(rid);
      ids.delete(rid);
      removed++;
    }
  }

  // New durable facts (addMemory still skips exact duplicates).
  let added = 0;
  for (const m of newMemories) {
    const before = store.listMemories().length;
    await store.addMemory(m.text, m.kind ?? "fact", "dream");
    if (store.listMemories().length > before) added++; // addMemory no-ops on blank/exact-dup
  }

  let suggested = 0;
  for (const s of suggestionList.slice(0, 3)) {
    store.addSuggestion(s.text, s.prompt && s.prompt.trim() ? s.prompt : null);
    suggested++;
  }

  store.setSetting("lastDream", String(Date.now()));
  return { added, merged, removed, suggested };
}
