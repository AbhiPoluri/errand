// embed.ts offline suite (rank 16) — NO network. Verifies the two things memory retrieval
// rests on: cosineSimilarity's edge behavior, and embedMany's order-preserving index remap +
// the "embeddings fail SOFT, never a hard dependency" contract. memtest only exercises these
// indirectly against a LIVE endpoint; here we inject a stub client.
import { cosineSimilarity, embed, embedMany, _setEmbedClient } from "./embed.ts";

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!cond) failures++;
};
const approx = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;

// A stub embeddings client that records every call and returns a scripted response.
function stub(handler: (args: any) => any) {
  const calls: any[] = [];
  return {
    client: {
      embeddings: {
        create: async (args: any) => {
          calls.push(args);
          return handler(args);
        },
      },
    },
    calls,
  };
}

function testCosine() {
  console.log("\n== cosineSimilarity edges ==");
  check("identical vectors -> 1", approx(cosineSimilarity([1, 2, 3], [1, 2, 3]), 1));
  check("orthogonal vectors -> 0", approx(cosineSimilarity([1, 0], [0, 1]), 0));
  check("opposite vectors -> -1", approx(cosineSimilarity([1, 0], [-1, 0]), -1));
  check("mismatched length -> -1", cosineSimilarity([1, 2], [1, 2, 3]) === -1);
  check("zero vector -> -1", cosineSimilarity([0, 0], [1, 1]) === -1);
  check("empty vectors -> -1", cosineSimilarity([], []) === -1);
}

async function testEmbedBlank() {
  console.log("\n== embed() blank input is a no-op (no call) ==");
  const s = stub(() => ({ data: [{ embedding: [9, 9, 9], index: 0 }] }));
  _setEmbedClient(s.client);
  const r = await embed("   ");
  check("blank input -> null", r === null);
  check("no API call made for blank input", s.calls.length === 0);
  _setEmbedClient(null);
}

async function testEmbedManyRemap() {
  console.log("\n== embedMany() remaps shuffled rows + drops blanks ==");
  // Inputs with blanks interleaved; only alpha/beta/gamma should be sent (positions 0,2,4).
  const s = stub((args: any) => {
    // The stub returns rows OUT OF ORDER but with correct `index` into the sent array
    // (0=alpha, 1=beta, 2=gamma). embedMany must map each back to its ORIGINAL position.
    return {
      data: [
        { index: 2, embedding: [3] }, // gamma
        { index: 0, embedding: [1] }, // alpha
        { index: 1, embedding: [2] }, // beta
      ],
    };
  });
  _setEmbedClient(s.client);
  const out = await embedMany(["alpha", "", "beta", "   ", "gamma"]);
  _setEmbedClient(null);

  check("only the 3 non-blank inputs were sent", s.calls.length === 1 && s.calls[0].input.length === 3, JSON.stringify(s.calls[0]?.input));
  check("blanks never sent", !s.calls[0].input.includes("") && !s.calls[0].input.includes("   "));
  check("alpha@0 mapped correctly", JSON.stringify(out[0]) === "[1]", JSON.stringify(out[0]));
  check("blank@1 -> null", out[1] === null);
  check("beta@2 mapped correctly", JSON.stringify(out[2]) === "[2]", JSON.stringify(out[2]));
  check("blank@3 -> null", out[3] === null);
  check("gamma@4 mapped correctly (no drift despite shuffled rows)", JSON.stringify(out[4]) === "[3]", JSON.stringify(out[4]));
}

async function testEmbedManyOutOfRangeIndex() {
  console.log("\n== embedMany() ignores an out-of-range index without drift or throw ==");
  // A malformed `index` (out of range of the sent batch) must be dropped by the `if (slot && …)`
  // guard — never throw, never corrupt another row's slot.
  const s = stub(() => ({
    data: [
      { index: 99, embedding: [9] }, // garbage -> live[99] undefined -> dropped
      { index: 1, embedding: [2] },
      { index: 2, embedding: [3] },
    ],
  }));
  _setEmbedClient(s.client);
  const out = await embedMany(["alpha", "beta", "gamma"]);
  _setEmbedClient(null);
  check("3-length result, no throw", out.length === 3);
  check("out-of-range row dropped (its slot stays null)", out[0] === null, JSON.stringify(out[0]));
  check("the other rows still map correctly (no drift)", JSON.stringify(out[1]) === "[2]" && JSON.stringify(out[2]) === "[3]");
}

async function testEmbedManyMissingIndex() {
  console.log("\n== embedMany() falls back to positional order when index is absent ==");
  // A server that omits `index` -> embedMany uses the row's positional `i` (the `?? i` fallback).
  const s = stub(() => ({ data: [{ embedding: [1] }, { embedding: [2] }, { embedding: [3] }] }));
  _setEmbedClient(s.client);
  const out = await embedMany(["alpha", "beta", "gamma"]);
  _setEmbedClient(null);
  check("row 0 -> position 0", JSON.stringify(out[0]) === "[1]");
  check("row 1 -> position 1", JSON.stringify(out[1]) === "[2]");
  check("row 2 -> position 2", JSON.stringify(out[2]) === "[3]");
}

async function testEmbedManyAllBlank() {
  console.log("\n== embedMany() all-blank short-circuits with no call ==");
  const s = stub(() => ({ data: [] }));
  _setEmbedClient(s.client);
  const out = await embedMany(["", "  ", "\t"]);
  _setEmbedClient(null);
  check("all-null result", out.length === 3 && out.every((x) => x === null));
  check("no API call made", s.calls.length === 0);
}

async function testEmbedManyFailSoft() {
  console.log("\n== embedMany() fails soft on a thrown API error ==");
  const s = stub(() => {
    throw new Error("network down");
  });
  _setEmbedClient(s.client);
  const out = await embedMany(["a", "b", "c"]);
  _setEmbedClient(null);
  check("thrown error -> all null (never a hard failure)", out.length === 3 && out.every((x) => x === null));
}

async function main() {
  testCosine();
  await testEmbedBlank();
  await testEmbedManyRemap();
  await testEmbedManyOutOfRangeIndex();
  await testEmbedManyMissingIndex();
  await testEmbedManyAllBlank();
  await testEmbedManyFailSoft();
  console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILED"}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("test crashed:", e);
  process.exit(1);
});
