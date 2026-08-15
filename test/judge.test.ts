import { test } from "node:test";
import assert from "node:assert/strict";
import type { Client } from "@libsql/client";
import { ingestUrl } from "../src/ingest.js";
import {
  agreement,
  buildJudgePrompt,
  judgePool,
  parseJudgeReply,
  selectAnchors,
  toQuerySpecs,
  type Judgement,
} from "../src/commands/judge.js";
import { EMBEDDING_DIMS, EMBEDDING_MODEL, type Embedder } from "../src/embed.js";
import type { QuerySpec } from "../src/eval.js";
import { makeTestClient, fakeExtractOk, richContent } from "./helpers.js";

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

/** Wrap judgements in the same envelope the claude CLI returns. */
const envelope = (judgements: Judgement[]) =>
  JSON.stringify({ result: JSON.stringify(judgements), is_error: false });

const spec = (query: string, gold: QuerySpec["gold"]): QuerySpec => ({ query, gold });

// --- reply parsing ---------------------------------------------------------

test("a fenced reply inside the CLI envelope parses", () => {
  const stdout = JSON.stringify({
    result: '```json\n[{"id":7,"grade":3,"why":"answers it"}]\n```',
    is_error: false,
  });
  assert.deepEqual(parseJudgeReply(stdout), [{ id: 7, grade: 3, why: "answers it" }]);
});

test("a grade off the 0-3 scale is dropped, not clamped", () => {
  // A 5 means the judge worked to a different scale; keeping it as a 3 would
  // hide that and silently inflate the gold.
  const parsed = parseJudgeReply(
    envelope([
      { id: 1, grade: 5 as unknown as 3, why: "off-scale" },
      { id: 2, grade: 2, why: "fine" },
    ]),
  );
  assert.deepEqual(parsed, [{ id: 2, grade: 2, why: "fine" }]);
});

// Seen once in a 30-query validation run: the reply was complete and correct,
// just newline-delimited instead of wrapped, and it cost the whole batch.
test("a newline-delimited reply parses instead of losing the batch", () => {
  const stdout = JSON.stringify({
    result: '{"id":29,"grade":1,"why":"a"}\n{"id":55,"grade":3,"why":"b"}',
    is_error: false,
  });
  assert.deepEqual(parseJudgeReply(stdout), [
    { id: 29, grade: 1, why: "a" },
    { id: 55, grade: 3, why: "b" },
  ]);
});

// The second deviation seen in a real run: "That tool call was unnecessary for
// this task — ignore it. Here's the grading:" ahead of an otherwise valid array.
test("a prose preamble before the array is stripped, not fatal", () => {
  const stdout = JSON.stringify({
    result: 'Ignore the previous step. Here is the grading:\n[{"id":3,"grade":2,"why":"ok"}]',
    is_error: false,
  });
  assert.deepEqual(parseJudgeReply(stdout), [{ id: 3, grade: 2, why: "ok" }]);
});

test("a bracket inside a why string does not truncate the array", () => {
  const stdout = JSON.stringify({
    result: 'Here:\n[{"id":3,"grade":2,"why":"mentions [brackets] and \\"quotes\\""}]',
    is_error: false,
  });
  const parsed = parseJudgeReply(stdout);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].why, 'mentions [brackets] and "quotes"');
});

// A reply cut off mid-flight: the judgements before the cut are complete and
// usable, and losing 19 of them because the 20th was severed is the wrong trade.
test("a truncated array salvages the complete judgements before the cut", () => {
  const stdout = JSON.stringify({
    result: '[{"id":1,"grade":3,"why":"a"},{"id":2,"grade":2,"why":"b"},{"id":3,"grade":1,"wh',
    is_error: false,
  });
  assert.deepEqual(parseJudgeReply(stdout), [
    { id: 1, grade: 3, why: "a" },
    { id: 2, grade: 2, why: "b" },
  ]);
});

test("prose that merely contains a brace is still a failure", () => {
  const stdout = JSON.stringify({ result: "I cannot judge these {items}", is_error: false });
  assert.throws(() => parseJudgeReply(stdout));
});

test("a CLI error envelope throws rather than returning nothing", () => {
  assert.throws(() => parseJudgeReply(JSON.stringify({ is_error: true, result: "boom" })));
  assert.throws(() => parseJudgeReply("not json at all"));
});

// --- the prompt ------------------------------------------------------------

