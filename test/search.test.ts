import { test } from "node:test";
import assert from "node:assert/strict";
import type { Client } from "@libsql/client";
import { escapeFtsQuery } from "../src/fts.js";
import { ingestUrl } from "../src/ingest.js";
import { searchItems, searchSemantic, searchHybrid } from "../src/commands/search.js";
import { rrfFuse } from "../src/rank.js";
import { setSummary, attachTopics } from "../src/organize.js";
import { EMBEDDING_DIMS, EMBEDDING_MODEL, type Embedder } from "../src/embed.js";
import { makeTestClient, fakeExtractOk, richContent } from "./helpers.js";

test("escapeFtsQuery quotes every token and ORs them", () => {
  assert.equal(escapeFtsQuery("hello world"), '"hello" OR "world"');
  assert.equal(escapeFtsQuery('say "hi"'), '"say" OR """hi"""');
  assert.equal(escapeFtsQuery("full-text"), '"full-text"'); // one token, no OR
  assert.equal(escapeFtsQuery(""), "");
  assert.equal(escapeFtsQuery("   "), ""); // whitespace only stays empty
});

test("escapeFtsQuery drops repeated tokens and caps clause count", () => {
  assert.equal(escapeFtsQuery("zebra zebra zebra"), '"zebra"');
  const many = escapeFtsQuery(
    Array.from({ length: 50 }, (_, i) => `t${i}`).join(" "),
  );
  assert.equal(many.split(" OR ").length, 32); // MAX_TERMS
});

test("hostile query strings never throw", async () => {
  const client = await makeTestClient();
  await ingestUrl(client, "https://example.com/doc", {
    extract: fakeExtractOk(richContent("safety"), "Safety Doc"),
  });
  const hostile = [
    'quoted "phrase" here',
    "hyphen-ated -leading",
    "AND OR NOT NEAR",
    "paren (open",
    'weird "unbalanced',
    "star* colon: caret^",
  ];
  for (const q of hostile) {
    await searchItems(client, q, 5); // must not reject
  }
});

test("results are ranked and carry snippets", async () => {
  const client = await makeTestClient();
  const heavy = await ingestUrl(client, "https://example.com/heavy", {
    extract: fakeExtractOk(
      `# All about zebras\n\n${"zebras stripes zebras savanna zebras herd. ".repeat(30)}`,
      "All about zebras",
    ),
  });
  await ingestUrl(client, "https://example.com/light", {
    extract: fakeExtractOk(
      `# Mostly horses\n\n${"horses gallop fast. ".repeat(40)} one zebras mention`,
      "Mostly horses",
    ),
  });

  const hits = await searchItems(client, "zebras", 10);
  assert.equal(hits.length, 2);
  assert.equal(hits[0].id, heavy.id); // term-dense doc ranks first
  assert.match(hits[0].snippet, />>>zebras<<</);
  assert.ok(hits[0].score <= hits[1].score); // bm25: more negative = better
});

// --- hybrid ---------------------------------------------------------------

// Vectors are placed on one circle: unit vector at angle θ in the first two
// dimensions, zero elsewhere. Cosine similarity to the query at θ=0 is then just
// cos θ, so an item's rank is chosen by picking its angle — which is what makes
// a disagreement between FTS and semantic testable without the real provider.
function vectorAt(theta: number): number[] {
  const v = Array.from({ length: EMBEDDING_DIMS }, () => 0);
  v[0] = Math.cos(theta);
  v[1] = Math.sin(theta);
  return v;
}

const embedderAt = (theta: number): Embedder => async (texts) => ({
  vectors: texts.map(() => vectorAt(theta)),
  tokens: 0,
});

async function setItemVector(client: Client, itemId: number, theta: number) {
  await client.execute({
    sql: `UPDATE chunks SET embedding = vector32(?), embedding_model = ? WHERE item_id = ?`,
    args: [JSON.stringify(vectorAt(theta)), EMBEDDING_MODEL, itemId],
  });
}

