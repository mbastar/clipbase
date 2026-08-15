import { test } from "node:test";
import assert from "node:assert/strict";
import type { Client } from "@libsql/client";
import { ingestUrl } from "../src/ingest.js";
import { buildPool, poolEvidence, formatPool, POOL_DEPTH } from "../src/commands/pool.js";
import { EMBEDDING_DIMS, EMBEDDING_MODEL, type Embedder } from "../src/embed.js";
import type { QuerySpec } from "../src/eval.js";
import { makeTestClient, fakeExtractOk, richContent } from "./helpers.js";

// Same circle trick as the search tests: a unit vector at angle θ in the first
// two dimensions, so similarity to the query at θ=0 is cos θ and an item's
// semantic rank is chosen by picking its angle.
function vectorAt(theta: number): number[] {
  const v = Array.from({ length: EMBEDDING_DIMS }, () => 0);
  v[0] = Math.cos(theta);
  v[1] = Math.sin(theta);
  return v;
}

const queryEmbedder: Embedder = async (texts) => ({
  vectors: texts.map(() => vectorAt(0)),
  tokens: 0,
});

async function setItemVector(client: Client, itemId: number, theta: number) {
  await client.execute({
    sql: `UPDATE chunks SET embedding = vector32(?), embedding_model = ? WHERE item_id = ?`,
    args: [JSON.stringify(vectorAt(theta)), EMBEDDING_MODEL, itemId],
  });
}

const spec = (query: string, gold: QuerySpec["gold"]): QuerySpec => ({ query, gold });

test("the pool is the union of both rankers, with each list's rank kept", async () => {
  const client = await makeTestClient();
  // Matches the query lexically; given a distant vector so semantic ranks it last.
  const lexical = await ingestUrl(client, "https://example.com/lexical", {
    extract: fakeExtractOk(richContent("zebra"), "Zebra facts"),
  });
  // No shared surface word, but placed nearest the query vector.
  const semantic = await ingestUrl(client, "https://example.com/semantic", {
    extract: fakeExtractOk(richContent("quagga"), "Quagga notes"),
  });
  await setItemVector(client, lexical.id, Math.PI / 2); // orthogonal: similarity 0
  await setItemVector(client, semantic.id, 0); // identical: similarity 1

  const report = await buildPool(client, [spec("zebra", [lexical.id])], POOL_DEPTH, {
    embed: queryEmbedder,
  });
  const [q] = report.queries;
  const ids = q.candidates.map((c) => c.id).sort((a, b) => a - b);
  assert.deepEqual(ids, [lexical.id, semantic.id].sort((a, b) => a - b));

  const lex = q.candidates.find((c) => c.id === lexical.id)!;
  const sem = q.candidates.find((c) => c.id === semantic.id)!;
  assert.equal(lex.ftsRank, 1); // only lexical matches the FTS query
  assert.equal(sem.ftsRank, undefined);
  assert.equal(sem.semanticRank, 1); // nearest vector leads the semantic list
  assert.ok((lex.semanticRank ?? 0) > 1);
});

test("an already-judged id carries its grade into the pool", async () => {
  const client = await makeTestClient();
  const item = await ingestUrl(client, "https://example.com/a", {
    extract: fakeExtractOk(richContent("zebra"), "Zebra facts"),
  });
  await setItemVector(client, item.id, 0);

  const report = await buildPool(
    client,
    [spec("zebra", [{ id: item.id, grade: 3, why: "answers it" }])],
    POOL_DEPTH,
    { embed: queryEmbedder },
  );
  const c = report.queries[0].candidates.find((x) => x.id === item.id)!;
  assert.equal(c.grade, 3);
  assert.equal(c.unreachable, false);
});

