import { test } from "node:test";
import assert from "node:assert/strict";
import type { Client } from "@libsql/client";
import { makeTestClient } from "./helpers.js";
import {
  getCorpusAge,
  getStatus,
  formatStaleBanner,
  formatStatus,
  STALE_AFTER_DAYS,
} from "../src/commands/status.js";

const NOW = new Date("2026-08-03T12:00:00Z");

function daysBefore(days: number): string {
  return new Date(NOW.getTime() - days * 86_400_000).toISOString();
}

async function seedItem(client: Client, id: number, status = "ok"): Promise<void> {
  await client.execute({
    sql: `INSERT INTO items (id, source_type, url, domain, status, created_at, updated_at)
          VALUES (?, 'raindrop', ?, 'example.com', ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    args: [id, `https://example.com/${id}`, status],
  });
}

async function seedCollection(client: Client, id: number, title: string, syncedAt: string | null) {
  await client.execute({
    sql: `INSERT INTO sync_state (collection_id, collection_title, last_synced_at)
          VALUES (?, ?, ?)`,
    args: [id, title, syncedAt],
  });
}

test("corpus age is measured from the most recent sync, not the stalest", async () => {
  const client = await makeTestClient();
  await seedCollection(client, 1, "Videos", daysBefore(30));
  await seedCollection(client, 2, "Learning", daysBefore(2));

  const age = await getCorpusAge(client, NOW);
  assert.equal(age.ageDays, 2);
  assert.equal(age.isStale, false);
});

test("staleness threshold is inclusive and drives the banner", async () => {
  const client = await makeTestClient();
  await seedCollection(client, 1, "Videos", daysBefore(STALE_AFTER_DAYS));

  const age = await getCorpusAge(client, NOW);
  assert.equal(age.isStale, true);
  const banner = formatStaleBanner(age);
  assert.ok(banner?.includes(`${STALE_AFTER_DAYS} days stale`));
  assert.ok(banner?.includes("clipbase-sync"));
  // The inference the banner exists to block.
  assert.ok(banner?.includes("not evidence of absence"));
});

test("a fresh corpus produces no banner at all", async () => {
  const client = await makeTestClient();
  await seedCollection(client, 1, "Videos", daysBefore(STALE_AFTER_DAYS - 1));
  assert.equal(formatStaleBanner(await getCorpusAge(client, NOW)), null);
});

test("a never-synced corpus is not reported as stale", async () => {
  // Manual-ingest-only corpora have no sync_state rows. Nothing to be behind,
  // so warning would be noise on every search.
  const client = await makeTestClient();
  const age = await getCorpusAge(client, NOW);
  assert.deepEqual(age, { lastSyncedAt: null, ageDays: null, isStale: false });
  assert.equal(formatStaleBanner(age), null);
});

test("status counts items, pending embeds and missing topics", async () => {
  const client = await makeTestClient();
  await seedItem(client, 1);
  await seedItem(client, 2);
  await seedItem(client, 3, "extraction_failed");
  await client.execute(
    `INSERT INTO item_content (item_id, content, word_count, created_at)
     VALUES (1, 'alpha', 1, '2026-01-01T00:00:00Z')`,
  );
  // Two chunks, one embedded.
  await client.execute(
    `INSERT INTO chunks (id, item_id, seq, content, word_count, embedding, embedding_model)
     VALUES (1, 1, 0, 'alpha', 1, vector32('[${Array(768).fill(0).join(",")}]'), 'gemini')`,
  );
  await client.execute(
    `INSERT INTO chunks (id, item_id, seq, content, word_count) VALUES (2, 1, 1, 'beta', 1)`,
  );
  await client.execute(
    `INSERT INTO item_annotations (item_id, summary, updated_at)
     VALUES (1, 'a one-line summary', '2026-01-01T00:00:00Z')`,
  );
  await client.execute(`INSERT INTO topics (id, name, created_at) VALUES (1, 'mcp', '2026-01-01')`);
  await client.execute(`INSERT INTO item_topics (item_id, topic_id) VALUES (1, 1)`);
  await seedCollection(client, 1, "Videos", daysBefore(1));

  const s = await getStatus(client, NOW);
  assert.equal(s.items.total, 3);
  assert.equal(s.items.ok, 2);
  assert.equal(s.items.extractionFailed, 1);
  assert.equal(s.items.withContent, 1);
  assert.equal(s.chunks.total, 2);
  assert.equal(s.chunks.embedded, 1);
  assert.equal(s.chunks.pendingEmbed, 1);
  assert.equal(s.annotations.withSummary, 1);
  assert.equal(s.annotations.withTopics, 1);
  assert.equal(s.annotations.missingTopics, 2);
  assert.equal(s.sync.collectionsTracked, 1);
});

test("an empty corpus reports zeros rather than throwing", async () => {
  const client = await makeTestClient();
  const s = await getStatus(client, NOW);
  assert.equal(s.items.total, 0);
  assert.equal(s.chunks.pendingEmbed, 0);
  assert.equal(s.annotations.missingTopics, 0);
  assert.equal(s.newestItemAt, null);
  assert.ok(formatStatus(s).includes("never"));
});

test("an unreachable collection surfaces as stalest without moving the headline", async () => {
  const client = await makeTestClient();
  await seedCollection(client, 1, "Stuck", daysBefore(40));
  await seedCollection(client, 2, "Fine", daysBefore(1));

  const s = await getStatus(client, NOW);
  assert.equal(s.sync.age.ageDays, 1);
  assert.equal(s.sync.stalest?.title, "Stuck");
  assert.equal(s.sync.stalest?.ageDays, 40);
  assert.ok(formatStatus(s).includes("stalest"));
});