test("the prompt carries passages and never the existing grade", () => {
  const prompt = buildJudgePrompt("zebra habitat", [
    { id: 4, title: "Zebras", domain: "example.com", evidence: ["zebras live in savanna"] },
  ]);
  assert.match(prompt, /QUERY: zebra habitat/);
  assert.match(prompt, /zebras live in savanna/);
  assert.match(prompt, /3 = answers the query/);
  // A judge shown the answer agrees with it; agreement would then measure nothing.
  assert.doesNotMatch(prompt, /existing grade|already judged|gold/i);
});

test("an item with no passages says so rather than showing a bare title", () => {
  const prompt = buildJudgePrompt("q", [
    { id: 9, title: "Untitled thing", domain: null, evidence: [] },
  ]);
  assert.match(prompt, /\(no extracted content\)/);
});

// --- agreement -------------------------------------------------------------

test("agreement separates the relevance cut from the exact grade", () => {
  const human = [
    { id: 1, grade: 3 as const },
    { id: 2, grade: 2 as const },
    { id: 3, grade: 1 as const },
  ];
  const judged: Judgement[] = [
    { id: 1, grade: 2, why: "" }, // relevant both ways, one grade apart
    { id: 2, grade: 2, why: "" }, // exact
    { id: 3, grade: 1, why: "" }, // exact
  ];
  const a = agreement(human, judged);
  assert.equal(a.compared, 3);
  assert.equal(a.exact, 2);
  assert.equal(a.withinOne, 3);
  assert.equal(a.relevant, 3); // the cut the metrics use: all three agree
  assert.equal(a.judgeStricter, 0);
  assert.equal(a.judgeLooser, 0);
});

test("agreement counts which direction the judge erred", () => {
  const human = [
    { id: 1, grade: 3 as const },
    { id: 2, grade: 1 as const },
  ];
  const judged: Judgement[] = [
    { id: 1, grade: 1, why: "" }, // human relevant, judge not
    { id: 2, grade: 3, why: "" }, // judge relevant, human not
  ];
  const a = agreement(human, judged);
  assert.equal(a.relevant, 0);
  assert.equal(a.judgeStricter, 1);
  assert.equal(a.judgeLooser, 1);
});

test("agreement ignores ids the judge did not return", () => {
  const a = agreement([{ id: 1, grade: 3 }, { id: 2, grade: 2 }], [{ id: 1, grade: 3, why: "" }]);
  assert.equal(a.compared, 1);
});

// --- the run ---------------------------------------------------------------

async function corpus() {
  const client = await makeTestClient();
  const a = await ingestUrl(client, "https://example.com/a", {
    extract: fakeExtractOk(richContent("zebra"), "Zebra facts"),
  });
  const b = await ingestUrl(client, "https://example.com/b", {
    extract: fakeExtractOk(richContent("zebra"), "Zebra notes"),
  });
  await setItemVector(client, a.id, 0);
  await setItemVector(client, b.id, Math.PI / 6);
  return { client, a: a.id, b: b.id };
}

// The correction that this whole mode exists to encode: a batch of nothing but
// pre-selected gold is uniformly plausible, a real batch is mostly marginal, and
// the judge grades relative to its neighbours. Narrowing the *batch* measured a
// calibration the judge never uses, so only the *scoring* narrows.
test("validate keeps batches production-shaped and narrows only the scoring", async () => {
  const { client, a, b } = await corpus();
  const seen: number[][] = [];
  const result = await judgePool(client, [spec("zebra", [{ id: a, grade: 3 }])], {
    validate: true,
    anchorsPerGrade: 0,
    depth: 50,
    batchSize: 20,
    limit: 30,
    model: "test",
    embed: queryEmbedder,
    runner: async (prompt) => {
      const ids = [...prompt.matchAll(/^id=(\d+)/gm)].map((m) => Number(m[1]));
      seen.push(ids);
      return envelope(ids.map((id) => ({ id, grade: 3 as const, why: "x" })));
    },
  });
  // The ungraded item b must still be in the batch — it is the marginal company
  // that moves the judge's scale.
  assert.deepEqual(seen.flat().sort((x, y) => x - y), [a, b].sort((x, y) => x - y));
  // ...but only the graded item is scored.
  assert.equal(result.agreement?.compared, 1);
  assert.equal(result.agreement?.exact, 1);
});

