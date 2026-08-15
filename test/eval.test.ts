import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { scoreRanking, aggregate, normalizeGold, type GoldItem } from "../src/eval.js";
import { parseQuerySpecs, runEval, formatReport, type EvalReport } from "../src/commands/eval.js";
import {
  assertCollectionIntact,
  assertGoldWithinCollection,
  collectionPathFor,
  loadCollection,
  parseCollection,
  type Collection,
} from "../src/commands/eval-collection.js";
import { EMBEDDING_DIMS, type Embedder } from "../src/embed.js";
import { ingestUrl } from "../src/ingest.js";
import { makeTestClient, fakeExtractOk, richContent } from "./helpers.js";

test("a gold hit at rank 1 is a perfect score", () => {
  const m = scoreRanking([7, 2, 3], [7], 10);
  assert.equal(m.firstGoldRank, 1);
  assert.equal(m.hit1, 1);
  assert.equal(m.hit5, 1);
  assert.equal(m.reciprocalRank, 1);
  assert.equal(m.recall, 1);
  assert.equal(m.ndcg, 1);
});

test("reciprocal rank and nDCG discount a lower first hit", () => {
  const m = scoreRanking([1, 2, 7], [7], 10);
  assert.equal(m.firstGoldRank, 3);
  assert.equal(m.hit1, 0);
  assert.equal(m.hit5, 1);
  assert.equal(m.reciprocalRank, 1 / 3);
  // one gold, found at rank 3: dcg = 1/log2(4)=0.5, idcg = 1/log2(2)=1
  assert.equal(m.ndcg, 0.5);
});

test("recall is over the whole gold set, capped by k", () => {
  const two = scoreRanking([10, 20, 30], [10, 20], 10);
  assert.equal(two.recall, 1); // both surfaced
  const one = scoreRanking([10, 99, 98], [10, 20], 10);
  assert.equal(one.recall, 0.5); // only one of two gold ids
});

test("hits beyond k do not count", () => {
  const m = scoreRanking([1, 2, 3, 4, 7], [7], 3);
  assert.equal(m.firstGoldRank, null);
  assert.equal(m.hit5, 0); // top-5 slice is bounded by k=3 here
  assert.equal(m.reciprocalRank, 0);
  assert.equal(m.recall, 0);
  assert.equal(m.ndcg, 0);
});

test("hit5 sees rank 5 but not rank 6", () => {
  assert.equal(scoreRanking([1, 2, 3, 4, 7], [7], 10).hit5, 1);
  assert.equal(scoreRanking([1, 2, 3, 4, 5, 7], [7], 10).hit5, 0);
});

test("nDCG rewards packing multiple gold hits high", () => {
  const packed = scoreRanking([10, 20, 99], [10, 20], 10); // gold at 1,2
  const spread = scoreRanking([10, 99, 20], [10, 20], 10); // gold at 1,3
  assert.equal(packed.ndcg, 1);
  assert.ok(spread.ndcg < 1);
  assert.ok(spread.recall === packed.recall); // recall can't tell them apart; nDCG can
});

test("an empty ranking scores zero, not NaN", () => {
  const m = scoreRanking([], [7], 10);
  assert.equal(m.hit1, 0);
  assert.equal(m.reciprocalRank, 0);
  assert.equal(m.ndcg, 0);
});

test("aggregate averages each metric across queries", () => {
  const a = scoreRanking([7], [7], 10); // rr 1
  const b = scoreRanking([1, 7], [7], 10); // rr 0.5
  const agg = aggregate([a, b]);
  assert.equal(agg.queries, 2);
  assert.equal(agg.success1, 0.5);
  assert.equal(agg.mrr, 0.75);
});

test("an ungraded gold set scores exactly as it did before grading existed", () => {
  // What makes the graded metric safe to introduce: a bare id is grade 2, which
  // clears the answer threshold, and a uniform grade cancels out of nDCG. So a
  // set with no grades is scored by the same arithmetic as the binary version,
  // and any movement in the reported numbers is the query set's doing.
  const bare = scoreRanking([1, 10, 99, 20], [10, 20], 10);
  const graded = scoreRanking([1, 10, 99, 20], [
    { id: 10, grade: 2 },
    { id: 20, grade: 2 },
  ], 10);
  assert.deepEqual(graded, bare);

  // The cancellation is what carries that claim, so pin it: a set graded
  // uniformly at 3 scores the same as one graded uniformly at 2. Exactly equal
  // in real arithmetic — the gain factors out — but the two scale DCG by
  // different constants, so in doubles it lands a ulp apart.
  const allThrees = scoreRanking([1, 10, 99, 20], [
    { id: 10, grade: 3 },
    { id: 20, grade: 3 },
  ], 10);
  assert.ok(Math.abs(allThrees.ndcg - bare.ndcg) < 1e-12);
});

