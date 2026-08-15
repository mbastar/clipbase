import { test } from "node:test";
import assert from "node:assert/strict";
import type { Client } from "@libsql/client";
import { makeTestClient, countRows } from "./helpers.js";
import { recanonicalize } from "../src/commands/recanonicalize.js";

interface SeedItem {
  id: number;
  url: string;
  originalUrl?: string;
  raindropId?: number;
  words?: number;
}

async function seed(client: Client, items: SeedItem[]): Promise<void> {
  for (const item of items) {
    await client.execute({
      sql: `INSERT INTO items (id, source_type, url, original_url, status, raindrop_id,
                               created_at, updated_at)
            VALUES (?, 'web', ?, ?, 'ok', ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
      args: [item.id, item.url, item.originalUrl ?? item.url, item.raindropId ?? null],
    });
    if (item.words) {
      await client.execute({
        sql: `INSERT INTO item_content (item_id, content, word_count, created_at)
              VALUES (?, 'body', ?, '2026-01-01T00:00:00Z')`,
        args: [item.id, item.words],
      });
    }
  }
}

async function urlOf(client: Client, id: number): Promise<string | null> {
  const rs = await client.execute({ sql: "SELECT url FROM items WHERE id = ?", args: [id] });
  return rs.rows[0] ? String(rs.rows[0].url) : null;
}

test("dry run reports the plan without touching a row", async () => {
  const client = await makeTestClient();
  await seed(client, [{ id: 1, url: "https://www.example.com/a", words: 10 }]);

  const result = await recanonicalize(client, { apply: false });
  assert.equal(result.applied, false);
  assert.equal(result.rewrites.length, 1);
  assert.equal(await urlOf(client, 1), "https://www.example.com/a");
});

test("rewrites stale canonicals and is idempotent", async () => {
  const client = await makeTestClient();
  await seed(client, [
    { id: 1, url: "https://www.example.com/a", words: 10 },
    { id: 2, url: "https://m.youtube.com/watch?v=abc&pp=noise", words: 10 },
    { id: 3, url: "https://github.com/o/r/tree/main", words: 10 },
  ]);

  const first = await recanonicalize(client, { apply: true });
  assert.equal(first.rewrites.length, 3);
  assert.equal(await urlOf(client, 1), "https://example.com/a");
  assert.equal(await urlOf(client, 2), "https://youtube.com/watch?v=abc");
  assert.equal(await urlOf(client, 3), "https://github.com/o/r");

  const second = await recanonicalize(client, { apply: true });
  assert.equal(second.rewrites.length, 0);
  assert.equal(second.merges.length, 0);
});

test("duplicates collapse onto the content-bearing survivor", async () => {
  const client = await makeTestClient();
  await seed(client, [
    { id: 1, url: "https://m.youtube.com/watch?v=abc&pp=noise" }, // no content
    { id: 2, url: "https://www.youtube.com/watch?app=desktop&v=abc", words: 500 },
  ]);

  const result = await recanonicalize(client, { apply: true });
  assert.equal(result.merges.length, 1);
  assert.deepEqual(result.merges[0], {
    canonical: "https://youtube.com/watch?v=abc",
    keep: 2,
    drop: [1],
    transferred_raindrop_id: null,
  });
  assert.equal(await countRows(client, "items"), 1);
  assert.equal(await urlOf(client, 2), "https://youtube.com/watch?v=abc");
});

test("raindrop provenance moves to a survivor that lacks it", async () => {
  const client = await makeTestClient();
  await seed(client, [
    { id: 1, url: "https://www.example.com/a", words: 500 }, // survivor, no raindrop_id
    { id: 2, url: "https://example.com/a/", raindropId: 777 },
  ]);

  const result = await recanonicalize(client, { apply: true });
  assert.equal(result.merges[0].keep, 1);
  assert.equal(result.merges[0].transferred_raindrop_id, "777");
  const rs = await client.execute("SELECT raindrop_id FROM items WHERE id = 1");
  assert.equal(Number(rs.rows[0].raindrop_id), 777);
});

test("a row taking another row's current url does not collide", async () => {
  const client = await makeTestClient();
  // #1 must become https://example.com/a, which #2 currently occupies; #2 in
  // turn moves elsewhere. A single-phase rewrite would trip UNIQUE(url).
  await seed(client, [
    { id: 1, url: "https://www.example.com/a", words: 10 },
    { id: 2, url: "https://example.com/a", originalUrl: "https://www.example.com/b", words: 10 },
  ]);

  const result = await recanonicalize(client, { apply: true });
  assert.equal(result.merges.length, 0);
  assert.equal(await urlOf(client, 1), "https://example.com/a");
  assert.equal(await urlOf(client, 2), "https://example.com/b");
});

test("unparseable urls are skipped, not dropped", async () => {
  const client = await makeTestClient();
  await client.execute(
    `INSERT INTO items (id, source_type, url, original_url, status, created_at, updated_at)
     VALUES (9, 'pdf', 'file:///tmp/paper.pdf', '/tmp/paper.pdf', 'ok',
             '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
  );

  const result = await recanonicalize(client, { apply: true });
  assert.equal(result.rewrites.length, 0);
  assert.equal(await urlOf(client, 9), "file:///tmp/paper.pdf");
});