test("a full run judges every pooled candidate", async () => {
  const { client, a, b } = await corpus();
  const result = await judgePool(client, [spec("zebra", [{ id: a, grade: 3 }])], {
    validate: false,
    anchorsPerGrade: 0,
    depth: 50,
    batchSize: 20,
    limit: 30,
    model: "test",
    embed: queryEmbedder,
    runner: async (prompt) => {
      const ids = [...prompt.matchAll(/^id=(\d+)/gm)].map((m) => Number(m[1]));
      return envelope(ids.map((id) => ({ id, grade: 2 as const, why: "y" })));
    },
  });
  const judged = result.queries[0].judgements.map((j) => j.id).sort((x, y) => x - y);
  assert.deepEqual(judged, [a, b].sort((x, y) => x - y));
  assert.equal(result.agreement, undefined); // not a validation run
});

test("an id the model invented is discarded", async () => {
  const { client, a } = await corpus();
  const result = await judgePool(client, [spec("zebra", [{ id: a, grade: 3 }])], {
    validate: true,
    anchorsPerGrade: 0,
    depth: 50,
    batchSize: 20,
    limit: 30,
    model: "test",
    embed: queryEmbedder,
    runner: async () =>
      envelope([
        { id: a, grade: 3, why: "real" },
        { id: 4242, grade: 3, why: "hallucinated" },
      ]),
  });
  assert.deepEqual(
    result.queries[0].judgements.map((j) => j.id),
    [a],
  );
});

test("one failed batch does not lose the run", async () => {
  const { client, a } = await corpus();
  const result = await judgePool(client, [spec("zebra", [{ id: a, grade: 3 }])], {
    validate: true,
    anchorsPerGrade: 0,
    depth: 50,
    batchSize: 20,
    limit: 30,
    model: "test",
    embed: queryEmbedder,
    runner: async () => "garbage, not json",
  });
  assert.equal(result.failures.length, 1);
  assert.equal(result.queries.length, 1);
  assert.equal(result.queries[0].judgements.length, 0);
});

// The quiet failure this guards: a candidate nobody graded drops out of the
// proposed gold looking exactly like one graded irrelevant.
test("candidates the judge skipped are counted, not silently dropped", async () => {
  const { client, a } = await corpus();
  const result = await judgePool(client, [spec("zebra", [{ id: a, grade: 3 }])], {
    validate: false,
    anchorsPerGrade: 0,
    depth: 50,
    batchSize: 20,
    limit: 30,
    model: "test",
    embed: queryEmbedder,
    // Grades only the first candidate, whatever else was asked about.
    runner: async (prompt) => {
      const first = Number(/^id=(\d+)/m.exec(prompt)![1]);
      return envelope([{ id: first, grade: 2, why: "only one" }]);
    },
  });
  const q = result.queries[0];
  assert.equal(q.candidates, 2);
  assert.equal(q.judgements.length, 1);
  assert.equal(result.unjudged, 1);
});

test("a failed batch counts its whole batch as ungraded", async () => {
  const { client, a } = await corpus();
  const result = await judgePool(client, [spec("zebra", [{ id: a, grade: 3 }])], {
    validate: false,
    anchorsPerGrade: 0,
    depth: 50,
    batchSize: 20,
    limit: 30,
    model: "test",
    embed: queryEmbedder,
    runner: async () => "garbage",
  });
  assert.equal(result.failures.length, 1);
  assert.equal(result.unjudged, 2); // both pooled candidates, not zero
});

test("limit caps how many queries are judged", async () => {
  const { client, a } = await corpus();
  const specs = [spec("zebra", [{ id: a, grade: 3 }]), spec("zebra again", [{ id: a, grade: 3 }])];
  const result = await judgePool(client, specs, {
    validate: true,
    anchorsPerGrade: 0,
    depth: 50,
    batchSize: 20,
    limit: 1,
    model: "test",
    embed: queryEmbedder,
    runner: async () => envelope([{ id: a, grade: 3, why: "x" }]),
  });
  assert.equal(result.queries.length, 1);
});

// --- anchoring -------------------------------------------------------------

test("anchors span the grades, preferring items that state a reason", () => {
  const specs: QuerySpec[] = [
    {
      query: "q1",
      gold: [
        { id: 2, grade: 3 }, // bare
        { id: 1, grade: 3, why: "clear three" }, // reasoned: preferred
        { id: 3, grade: 1 },
      ],
    },
    { query: "q2", gold: [{ id: 4, grade: 2, why: "clear two" }] },
  ];
  const picked = selectAnchors(specs, 1);
  assert.deepEqual(
    picked.map((p) => p.item.id),
    [1, 4, 3], // one per grade, 3 then 2 then 1
  );
});

