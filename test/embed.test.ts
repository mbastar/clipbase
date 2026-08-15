import { test } from "node:test";
import assert from "node:assert/strict";
import type { Client } from "@libsql/client";
import { makeTestClient } from "./helpers.js";
import {
  fitDimensions,
  embed as realEmbed,
  EMBEDDING_DIMS,
  EMBEDDING_MODEL,
  type Embedder,
} from "../src/embed.js";
import { embedChunks } from "../src/commands/embed.js";
import { searchSemantic } from "../src/commands/search.js";

// Deterministic stand-in for the provider: a unit vector whose direction is
// driven by the text, so semantically identical strings land in the same place
// and different ones do not. Keeps every test off the network.
function fakeEmbedder(): Embedder & { calls: { texts: string[]; kind: string }[] } {
  const calls: { texts: string[]; kind: string }[] = [];
  const fn = (async (texts: string[], kind: "document" | "query") => {
    calls.push({ texts, kind });
    return {
      vectors: texts.map((t) => {
        const seed = [...t.replace(/^Represent this search query[^:]*: /, "")].reduce(
          (a, c) => a + c.charCodeAt(0),
          0,
        );
        const raw = Array.from({ length: EMBEDDING_DIMS }, (_, i) =>
          Math.sin(seed * (i + 1) * 0.0001),
        );
        const norm = Math.hypot(...raw);
        return raw.map((v) => v / norm);
      }),
      tokens: texts.length * 10,
    };
  }) as Embedder & { calls: typeof calls };
  fn.calls = calls;
  return fn;
}

async function seedChunk(client: Client, itemId: number, chunkId: number, content: string) {
  await client.execute({
    sql: `INSERT OR IGNORE INTO items (id, source_type, url, original_url, status, created_at, updated_at)
          VALUES (?, 'web', ?, ?, 'ok', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    args: [itemId, `https://example.com/${itemId}`, `https://example.com/${itemId}`],
  });
  await client.execute({
    sql: `INSERT INTO chunks (id, item_id, seq, content, word_count, chunking_version)
          VALUES (?, ?, 0, ?, 1, 2)`,
    args: [chunkId, itemId, content],
  });
}

test("fitDimensions truncates a longer vector back to unit length", () => {
  const long = Array.from({ length: 3072 }, (_, i) => (i % 7) + 1);
  const fitted = fitDimensions(long);
  assert.equal(fitted.length, EMBEDDING_DIMS);
  assert.ok(Math.abs(Math.hypot(...fitted) - 1) < 1e-9, "must be re-normalized to unit length");
});

test("fitDimensions passes an already-correct vector through untouched", () => {
  const exact = Array.from({ length: EMBEDDING_DIMS }, () => 0.5);
  assert.deepEqual(fitDimensions(exact), exact);
});

test("fitDimensions rejects a vector that is too short to truncate", () => {
  assert.throws(() => fitDimensions([1, 2, 3]), /expected at least/);
});