test("nDCG separates rankings that binary relevance scores identically", () => {
  const gold = [
    { id: 10, grade: 3 as const }, // the item that answers the query
    { id: 20, grade: 1 as const }, // merely touches the subject
  ];
  const rightOrder = scoreRanking([10, 20], gold, 10);
  const wrongOrder = scoreRanking([20, 10], gold, 10);

  // Binary relevance cannot tell these apart — both surface both gold items in
  // the top two — and that is the ceiling graded relevance is here to lift.
  assert.equal(rightOrder.recall, wrongOrder.recall);
  assert.equal(rightOrder.hit5, wrongOrder.hit5);

  assert.equal(rightOrder.ndcg, 1); // best possible order of this gold set
  assert.ok(wrongOrder.ndcg < 0.75);
});

test("the ideal ranking puts the highest grade first, whatever order gold is written in", () => {
  // dcg = 7/log2(2) + 1/log2(3); writing gold low-grade-first must not change it
  const shuffled = scoreRanking([10, 20], [
    { id: 20, grade: 1 },
    { id: 10, grade: 3 },
  ], 10);
  assert.equal(shuffled.ndcg, 1);
});

test("a grade-1 hit counts in nDCG but does not count as answering the query", () => {
  // The bug this threshold exists to stop: a method putting a "related, but not
  // what you wanted" item at rank 1 must not score a Success@1.
  const m = scoreRanking([7, 9], [{ id: 7, grade: 1 }, { id: 9, grade: 3 }], 10);
  assert.equal(m.hit1, 0);
  assert.equal(m.firstGoldRank, 2); // the answer at rank 2, not the marginal hit at 1
  assert.equal(m.reciprocalRank, 0.5);
  assert.equal(m.recall, 1); // one answer in the set, and it was found

  // But it is still worth more than an unjudged item: dropping it costs nDCG.
  const withoutIt = scoreRanking([99, 9], [{ id: 7, grade: 1 }, { id: 9, grade: 3 }], 10);
  assert.ok(m.ndcg > withoutIt.ndcg);
});

// --- gold equivalence classes -------------------------------------------------

// The property the whole change rests on: an item with no group is its own group
// of one, so the general arithmetic reduces to the old arithmetic term by term
// rather than branching around it. Every other test in this file is an ungrouped
// set, and this is why they still read the same numbers.
test("labelling every item as its own group changes nothing", () => {
  const gold = [
    { id: 10, grade: 3 as const },
    { id: 20, grade: 1 as const },
    { id: 30, grade: 2 as const },
    40,
  ];
  for (const k of [1, 3, 10]) {
    const solo = gold.map((g) => (typeof g === "number" ? g : { ...g, group: `solo${g.id}` }));
    assert.deepEqual(scoreRanking([20, 99, 10, 40, 30], solo, k), scoreRanking([20, 99, 10, 40, 30], gold, k));
  }
});

test("one answer at two URLs is one answer to recall", () => {
  const gold = [
    { id: 10, grade: 3 as const, group: "openviking" },
    { id: 11, grade: 3 as const, group: "openviking" },
    { id: 12, grade: 2 as const },
  ];
  assert.equal(scoreRanking([10, 12], gold, 10).recall, 1); // not 2/3
  assert.equal(scoreRanking([10, 11], gold, 10).recall, 0.5); // both copies of one of two answers
});

// The defect the canonical+echo grade demotion could not reach: the ideal has
// one representative per group, so returning either copy is a perfect answer.
test("returning one copy of a group is not punished, and either copy will do", () => {
  const pair = [
    { id: 10, grade: 3 as const, group: "openviking" },
    { id: 11, grade: 3 as const, group: "openviking" },
  ];
  assert.equal(scoreRanking([10], pair, 10).ndcg, 1);
  assert.equal(scoreRanking([11], pair, 10).ndcg, 1);

  const withOther = [...pair, { id: 12, grade: 2 as const }];
  assert.equal(scoreRanking([10], withOther, 10).ndcg, scoreRanking([11], withOther, 10).ndcg);
});