// The finding that justified hybrid ranking: FTS whiffs on paraphrase queries
// where no surface word matches, and semantic trails on exact-term lookups. A
// fused ranking has to carry both, or it is worse than the method it replaced.
test("hybrid surfaces an item that keyword search cannot find at all", async () => {
  const client = await makeTestClient();
  const lexical = await ingestUrl(client, "https://example.com/lexical", {
    extract: fakeExtractOk(
      `# All about zebras\n\n${"zebras stripes zebras savanna zebras herd. ".repeat(30)}`,
      "All about zebras",
    ),
  });
  const paraphrase = await ingestUrl(client, "https://example.com/paraphrase", {
    extract: fakeExtractOk(
      `# Striped equine herds\n\n${"striped equine grazing plains migration. ".repeat(30)}`,
      "Striped equine herds",
    ),
  });
  // The paraphrase sits nearly on the query; the lexical match is a quarter turn
  // away, so semantic ranks them in exactly the opposite order to FTS.
  await setItemVector(client, paraphrase.id, 0.05);
  await setItemVector(client, lexical.id, Math.PI / 4);

  const keyword = await searchItems(client, "zebras", 10);
  assert.deepEqual(
    keyword.map((h) => h.id),
    [lexical.id],
    "the paraphrase shares no term with the query, so FTS cannot reach it",
  );

  const hybrid = await searchHybrid(client, "zebras", 10, { embed: embedderAt(0) });
  const found = hybrid.map((h) => h.id).sort((a, b) => a - b);
  assert.deepEqual(found, [lexical.id, paraphrase.id].sort((a, b) => a - b));

  // The lexical hit appears on both lists and so fuses ahead of the semantic-only
  // one, and it keeps the FTS snippet — the one that shows why it matched.
  assert.equal(hybrid[0].id, lexical.id);
  assert.match(hybrid[0].snippet, />>>zebras<<</);
  assert.ok(hybrid[0].score > hybrid[1].score, "RRF scores descend");
});

test("hybrid needs neither method to return anything for the other to work", async () => {
  const client = await makeTestClient();
  const item = await ingestUrl(client, "https://example.com/only", {
    extract: fakeExtractOk(richContent("quokka"), "Quokka notes"),
  });
  // No embeddings written: the semantic side finds nothing and the fused result
  // is the keyword ranking, rather than an error or an empty list.
  const hits = await searchHybrid(client, "quokka", 10, { embed: embedderAt(0) });
  assert.deepEqual(
    hits.map((h) => h.id),
    [item.id],
  );
});

// --- the judged-collection ceiling ----------------------------------------

// A `dingo`-dense document, so FTS order is chosen by the count rather than left
// to the fixture's word soup.
const dense = (marker: string, hits: number) =>
  `# ${marker}\n\n${`dingo tracks `.repeat(hits)}${`filler words here `.repeat(60)}`;

async function ingestDense(client: Client, slug: string, hits: number): Promise<number> {
  const r = await ingestUrl(client, `https://example.com/${slug}`, {
    extract: fakeExtractOk(dense(slug, hits), slug),
  });
  return r.id;
}

// The eval scores over the collection its gold was judged on. What makes that a
// SQL predicate and not a filter on the results: filtering afterwards returns
// fewer than `limit` hits, so Success@5 and recall read a short list — and it is
// shortest for the method best at surfacing the newest items, which flips the
// bias rather than removing it.
test("the ceiling excludes newer items without shortening the ranking", async () => {
  const client = await makeTestClient();
  const ids: number[] = [];
  // The four above the ceiling are the term-dense ones, so unpinned they own the
  // whole top 4 and there is something for the ceiling to remove.
  for (let i = 0; i < 8; i += 1) ids.push(await ingestDense(client, `dingo${i}`, i < 4 ? 1 : 40));
  const ceiling = ids[3];

  const open = await searchItems(client, "dingo", 4);
  assert.deepEqual(open.map((h) => h.id), ids.slice(4));

  const pinned = await searchItems(client, "dingo", 4, { maxItemId: ceiling });
  assert.equal(pinned.length, 4, "the predicate runs before LIMIT, so the list is still k long");
  assert.deepEqual([...pinned.map((h) => h.id)].sort((a, b) => a - b), ids.slice(0, 4));
});

// Same property one layer down: semantic over-fetches `limit * 4` chunks and
// collapses them to items, so the ceiling has to be spent on eligible chunks
// rather than eaten by excluded ones before the collapse.
test("the ceiling survives the semantic over-fetch", async () => {
  const client = await makeTestClient();
  const ids: number[] = [];
  for (let i = 0; i < 8; i += 1) {
    const r = await ingestUrl(client, `https://example.com/emu${i}`, {
      extract: fakeExtractOk(richContent(`emu${i}`), `Emu ${i}`),
    });
    ids.push(r.id);
  }
  const ceiling = ids[3];
  // The above-ceiling four sit nearly on the query and the eligible four a
  // radian away, so an unpinned search returns only ineligible items.
  for (const [i, id] of ids.entries()) await setItemVector(client, id, i < 4 ? 1 : 0.01);

  const open = await searchSemantic(client, "emu", 4, { embed: embedderAt(0) });
  assert.deepEqual([...open.map((h) => h.id)].sort((a, b) => a - b), ids.slice(4));

  const pinned = await searchSemantic(client, "emu", 4, {
    embed: embedderAt(0),
    maxItemId: ceiling,
  });
  assert.equal(pinned.length, 4);
  assert.deepEqual([...pinned.map((h) => h.id)].sort((a, b) => a - b), ids.slice(0, 4));
});