// A real backfill died here: fetch throws on a connection-level blip instead of
// returning a response, so it bypassed the status-based retry and discarded the
// whole run on its first batch.
test("a thrown network error is retried rather than ending the run", async () => {
  const realFetch = globalThis.fetch;
  process.env.OPENROUTER_API_KEY ??= "test-key";
  let attempts = 0;
  globalThis.fetch = (async () => {
    attempts++;
    if (attempts === 1) throw new TypeError("fetch failed");
    return new Response(
      JSON.stringify({
        data: [{ index: 0, embedding: Array.from({ length: EMBEDDING_DIMS }, () => 0.5) }],
        usage: { prompt_tokens: 7 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    const result = await realEmbed(["hello"], "document");
    assert.equal(attempts, 2, "should have retried once");
    assert.equal(result.vectors[0].length, EMBEDDING_DIMS);
    assert.equal(result.tokens, 7);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("rows are matched by index, not by position in the response", async () => {
  const realFetch = globalThis.fetch;
  process.env.OPENROUTER_API_KEY ??= "test-key";
  const vec = (fill: number) => Array.from({ length: EMBEDDING_DIMS }, () => fill);
  globalThis.fetch = (async () =>
    new Response(
      // Deliberately out of order: index 1 arrives first.
      JSON.stringify({
        data: [
          { index: 1, embedding: vec(0.2) },
          { index: 0, embedding: vec(0.1) },
        ],
        usage: { prompt_tokens: 4 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;

  try {
    const result = await realEmbed(["first", "second"], "document");
    assert.equal(result.vectors[0][0], 0.1, "index 0 must map to the first input");
    assert.equal(result.vectors[1][0], 0.2);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("embed dry run reports pending work without calling the provider", async () => {
  const client = await makeTestClient();
  await seedChunk(client, 1, 1, "alpha");
  const embed = fakeEmbedder();

  const result = await embedChunks(client, { apply: false, embed });
  assert.equal(result.pending, 1);
  assert.equal(result.embedded, 0);
  assert.equal(embed.calls.length, 0, "a dry run must not spend credits");
});

test("embed writes vectors and does not re-embed on a second pass", async () => {
  const client = await makeTestClient();
  await seedChunk(client, 1, 1, "vector databases");
  await seedChunk(client, 2, 2, "agent frameworks");
  const embed = fakeEmbedder();

  const first = await embedChunks(client, { apply: true, embed });
  assert.equal(first.embedded, 2);
  assert.equal(first.tokens, 20);
  assert.equal(embed.calls[0].kind, "document", "stored passages embed as documents");

  const second = await embedChunks(client, { apply: true, embed });
  assert.equal(second.pending, 0, "already-embedded chunks are not re-sent");
  assert.equal(second.embedded, 0);
});

test("a chunk embedded by another model is re-embedded", async () => {
  const client = await makeTestClient();
  await seedChunk(client, 1, 1, "alpha");
  await embedChunks(client, { apply: true, embed: fakeEmbedder() });
  await client.execute("UPDATE chunks SET embedding_model = 'some/older-model' WHERE id = 1");

  const result = await embedChunks(client, { apply: true, embed: fakeEmbedder() });
  assert.equal(result.pending, 1);
  assert.equal(result.embedded, 1);
});

test("semantic search returns the nearest item and embeds the query as a query", async () => {
  const client = await makeTestClient();
  await seedChunk(client, 1, 1, "vector databases and similarity indexes");
  await seedChunk(client, 2, 2, "sourdough bread proofing schedules");
  const embed = fakeEmbedder();
  await embedChunks(client, { apply: true, embed });

  const hits = await searchSemantic(client, "vector databases and similarity indexes", 5, {
    embed,
  });
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].id, 1, "the identical passage should rank first");
  assert.equal(embed.calls.at(-1)?.kind, "query", "queries embed with the query instruction");
  assert.ok(hits[0].snippet.includes("vector databases"));
});

test("semantic search collapses several chunks of one item to a single hit", async () => {
  const client = await makeTestClient();
  await seedChunk(client, 1, 1, "alpha passage about retrieval");
  await client.execute({
    sql: `INSERT INTO chunks (id, item_id, seq, content, word_count, chunking_version)
          VALUES (2, 1, 1, 'beta passage about retrieval', 1, 2)`,
  });
  const embed = fakeEmbedder();
  await embedChunks(client, { apply: true, embed });

  const hits = await searchSemantic(client, "alpha passage about retrieval", 5, { embed });
  assert.equal(hits.filter((h) => h.id === 1).length, 1, "one item, one hit");
});

test("semantic search ignores vectors from a stale model", async () => {
  const client = await makeTestClient();
  await seedChunk(client, 1, 1, "alpha");
  const embed = fakeEmbedder();
  await embedChunks(client, { apply: true, embed });
  await client.execute("UPDATE chunks SET embedding_model = 'some/older-model'");

  const hits = await searchSemantic(client, "alpha", 5, { embed });
  assert.equal(hits.length, 0, "a vector from another model is not comparable");
});

test("semantic search rejects an empty query", async () => {
  const client = await makeTestClient();
  await assert.rejects(
    () => searchSemantic(client, "   ", 5, { embed: fakeEmbedder() }),
    /empty search query/,
  );
});

test("the embedding model identity is recorded on every written vector", async () => {
  const client = await makeTestClient();
  await seedChunk(client, 1, 1, "alpha");
  await embedChunks(client, { apply: true, embed: fakeEmbedder() });

  const rs = await client.execute("SELECT DISTINCT embedding_model FROM chunks");
  assert.deepEqual(
    rs.rows.map((r) => String(r.embedding_model)),
    [EMBEDDING_MODEL],
  );
});