// Capping only the ideal and leaving DCG per-hit measures nDCG 1.45 on this
// exact set. The second copy earns nothing further — it still spent rank 2,
// which the ideal spent on the other answer.
test("returning both copies earns nothing extra, and never scores above 1", () => {
  const pair = [
    { id: 10, grade: 3 as const, group: "openviking" },
    { id: 11, grade: 3 as const, group: "openviking" },
  ];
  assert.equal(scoreRanking([10, 11], pair, 10).ndcg, scoreRanking([10], pair, 10).ndcg);

  const withOther = [...pair, { id: 12, grade: 2 as const }];
  const bothCopies = scoreRanking([10, 11, 12], withOther, 10).ndcg;
  const oneEach = scoreRanking([10, 12], withOther, 10).ndcg;
  assert.equal(oneEach, 1);
  assert.ok(bothCopies < oneEach);
  assert.ok(Math.abs(bothCopies - 8.5 / 8.892789260714372) < 1e-12);
});

// Grouping removes double counting; it does not make members interchangeable. A
// group is worth its best member, but a member is only ever credited at its own
// grade — otherwise a grade-1 echo at rank 1 would read as the answer.
test("a group's weaker member is credited at its own grade", () => {
  const gold = [
    { id: 10, grade: 3 as const, group: "agentcn" },
    { id: 11, grade: 1 as const, group: "agentcn" },
  ];
  const m = scoreRanking([11], gold, 10);
  assert.equal(m.hit1, 0);
  assert.equal(m.firstGoldRank, null);
  assert.equal(m.recall, 0);
  assert.equal(m.ndcg, 1 / 7); // gain(1) against an ideal that could have had gain(3)
});

// The real 53/326 shape: two grade-1 items that are one thing. They belong in no
// denominator, and the ideal counts them once instead of twice.
test("an all-grade-1 group is in no denominator and takes one slot in the ideal", () => {
  const grouped = [
    { id: 10, grade: 2 as const },
    { id: 11, grade: 1 as const, group: "echo" },
    { id: 12, grade: 1 as const, group: "echo" },
  ];
  const apart = grouped.map(({ id, grade }) => ({ id, grade }));
  assert.equal(scoreRanking([10], grouped, 10).recall, 1);
  assert.ok(scoreRanking([10], grouped, 10).ndcg > scoreRanking([10], apart, 10).ndcg);
});

// The real Q28 shape: only one member of a pair appears in this query's gold.
// A declared group of one has to score as an untagged item, or a consistent
// label across queries would change the numbers where it is alone.
test("a one-member group scores exactly as an untagged item", () => {
  const tagged = [{ id: 10, grade: 2 as const }, { id: 11, grade: 1 as const, group: "opencomputer" }];
  const untagged = [{ id: 10, grade: 2 as const }, { id: 11, grade: 1 as const }];
  for (const ranked of [[11, 10], [10], [], [11]]) {
    assert.deepEqual(scoreRanking(ranked, tagged, 10), scoreRanking(ranked, untagged, 10));
  }
});

test("parseQuerySpecs round-trips a group and leaves a bare id bare", () => {
  const [tagged, bare] = parseQuerySpecs('{"query":"a","gold":[{"id":5,"grade":3,"group":"openviking"},7]}')[0].gold;
  assert.equal(bare, 7);
  assert.equal((tagged as GoldItem).group, "openviking");

  // An undeclared group must be absent, not an own key holding `undefined`:
  // this suite compares gold with deepStrictEqual, which counts one.
  const [plain] = parseQuerySpecs('{"query":"a","gold":[{"id":5,"grade":3}]}')[0].gold;
  assert.ok(!("group" in (plain as object)));
});

test("parseQuerySpecs rejects a malformed group and one that changes between queries", () => {
  assert.throws(() => parseQuerySpecs('{"query":"a","gold":[{"id":5,"grade":3,"group":""}]}'), /expected a product slug/);
  assert.throws(() => parseQuerySpecs('{"query":"a","gold":[{"id":5,"grade":3,"group":5}]}'), /expected a product slug/);
  assert.throws(
    () => parseQuerySpecs('{"query":"a","gold":[{"id":5,"grade":3,"group":"p"}]}\n{"query":"b","gold":[5]}'),
    /gold id 5 is ungrouped in Q1 but "p" in Q0/,
  );
});

test("parseQuerySpecs reads graded gold and keeps the justification", () => {
  const specs = parseQuerySpecs('{"query":"a","gold":[{"id":5,"grade":3,"why":"answers it"},7]}');
  assert.deepEqual(specs[0].gold, [{ id: 5, grade: 3, why: "answers it" }, 7]);
  assert.deepEqual(normalizeGold(specs[0].gold), [
    { id: 5, grade: 3, why: "answers it" },
    { id: 7, grade: 2 },
  ]);
});

test("parseQuerySpecs rejects a query with no answer in its gold set", () => {
  assert.throws(
    () => parseQuerySpecs('{"query":"a","gold":[{"id":5,"grade":1},{"id":6,"grade":1}]}'),
    /every gold item is grade 1/,
  );
});

