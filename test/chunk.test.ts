import { test } from "node:test";
import assert from "node:assert/strict";
import type { Client } from "@libsql/client";
import { makeTestClient, mediumFooter } from "./helpers.js";
import { chunkMarkdown, CHUNKING_VERSION } from "../src/chunk.js";
import { rechunk } from "../src/commands/rechunk.js";

const MAX_CHARS = 2400;

function longestChunk(chunks: string[]): number {
  return chunks.reduce((max, c) => Math.max(max, c.length), 0);
}

test("prose splits into bounded passages", () => {
  const content = `# Heading\n\n${"word ".repeat(2000)}\n\n## Second\n\n${"other ".repeat(2000)}`;
  const chunks = chunkMarkdown(content);
  assert.ok(chunks.length > 1);
  assert.ok(longestChunk(chunks) <= MAX_CHARS);
});

// The bug this guards: splitOversized broke blocks on whitespace, so a run
// containing none stayed one piece. A 973KB data URI reached the corpus as a
// single chunk, larger than any embedding model's context window.
test("a block with no whitespace is still bounded", () => {
  const chunks = chunkMarkdown("x".repeat(50_000));
  assert.ok(chunks.length > 1);
  assert.ok(longestChunk(chunks) <= MAX_CHARS);
});

test("an inlined data uri is dropped rather than chunked", () => {
  const uri = `data:image/svg+xml;utf8,${"%3Ccircle%20".repeat(10_000)}`;
  const chunks = chunkMarkdown(`# Title\n\nReal prose here.\n\n![map](${uri})`);

  assert.ok(longestChunk(chunks) <= MAX_CHARS);
  assert.ok(chunks.some((c) => c.includes("Real prose here.")));
  assert.ok(!chunks.some((c) => c.includes("%3Ccircle")));
  // One page of prose should stay one page of prose, not 40 chunks of payload.
  assert.ok(chunks.length <= 2, `expected a compact result, got ${chunks.length}`);
});

// Item 458: Medium's footer landed in the final chunk, and its last line —
// Speechify's "Text to speech" ad, three words — became a chunk of its own and
// took semantic rank 2 for "clone a voice and generate speech from text". The
// strip runs here as well as in extraction because `item_content` is
// write-once: the 37 stored items carrying the footer are repaired by rechunk,
// not by refetching them.
test("Medium's footer never becomes a chunk of its own", () => {
  const body = `# Title\n\n${"word ".repeat(400).trim()}`;
  const chunks = chunkMarkdown(`${body}\n\n${mediumFooter("firecrawl")}`);

  assert.deepEqual(chunks, chunkMarkdown(body), "the article must chunk as if it arrived alone");
});

test("a short data uri is left alone", () => {
  const content = "# Title\n\n![tiny](data:image/png;base64,iVBORw0KGgo=)";
  const chunks = chunkMarkdown(content);
  assert.ok(chunks.some((c) => c.includes("iVBORw0KGgo=")));
});

// Item 463's shape: a bare heading arriving at a flush boundary, followed by a
// block too long to join it. v2 emitted the heading as its own chunk — "## MCP
// Tools", three words — and it ranked first for an MCP debugging query while
// the table it labels sat in a different chunk.
test("a heading ships with the block it introduces", () => {
  const chunks = chunkMarkdown(`${"word ".repeat(238)}\n\n## MCP Tools\n\n${"cell ".repeat(280)}`);
  assert.ok(!chunks.includes("## MCP Tools"), "the heading must not be a chunk on its own");
  const labelled = chunks.find((c) => c.includes("## MCP Tools"));
  assert.ok(labelled?.includes("cell"), "the heading must travel with the block it labels");
});

// The case that separates binding to the first piece from binding to the whole
// block: splitOversized would slice the joined text and strand the heading a
// second time, so the bind happens after the slice, not before it.
test("a heading survives an oversized block", () => {
  const chunks = chunkMarkdown(`## Heading\n\n${"a".repeat(3000)}`);
  assert.ok(chunks[0]?.startsWith("## Heading"));
  assert.ok(chunks[0]?.includes("aaaa"), "the heading must carry the first slice, not stand alone");
  assert.ok(longestChunk(chunks) <= MAX_CHARS);
});

test("a run of headings collapses onto one block", () => {
  const chunks = chunkMarkdown("intro\n\n## A\n\n### B\n\nbody");
  const labelled = chunks.find((c) => c.includes("body"));
  assert.ok(labelled?.includes("## A"));
  assert.ok(labelled?.includes("### B"));
});

// Nothing follows it to bind to, and a heading is never dropped: it is often
// the only place a document names its own subject.
test("a document ending on a heading keeps it", () => {
  const chunks = chunkMarkdown("body\n\n## Trailing");
  assert.ok(chunks.some((c) => c.includes("## Trailing")));
});

// The trailing case at a flush boundary, which the short input above never
// reaches: with no block beneath it, the heading joins the passage above rather
// than becoming the three-word chunk this whole rule exists to prevent.
test("a heading at a flush boundary is never left standing alone", () => {
  const chunks = chunkMarkdown(`${"word ".repeat(238)}\n\n## Trailing Heading`);
  assert.ok(!chunks.includes("## Trailing Heading"), "the heading must not be a chunk on its own");
  assert.ok(chunks.at(-1)?.includes("## Trailing Heading"));
  assert.ok(longestChunk(chunks) <= MAX_CHARS);
});

