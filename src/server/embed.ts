// Embeddings via OpenRouter (openai/text-embedding-3-small, 1536-dim). Powers
// relevance-filtered memory retrieval: instead of dumping every saved memory into the
// system prompt, we embed the task + the memories and inject only the closest ones.
// Verified 2026-06-17: OpenRouter serves /embeddings for this model even though it isn't
// listed in /api/v1/models. Every call fails SOFT (returns null) so retrieval can fall back
// to recency — embeddings are an optimization here, never a hard dependency.
import { client } from "../client.ts";

const EMBED_MODEL = "openai/text-embedding-3-small";
export const EMBED_DIM = 1536;

// Embed one string. Returns the vector, or null on any failure (blank input, network error,
// malformed response) so the caller can fall back to recency.
export async function embed(text: string): Promise<number[] | null> {
  const input = text.trim();
  if (!input) return null;
  try {
    const res = await client.embeddings.create({ model: EMBED_MODEL, input });
    const vec = res.data?.[0]?.embedding;
    return Array.isArray(vec) && vec.length ? (vec as number[]) : null;
  } catch {
    return null;
  }
}

// Embed many strings in ONE request (used to backfill existing memories). Returns an array
// aligned to the input order; a slot is null if that text was blank or the call failed. We
// reorder by the API's `index` field defensively — it returns rows in order, but we don't
// rely on that.
export async function embedMany(texts: string[]): Promise<(number[] | null)[]> {
  const out: (number[] | null)[] = new Array(texts.length).fill(null);
  // Only send non-empty inputs; remember each one's original position.
  const live: { pos: number; text: string }[] = [];
  texts.forEach((t, i) => {
    const s = t.trim();
    if (s) live.push({ pos: i, text: s });
  });
  if (!live.length) return out;
  try {
    const res = await client.embeddings.create({ model: EMBED_MODEL, input: live.map((l) => l.text) });
    res.data.forEach((d, i) => {
      const slot = live[d.index ?? i]; // map the API row back to its original position
      if (slot && Array.isArray(d.embedding) && d.embedding.length) {
        out[slot.pos] = d.embedding as number[];
      }
    });
  } catch {
    // leave everything null — caller falls back to recency
  }
  return out;
}

// Cosine similarity of two equal-length vectors, in [-1, 1]. Returns -1 for
// missing / mismatched / zero vectors so they sort to the bottom.
export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a || !b || a.length !== b.length || a.length === 0) return -1;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return -1;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