test("parseQuerySpecs rejects off-scale grades and repeated ids", () => {
  assert.throws(() => parseQuerySpecs('{"query":"a","gold":[{"id":5,"grade":5}]}'), /expected 1, 2 or 3/);
  assert.throws(() => parseQuerySpecs('{"query":"a","gold":[{"id":5}]}'), /expected 1, 2 or 3/);
  assert.throws(() => parseQuerySpecs('{"query":"a","gold":[{"grade":3}]}'), /positive integers/);
  assert.throws(() => parseQuerySpecs('{"query":"a","gold":[5,{"id":5,"grade":2}]}'), /gold id 5 listed twice/);
  assert.throws(() => parseQuerySpecs('{"query":"a","gold":[[5]]}'), /an item id or \{id, grade\}/);
});

test("parseQuerySpecs skips blank lines and reads specs", () => {
  const specs = parseQuerySpecs('{"query":"a","gold":[1,2]}\n\n{"query":"b","gold":[3],"note":"x"}\n');
  assert.equal(specs.length, 2);
  assert.deepEqual(specs[0].gold, [1, 2]);
  assert.equal(specs[1].note, "x");
});

test("parseQuerySpecs rejects malformed specs with the line number", () => {
  assert.throws(() => parseQuerySpecs("not json"), /line 1: not valid JSON/);
  assert.throws(() => parseQuerySpecs('{"query":"","gold":[1]}'), /line 1: "query"/);
  assert.throws(() => parseQuerySpecs('{"query":"a","gold":[]}'), /line 1: "gold"/);
  assert.throws(() => parseQuerySpecs('{"query":"a","gold":[0]}'), /positive integers/);
  assert.throws(() => parseQuerySpecs("\n  \n"), /query set is empty/);
});

// --- the judged collection ----------------------------------------------------

const PIN: Collection = {
  maxItemId: 411,
  pooledAt: "2026-07-29T00:00:00Z",
  source: "eval/queries.collection.json",
};

test("the pin is a positive item id and a pool date, or it is not a pin", () => {
  const ok = parseCollection('{"maxItemId":411,"pooledAt":"2026-07-29T00:00:00Z"}', "pin.json");
  assert.equal(ok.maxItemId, 411);
  assert.equal(ok.source, "pin.json");

  for (const bad of ['{"pooledAt":"x"}', '{"maxItemId":0,"pooledAt":"x"}', '{"maxItemId":-3,"pooledAt":"x"}', '{"maxItemId":411.5,"pooledAt":"x"}']) {
    assert.throws(() => parseCollection(bad, "pin.json"), /pin\.json: "maxItemId"/);
  }
  assert.throws(() => parseCollection('{"maxItemId":411}', "pin.json"), /pin\.json: "pooledAt"/);
  assert.throws(() => parseCollection('{"maxItemId":411,"pooledAt":"  "}', "pin.json"), /"pooledAt"/);
  assert.throws(() => parseCollection("not json", "pin.json"), /pin\.json: not valid JSON/);
});

test("the pin travels under the query set's own name", () => {
  assert.equal(collectionPathFor("eval/queries.jsonl"), "eval/queries.collection.json");
  assert.equal(collectionPathFor("eval/proposed.jsonl"), "eval/proposed.collection.json");
});

// A missing pin must not read as "no ceiling": that silently reproduces the
// understated numbers, and those are the ones that get quoted.
test("a query set with no pin refuses to run, and names the way out", async () => {
  await assert.rejects(loadCollection("eval/nope.jsonl"), (e: Error) => {
    assert.match(e.message, /eval\/nope\.collection\.json is missing/);
    assert.match(e.message, /--collection all/);
    return true;
  });
});

test("gold judged above the ceiling is a contradiction, named by query and id", () => {
  const specs = parseQuerySpecs('{"query":"a","gold":[7]}\n{"query":"b","gold":[3,{"id":999,"grade":3}]}');
  assert.throws(() => assertGoldWithinCollection(specs, PIN), /Q1: gold id 999 is above the collection ceiling 411/);
  assertGoldWithinCollection(specs.slice(0, 1), PIN); // within the ceiling, no throw
});