// The reason the pool unions gold rather than trusting the rankers: gold was
// judged against a smaller corpus, and items added since push older ones past
// the depth cut. Re-pooling on the rankers alone would silently drop a
// judgement that is still correct, and shrink the recall denominator with it.
test("judged items the rankers cannot reach stay in the pool, flagged", async () => {
  const client = await makeTestClient();
  const reachable = await ingestUrl(client, "https://example.com/reachable", {
    extract: fakeExtractOk(richContent("zebra"), "Zebra facts"),
  });
  const buried = await ingestUrl(client, "https://example.com/buried", {
    extract: fakeExtractOk(richContent("unrelated"), "Unrelated"),
  });
  await setItemVector(client, reachable.id, 0);
  await setItemVector(client, buried.id, Math.PI); // opposite: worst similarity

  // depth 1 lets only the single best result through each ranker, so the buried
  // item is judged but unretrievable — the recall-ceiling case.
  const report = await buildPool(
    client,
    [spec("zebra", [{ id: reachable.id, grade: 3 }, { id: buried.id, grade: 2 }])],
    1,
    { embed: queryEmbedder },
  );
  const [q] = report.queries;
  const b = q.candidates.find((c) => c.id === buried.id)!;
  assert.equal(b.unreachable, true);
  assert.equal(b.grade, 2);
  assert.equal(q.unreachableCount, 1);
  // Hydrated from the items table, since no search row supplied it.
  assert.equal(b.title, "Unrelated");

  const r = q.candidates.find((c) => c.id === reachable.id)!;
  assert.equal(r.unreachable, false);

  // Unreachable gold sorts last: it has no rank to be confident about.
  assert.equal(q.candidates[q.candidates.length - 1].id, buried.id);
});

test("depth bounds each ranker's contribution", async () => {
  const client = await makeTestClient();
  for (let i = 0; i < 4; i += 1) {
    const item = await ingestUrl(client, `https://example.com/z${i}`, {
      extract: fakeExtractOk(richContent("zebra"), `Zebra ${i}`),
    });
    await setItemVector(client, item.id, (i * Math.PI) / 8);
  }
  const deep = await buildPool(client, [spec("zebra", [1])], 4, { embed: queryEmbedder });
  const shallow = await buildPool(client, [spec("zebra", [1])], 2, { embed: queryEmbedder });
  assert.equal(deep.queries[0].candidates.length, 4);
  assert.ok(shallow.queries[0].candidates.length < 4);
  assert.equal(shallow.depth, 2);
});

test("evidence returns the chunks nearest the query, not the opening ones", async () => {
  const client = await makeTestClient();
  const item = await ingestUrl(client, "https://example.com/doc", {
    extract: fakeExtractOk(richContent("zebra", 600), "Zebra facts"),
  });
  await setItemVector(client, item.id, 0);

  const evidence = await poolEvidence(client, "zebra", [item.id], {
    embed: queryEmbedder,
    perItem: 2,
  });
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].id, item.id);
  assert.ok(evidence[0].wordCount > 0);
  assert.ok(evidence[0].matches.length > 0);
  // Similarity is descending: nearest first.
  const sims = evidence[0].matches.map((m) => m.similarity);
  assert.deepEqual(sims, [...sims].sort((a, b) => b - a));
});

test("evidence skips an id that is not an item, rather than throwing", async () => {
  const client = await makeTestClient();
  const evidence = await poolEvidence(client, "zebra", [9999], { embed: queryEmbedder });
  assert.deepEqual(evidence, []);
});

test("the report counts judged and unjudged candidates separately", async () => {
  const client = await makeTestClient();
  const judged = await ingestUrl(client, "https://example.com/judged", {
    extract: fakeExtractOk(richContent("zebra"), "Judged"),
  });
  const fresh = await ingestUrl(client, "https://example.com/fresh", {
    extract: fakeExtractOk(richContent("zebra"), "Fresh"),
  });
  await setItemVector(client, judged.id, 0);
  await setItemVector(client, fresh.id, Math.PI / 6);

  const report = await buildPool(
    client,
    [spec("zebra", [{ id: judged.id, grade: 3 }])],
    POOL_DEPTH,
    { embed: queryEmbedder },
  );
  const [q] = report.queries;
  assert.equal(q.goldCount, 1);
  assert.equal(q.candidates.filter((c) => c.grade !== undefined).length, 1);
  assert.equal(q.candidates.filter((c) => c.grade === undefined).length, 1);

  const text = formatPool(report);
  assert.match(text, /1 already judged, 1 to judge/);
  assert.match(text, new RegExp(`${fresh.id}\\s+·`)); // unjudged marked with a dot
});