// Binding runs the pair through splitOversized, which packs words and drops the
// whitespace between them. Over MAX_CHARS that would reflow the block to keep
// the heading attached: a 2395-char table under a 9-char heading came back as
// one line, 83 newlines gone. Structure outranks the bind.
test("binding never reflows the block it binds to", () => {
  const table = "| a | b |\n".repeat(200).trimEnd();
  const chunks = chunkMarkdown(`## Config\n\n${table}`);
  const newlines = chunks.reduce((n, c) => n + c.split("\n").length - 1, 0);
  assert.equal(chunks.length, 1, "the pair fits under the ceiling and binds");
  assert.equal(newlines, table.split("\n").length - 1 + 2, "every line of the table survives");
  assert.ok(longestChunk(chunks) <= MAX_CHARS);
});

// The same input one char over the ceiling: the heading gives up the bind
// rather than the table giving up its lines.
test("past the ceiling the heading stands aside rather than flattening the block", () => {
  const table = "| a | b |\n".repeat(300).slice(0, 2399);
  const chunks = chunkMarkdown(`## Config\n\n${table}`);
  assert.ok(chunks.some((c) => c.includes("| a | b |\n| a | b |")), "the table keeps its lines");
  assert.ok(longestChunk(chunks) <= MAX_CHARS);
});

async function seedContent(client: Client, id: number, content: string): Promise<void> {
  await client.execute({
    sql: `INSERT INTO items (id, source_type, url, original_url, status, created_at, updated_at)
          VALUES (?, 'web', ?, ?, 'ok', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    args: [id, `https://example.com/${id}`, `https://example.com/${id}`],
  });
  await client.execute({
    sql: `INSERT INTO item_content (item_id, content, word_count, created_at)
          VALUES (?, ?, 1, '2026-01-01T00:00:00Z')`,
    args: [id, content],
  });
}

async function storedChunks(client: Client, id: number): Promise<string[]> {
  const rs = await client.execute({
    sql: "SELECT content FROM chunks WHERE item_id = ? ORDER BY seq",
    args: [id],
  });
  return rs.rows.map((r) => String(r.content));
}

test("rechunk dry run reports the plan without touching a row", async () => {
  const client = await makeTestClient();
  await seedContent(client, 1, "# Title\n\nSome prose.");
  await client.execute({
    sql: `INSERT INTO chunks (item_id, seq, content, word_count, chunking_version)
          VALUES (1, 0, 'stale', 1, 1)`,
  });

  const result = await rechunk(client, { apply: false });
  assert.equal(result.applied, false);
  assert.equal(result.changes.length, 1);
  assert.deepEqual(await storedChunks(client, 1), ["stale"]);
});

test("rechunk rewrites an oversized chunk and is idempotent", async () => {
  const client = await makeTestClient();
  await seedContent(client, 1, `# Title\n\nprose\n\n![m](data:image/svg+xml;utf8,${"%3C".repeat(9000)})`);
  // Simulate what the old chunker wrote: one unbounded chunk.
  await client.execute({
    sql: `INSERT INTO chunks (item_id, seq, content, word_count, chunking_version)
          VALUES (1, 0, ?, 1, 1)`,
    args: ["x".repeat(27_000)],
  });

  const first = await rechunk(client, { apply: true });
  assert.equal(first.changes.length, 1);
  const after = await storedChunks(client, 1);
  assert.ok(longestChunk(after) <= MAX_CHARS);

  const second = await rechunk(client, { apply: true });
  assert.equal(second.changes.length, 0, "second pass should be a no-op");
  assert.deepEqual(await storedChunks(client, 1), after);
});

// An item the new rules reproduce byte-for-byte still carries the old stamp,
// so `chunking_version` would understate how much of the corpus is current.
test("rechunk restamps chunks that are already the right shape", async () => {
  const client = await makeTestClient();
  const content = "# Title\n\nSome ordinary prose that chunks the same either way.";
  await seedContent(client, 1, content);
  for (const [seq, chunk] of chunkMarkdown(content).entries()) {
    await client.execute({
      sql: `INSERT INTO chunks (item_id, seq, content, word_count, chunking_version)
            VALUES (1, ?, ?, 1, 1)`,
      args: [seq, chunk],
    });
  }

  const dry = await rechunk(client, { apply: false });
  assert.equal(dry.changes.length, 0, "content should be unchanged");
  assert.equal(dry.restamped, 1);

  const before = await storedChunks(client, 1);
  const applied = await rechunk(client, { apply: true });
  assert.equal(applied.restamped, 1);
  assert.deepEqual(await storedChunks(client, 1), before, "text must not move");

  const again = await rechunk(client, { apply: true });
  assert.equal(again.restamped, 0, "restamping is not repeated");
});

test("rechunk stamps the current chunking version", async () => {
  const client = await makeTestClient();
  await seedContent(client, 1, "# Title\n\nSome prose.");
  await client.execute({
    sql: `INSERT INTO chunks (item_id, seq, content, word_count, chunking_version)
          VALUES (1, 0, 'stale', 1, 1)`,
  });

  await rechunk(client, { apply: true });
  const rs = await client.execute("SELECT DISTINCT chunking_version FROM chunks");
  assert.deepEqual(
    rs.rows.map((r) => Number(r.chunking_version)),
    [CHUNKING_VERSION],
  );
});