// Every grade-1 item in the real set is a bare id, and grade 1 is the boundary
// the judge actually drifts across — requiring a reason left the bottom of the
// scale with no worked example at all.
test("a grade with no reasoned items still yields an anchor", () => {
  const specs: QuerySpec[] = [
    { query: "q1", gold: [{ id: 1, grade: 3, why: "three" }, { id: 2, grade: 1 }] },
  ];
  const picked = selectAnchors(specs, 1);
  assert.deepEqual(picked.map((p) => p.item.grade).sort(), [1, 3]);
});

// Anchors are subtracted from the scoring of whichever query they come from, so
// concentrating them in one query both skews the lesson and guts that query.
test("anchors spread across queries before doubling up on one", () => {
  const specs: QuerySpec[] = [
    { query: "q1", gold: [{ id: 1, grade: 3, why: "a" }, { id: 2, grade: 3, why: "b" }] },
    { query: "q2", gold: [{ id: 3, grade: 3, why: "c" }] },
  ];
  const picked = selectAnchors(specs, 2);
  assert.deepEqual(
    picked.map((p) => p.item.id),
    [1, 3], // one from each query, not both from q1
  );
});

test("the prompt states anchors are correct and caps generosity", () => {
  const prompt = buildJudgePrompt(
    "zebra habitat",
    [{ id: 9, title: "T", domain: "d", evidence: ["x"] }],
    [{ query: "other query", id: 1, grade: 3, why: "a worked three", evidence: ["anchor text"] }],
  );
  assert.match(prompt, /WORKED EXAMPLES/);
  assert.match(prompt, /GRADE 3 — a worked three/);
  assert.match(prompt, /anchor text/);
  assert.match(prompt, /do not grade more generously/i);
  // The example's own query is named, so its grade is not read as this query's.
  assert.match(prompt, /other query/);
});

test("no anchors means no worked-examples block at all", () => {
  const prompt = buildJudgePrompt("q", [{ id: 1, title: "T", domain: "d", evidence: ["x"] }]);
  assert.doesNotMatch(prompt, /WORKED EXAMPLES/);
});

// An item shown with its grade cannot also be evidence that the judge
// reproduces that grade.
test("anchor items are excluded from both the candidates and the scoring", async () => {
  const { client, a, b } = await corpus();
  const seen: number[] = [];
  const result = await judgePool(
    client,
    // Both are grade 3 and only one anchor per grade is taken, so `a` (the
    // reasoned one, preferred) is consumed and `b` stays a scored candidate.
    [spec("zebra", [{ id: a, grade: 3, why: "the anchor" }, { id: b, grade: 3 }])],
    {
      validate: true,
      anchorsPerGrade: 1,
      depth: 50,
      batchSize: 20,
      limit: 30,
      model: "test",
      embed: queryEmbedder,
      runner: async (prompt) => {
        const ids = [...prompt.matchAll(/^id=(\d+)/gm)].map((m) => Number(m[1]));
        seen.push(...ids);
        return envelope(ids.map((id) => ({ id, grade: 2 as const, why: "x" })));
      },
    },
  );
  assert.ok(!seen.includes(a), "the anchor must not be graded as a candidate");
  assert.ok(seen.includes(b));
  assert.equal(result.agreement?.compared, 1); // b only, not a
});

// --- emitting the proposed set ---------------------------------------------

test("grade 0 is dropped from the proposed gold, and notes survive", () => {
  const specs: QuerySpec[] = [{ query: "q", gold: [1], note: "keep me" }];
  const proposed = toQuerySpecs(specs, {
    queries: [
      {
        query: "q",
        candidates: 3,
        judgements: [
          { id: 1, grade: 0, why: "not relevant" },
          { id: 2, grade: 3, why: "answers it" },
          { id: 3, grade: 1, why: "touches it" },
        ],
      },
    ],
    batches: 1,
    failures: [],
    unjudged: 0,
  });
  assert.equal(proposed[0].note, "keep me");
  assert.deepEqual(proposed[0].gold, [
    { id: 2, grade: 3, why: "answers it" },
    { id: 3, grade: 1, why: "touches it" },
  ]);
});