// The case that cannot be repaired downstream. RRF scores a position in each
// input list, so an ineligible item above an eligible one inflates that item's
// rank — by different amounts in the two lists — and the fused order changes.
// Here e3 is the best answer over the judged collection and only the second best
// if the ineligible items are allowed into the FTS list first.
test("hybrid drops above-ceiling items before fusing, which reorders the result", async () => {
  const client = await makeTestClient();
  const [e1, e2, e3] = [
    await ingestDense(client, "quoll-a", 40),
    await ingestDense(client, "quoll-b", 20),
    await ingestDense(client, "quoll-c", 1),
  ];
  const [n1, n2] = [await ingestDense(client, "quoll-d", 10), await ingestDense(client, "quoll-e", 5)];
  const ceiling = e3;

  // Only e3 and e2 carry vectors, so the semantic list is the same either way
  // and the whole difference comes from where the ineligible items sit in FTS.
  await setItemVector(client, e3, 0.01);
  await setItemVector(client, e2, 0.5);
  const semantic = await searchSemantic(client, "dingo", 50, { embed: embedderAt(0) });
  assert.deepEqual(semantic.map((h) => h.id), [e3, e2]);
  const open = await searchItems(client, "dingo", 50);
  assert.deepEqual(open.map((h) => h.id), [e1, e2, n1, n2, e3], "fixture: n1/n2 sit above e3");

  const fused = await searchHybrid(client, "dingo", 5, { embed: embedderAt(0), maxItemId: ceiling });
  assert.ok(fused.every((h) => h.id <= ceiling));

  const legs = await searchItems(client, "dingo", 50, { maxItemId: ceiling });
  const excludedFirst = rrfFuse([legs.map((h) => h.id), semantic.map((h) => h.id)]).map((f) => f.id);
  assert.deepEqual(fused.map((h) => h.id), excludedFirst.slice(0, 5));

  // A post-filter on the fused list is a different ranking, not a slower one.
  const filteredAfter = rrfFuse([open.map((h) => h.id), semantic.map((h) => h.id)])
    .map((f) => f.id)
    .filter((id) => id <= ceiling);
  assert.notDeepEqual(fused.map((h) => h.id), filteredAfter.slice(0, 5));
});

// --- annotations on hits --------------------------------------------------

// A snippet says why an item matched; it does not say what the item is. Without
// the summary and topics on the hit, deciding whether a result is worth reading
// costs a second call that returns the whole document.
test("hits carry the summary and topics a result is triaged on", async () => {
  const client = await makeTestClient();
  const annotated = await ingestUrl(client, "https://example.com/annotated", {
    extract: fakeExtractOk(richContent("wombat"), "Wombat notes"),
  });
  const bare = await ingestUrl(client, "https://example.com/bare", {
    extract: fakeExtractOk(richContent("wombat"), "More wombat"),
  });
  await setSummary(client, annotated.id, "What wombats do at night.");
  await attachTopics(client, annotated.id, ["zoology", "behaviour"]);

  const byId = new Map((await searchItems(client, "wombat", 10)).map((h) => [h.id, h]));
  assert.equal(byId.get(annotated.id)?.summary, "What wombats do at night.");
  assert.deepEqual(byId.get(annotated.id)?.topics, ["behaviour", "zoology"]);

  // An unorganized item reports absence rather than dropping the fields, so
  // every hit reads the same way whether or not `enrich` has reached it.
  assert.equal(byId.get(bare.id)?.summary, null);
  assert.deepEqual(byId.get(bare.id)?.topics, []);
});

// Topics arrive from SQL as one concatenated string. A comma separator would
// split this name down the middle and invent a topic that was never assigned.
test("a topic name containing the separator's obvious alternative stays one topic", async () => {
  const client = await makeTestClient();
  const item = await ingestUrl(client, "https://example.com/comma", {
    extract: fakeExtractOk(richContent("numbat"), "Numbat notes"),
  });
  await attachTopics(client, item.id, ["business, strategy"]);

  const [hit] = await searchItems(client, "numbat", 10);
  assert.deepEqual(hit.topics, ["business, strategy"]);
});

// The semantic ranker builds its rows from a different query than FTS, and the
// fused ranking copies whichever row won — so all three need checking, not one.
test("the semantic and fused rankings carry the same annotations as keyword", async () => {
  const client = await makeTestClient();
  const item = await ingestUrl(client, "https://example.com/bilby", {
    extract: fakeExtractOk(richContent("bilby"), "Bilby notes"),
  });
  await setSummary(client, item.id, "Desert marsupial, nocturnal.");
  await attachTopics(client, item.id, ["zoology"]);
  await setItemVector(client, item.id, 0);

  for (const hits of [
    await searchSemantic(client, "bilby", 10, { embed: embedderAt(0) }),
    await searchHybrid(client, "bilby", 10, { embed: embedderAt(0) }),
  ]) {
    assert.equal(hits[0].summary, "Desert marsupial, nocturnal.");
    assert.deepEqual(hits[0].topics, ["zoology"]);
  }
});
