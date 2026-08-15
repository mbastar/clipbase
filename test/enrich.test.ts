import { test } from "node:test";
import assert from "node:assert/strict";
import type { Client } from "@libsql/client";
import { makeTestClient } from "./helpers.js";
import { TOPICS, loadCandidates } from "../src/commands/enrich.js";
import { attachTopics, setSummary } from "../src/organize.js";

async function seedWithContent(client: Client, id: number): Promise<void> {
  await client.execute({
    sql: `INSERT INTO items (id, source_type, url, domain, status, created_at, updated_at)
          VALUES (?, 'web', ?, 'example.com', 'ok', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    args: [id, `https://example.com/${id}`],
  });
  await client.execute({
    sql: `INSERT INTO item_content (item_id, content, word_count, created_at)
          VALUES (?, 'body text', 2, '2026-01-01T00:00:00Z')`,
    args: [id],
  });
}

async function candidateIds(client: Client, all = false): Promise<number[]> {
  const rows = await loadCandidates(client, { all, limit: 100 });
  return rows.map((r) => r.id);
}

// The model call itself is not unit-tested — it needs the claude CLI and costs
// quota. What is tested here is the contract around it: the taxonomy is
// well-formed, and every slug the prompt advertises is one the writer accepts.

test("every topic slug is url-safe and uniquely described", () => {
  const slugs = Object.keys(TOPICS);
  assert.ok(slugs.length >= 10, "taxonomy should be substantive");
  for (const slug of slugs) {
    assert.match(slug, /^[a-z][a-z0-9-]*$/, `${slug} is not a clean slug`);
    assert.ok(TOPICS[slug].length > 10, `${slug} needs a real description`);
  }
  const descriptions = Object.values(TOPICS);
  assert.equal(new Set(descriptions).size, descriptions.length, "descriptions must be distinct");
});

test("an item the model declined is not re-sent on the next run", async () => {
  // The whole point of the annotation gate: a declined item has a summary but
  // no topics, and must still count as processed — otherwise every run pays to
  // re-ask a question already answered.
  const client = await makeTestClient();
  await seedWithContent(client, 1); // will be declined (summary, no topics)
  await seedWithContent(client, 2); // will be classified normally
  await seedWithContent(client, 3); // never processed

  assert.deepEqual(await candidateIds(client), [1, 2, 3]);

  await setSummary(client, 1, "Fits none of the topics.");
  await setSummary(client, 2, "An agent framework.");
  await attachTopics(client, 2, ["agent-frameworks"]);

  assert.deepEqual(await candidateIds(client), [3], "declined item must not come back");
  assert.deepEqual(await candidateIds(client, true), [1, 2, 3], "--all still re-runs everything");
});

test("--ids reaches items the annotation gate would skip, which is how a truncated batch is repaired", async () => {
  const client = await makeTestClient();
  await seedWithContent(client, 1);
  await seedWithContent(client, 2);
  await seedWithContent(client, 3);
  await setSummary(client, 1, "Already processed.");
  await setSummary(client, 2, "Already processed.");

  assert.deepEqual(await candidateIds(client), [3], "the gate still hides processed items");

  const named = await loadCandidates(client, { all: false, limit: 100, ids: [1, 2] });
  assert.deepEqual(
    named.map((r) => r.id),
    [1, 2],
  );
});

test("--ids still cannot conjure an item that has no content", async () => {
  const client = await makeTestClient();
  await seedWithContent(client, 1);
  await client.execute(
    `INSERT INTO items (id, source_type, url, status, created_at, updated_at)
     VALUES (8, 'web', 'https://example.com/wall', 'extraction_failed',
             '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
  );

  const named = await loadCandidates(client, { all: true, limit: 100, ids: [1, 8, 99] });
  assert.deepEqual(
    named.map((r) => r.id),
    [1],
  );
});

test("items without content are never candidates", async () => {
  // extraction_failed rows have no item_content and nothing to classify.
  const client = await makeTestClient();
  await client.execute(
    `INSERT INTO items (id, source_type, url, status, created_at, updated_at)
     VALUES (7, 'web', 'https://example.com/dead', 'extraction_failed',
             '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
  );
  assert.deepEqual(await candidateIds(client), []);
});

test("slugs survive name normalization unchanged", async () => {
  // organize.ts lowercases and collapses whitespace; a slug that changes shape
  // would be written under a different name than the prompt advertises.
  const { upsertTopic, listTopics } = await import("../src/organize.js");
  const client = await makeTestClient();

  for (const [slug, description] of Object.entries(TOPICS)) {
    await upsertTopic(client, slug, description);
  }
  const stored = (await listTopics(client)).map((t) => t.name).sort();
  assert.deepEqual(stored, Object.keys(TOPICS).sort());
});