// ids are rowids with no AUTOINCREMENT, so deleting the highest one hands its
// number to the next ingest. The pin would then claim an unjudged item was
// judged; `created_at` is what catches it, since re-ingest never moves it.
test("an id reused after the pool was built fails the run", async () => {
  const client = await makeTestClient();
  const insert = (id: number, createdAt: string) =>
    client.execute({
      sql: `INSERT INTO items (id, source_type, url, status, created_at, updated_at)
            VALUES (?1, 'web', ?2, 'ok', ?3, ?3)`,
      args: [id, `https://example.com/${id}`, createdAt],
    });

  await insert(5, "2026-07-01T00:00:00Z");
  await assertCollectionIntact(client, PIN); // judged before pooling: nothing to answer for

  await insert(6, "2026-08-04T00:13:28.264Z");
  await assert.rejects(assertCollectionIntact(client, PIN), /item\(s\) 6 sit under the ceiling 411/);
});

test("an operator-named ceiling has no pool date, so it skips the id-reuse check", async () => {
  const client = await makeTestClient();
  await client.execute({
    sql: `INSERT INTO items (id, source_type, url, status, created_at, updated_at)
          VALUES (9, 'web', 'https://example.com/9', 'ok', '2099-01-01T00:00:00Z', '2099-01-01T00:00:00Z')`,
  });
  await assertCollectionIntact(client, { maxItemId: 411, source: "--collection 411" });
});

const oneQueryReport = (collection?: Collection): EvalReport => {
  const metrics = scoreRanking([1], [1], 10);
  return {
    k: 10,
    gold: [{ query: "a", gold: [1] }],
    collection,
    methods: [{ method: "fts", perQuery: [{ query: "a", ranked: [1], metrics }], aggregate: aggregate([metrics]) }],
  };
};

// The collection line sits with the numbers so a figure cannot be copied out
// without the collection it was measured over.
test("the report says which collection it measured, or warns that it did not", () => {
  assert.match(
    formatReport(oneQueryReport(PIN)),
    /collection · items 1–411 · eval\/queries\.collection\.json \(pooled 2026-07-29\)/,
  );
  assert.match(formatReport(oneQueryReport()), /UNPINNED: unjudged hits score 0, every number below is a floor/);
});

// The shipped pin and the shipped gold have to agree, and 487 has to stay the
// pool's high-water mark: the highest gold id in the set is exactly the ceiling.
// The literal is a tripwire, not a duplicate of the assertion below it — moving
// the ceiling has to be a deliberate edit here, in the same commit as the gold
// that earned it, or a fold silently redefines what every number was measured
// over. It is an id, not a count: the corpus holds 485 items across ids 1..487.
test("the query set that ships is inside the collection that ships", () => {
  const at = (name: string) => fileURLToPath(new URL(`../eval/${name}`, import.meta.url));
  const collection = parseCollection(readFileSync(at("queries.collection.json"), "utf8"), "eval/queries.collection.json");
  const specs = parseQuerySpecs(readFileSync(at("queries.jsonl"), "utf8"));
  assert.equal(collection.maxItemId, 487);
  assertGoldWithinCollection(specs, collection);
  const highest = Math.max(...specs.flatMap((s) => normalizeGold(s.gold).map((g) => g.id)));
  assert.equal(highest, collection.maxItemId);
});

// The ceiling is threaded into every method's search, not applied to the scored
// ranking: an optional argument a caller forgets to forward disables it in
// silence, so pin the wiring end to end rather than the SQL alone.
test("runEval never ranks an item the pool never reached", async () => {
  const client = await makeTestClient();
  const judged = await ingestUrl(client, "https://example.com/judged", {
    extract: fakeExtractOk(richContent("numbat", 60), "Numbat notes"),
  });
  const never = await ingestUrl(client, "https://example.com/never-pooled", {
    extract: fakeExtractOk(richContent("numbat", 900), "Numbat, never pooled"),
  });
  const specs = parseQuerySpecs(JSON.stringify({ query: "numbat", gold: [judged.id] }));
  const embed: Embedder = async (texts) => ({
    vectors: texts.map(() => Array.from({ length: EMBEDDING_DIMS }, () => 0)),
    tokens: 0,
  });

  const open = await runEval(client, specs, 10, { embed });
  const fts = (r: EvalReport) => r.methods.find((m) => m.method === "fts")!.perQuery[0];
  assert.ok(fts(open).ranked.includes(never.id), "unpinned, the never-pooled item takes a rank slot");
  assert.equal(fts(open).metrics.firstGoldRank, 2);

  const collection: Collection = { maxItemId: judged.id, source: "test" };
  const pinned = await runEval(client, specs, 10, { embed, collection });
  for (const method of pinned.methods) {
    assert.ok(!method.perQuery[0].ranked.includes(never.id), `${method.method} still ranked it`);
  }
  assert.equal(fts(pinned).metrics.firstGoldRank, 1);
  assert.deepEqual(pinned.collection, collection);
});
