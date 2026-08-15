import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { syncRaindrop, syncAll } from "../src/raindrop.js";
import { ingestUrl, type IngestOptions } from "../src/ingest.js";
import type { Client } from "../src/db.js";
import { makeTestClient, fakeExtractOk, richContent, countRows } from "./helpers.js";

interface FakeBookmark {
  _id: number;
  link: string;
  title: string;
  created: string;
  lastUpdate: string;
}

function makeBookmarks(n: number, startId = 1): FakeBookmark[] {
  return Array.from({ length: n }, (_, i) => {
    const id = startId + i;
    return {
      _id: id,
      link: `https://example.com/bookmark-${id}`,
      title: `Bookmark ${id}`,
      created: new Date(Date.UTC(2026, 0, 1, 0, id)).toISOString(),
      lastUpdate: new Date(Date.UTC(2026, 0, 1, 0, id)).toISOString(),
    };
  });
}

function stubRaindropApi(t: TestContext, bookmarks: FakeBookmark[]): { calls: string[] } {
  const calls: string[] = [];
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const match = url.match(/\/raindrops\/\d+\?sort=-created&perpage=(\d+)&page=(\d+)/);
    if (!match) return new Response("not found", { status: 404 });
    const perpage = Number(match[1]);
    const page = Number(match[2]);
    const sorted = [...bookmarks].sort((a, b) => b.created.localeCompare(a.created));
    const items = sorted.slice(page * perpage, (page + 1) * perpage);
    return new Response(JSON.stringify({ items }), { status: 200 });
  }) as typeof fetch;
  return { calls };
}

const fakeIngest = (client: Client, url: string, opts?: IngestOptions) =>
  ingestUrl(client, url, { ...opts, extract: fakeExtractOk(richContent("raindrop")) });

test("first sync pulls all pages; re-run is a no-op via cursor", async (t) => {
  const client = await makeTestClient();
  const bookmarks = makeBookmarks(60); // forces two pages at perpage=50
  const { calls } = stubRaindropApi(t, bookmarks);

  const first = await syncRaindrop(client, "tok", "123", { ingest: fakeIngest });
  assert.equal(first.scanned, 60);
  assert.equal(first.created, 60);
  assert.equal(await countRows(client, "items"), 60);
  assert.ok(calls.length >= 2);

  const callsBefore = calls.length;
  const second = await syncRaindrop(client, "tok", "123", { ingest: fakeIngest });
  assert.equal(second.scanned, 0);
  assert.equal(second.created, 0);
  assert.equal(await countRows(client, "items"), 60);
  // cursor stops paging on the first page
  assert.equal(calls.length, callsBefore + 1);
});

test("only bookmarks newer than the cursor are ingested", async (t) => {
  const client = await makeTestClient();
  const bookmarks = makeBookmarks(5);
  stubRaindropApi(t, bookmarks);
  await syncRaindrop(client, "tok", "123", { ingest: fakeIngest });

  const withNew = [...bookmarks, ...makeBookmarks(2, 100)];
  stubRaindropApi(t, withNew);
  const result = await syncRaindrop(client, "tok", "123", { ingest: fakeIngest });
  assert.equal(result.scanned, 2);
  assert.equal(result.created, 2);
  assert.equal(await countRows(client, "items"), 7);
});

test("lost cursor cannot cause duplicates (unique url + raindrop_id)", async (t) => {
  const client = await makeTestClient();
  const bookmarks = makeBookmarks(5);
  stubRaindropApi(t, bookmarks);
  await syncRaindrop(client, "tok", "123", { ingest: fakeIngest });

  await client.execute("DELETE FROM sync_state");
  const rerun = await syncRaindrop(client, "tok", "123", { ingest: fakeIngest });
  assert.equal(rerun.scanned, 5);
  assert.equal(rerun.created, 0);
  assert.equal(rerun.refreshed, 5);
  assert.equal(await countRows(client, "items"), 5);
});

// Serves a different bookmark set per collection, and can make named
// collections unreachable so failure isolation is testable.
function stubCollections(
  t: TestContext,
  byCollection: Record<number, FakeBookmark[]>,
  unreachable: number[] = [],
): { fetched: number[] } {
  const fetched: number[] = [];
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const match = url.match(/\/raindrops\/(\d+)\?sort=-created&perpage=(\d+)&page=(\d+)/);
    if (!match) return new Response("not found", { status: 404 });
    const id = Number(match[1]);
    if (unreachable.includes(id)) return new Response("boom", { status: 503 });
    if (!fetched.includes(id)) fetched.push(id);
    const perpage = Number(match[2]);
    const page = Number(match[3]);
    const sorted = [...(byCollection[id] ?? [])].sort((a, b) => b.created.localeCompare(a.created));
    return new Response(JSON.stringify({ items: sorted.slice(page * perpage, (page + 1) * perpage) }), {
      status: 200,
    });
  }) as typeof fetch;
  return { fetched };
}

async function track(client: Client, id: number, title: string): Promise<void> {
  await client.execute({
    sql: `INSERT INTO sync_state (collection_id, collection_title, last_created_cursor, last_synced_at)
          VALUES (?, ?, NULL, '2026-07-18T00:00:00.000Z')`,
    args: [id, title],
  });
}

test("syncing by id keeps the name the collection was first synced under", async (t) => {
  // sync-all passes ids, so getting this wrong would have renamed all thirteen
  // collections to their own ids on its first run.
  const client = await makeTestClient();
  await track(client, 123, "Learning");
  stubCollections(t, { 123: makeBookmarks(1) });

  const result = await syncRaindrop(client, "tok", "123", { ingest: fakeIngest });
  assert.equal(result.collectionTitle, "Learning");
  const row = (await client.execute("SELECT collection_title FROM sync_state")).rows[0];
  assert.equal(row.collection_title, "Learning");
});

test("an unknown numeric collection still gets a usable title", async (t) => {
  const client = await makeTestClient();
  stubCollections(t, { 456: makeBookmarks(1) });
  const result = await syncRaindrop(client, "tok", "456", { ingest: fakeIngest });
  assert.equal(result.collectionTitle, "456");
});

test("sync-all covers every tracked collection, and only those", async (t) => {
  const client = await makeTestClient();
  await track(client, 10, "Learning");
  await track(client, 20, "Videos");
  // Present in Raindrop but never tracked: sync-all must not widen the corpus.
  const { fetched } = stubCollections(t, {
    10: makeBookmarks(2, 1),
    20: makeBookmarks(3, 100),
    30: makeBookmarks(9, 200),
  });

  const result = await syncAll(client, "tok", { ingest: fakeIngest });
  assert.deepEqual(fetched.sort(), [10, 20]);
  assert.equal(result.synced.length, 2);
  assert.equal(result.failed.length, 0);
  assert.equal(result.totals.created, 5);
  assert.equal(await countRows(client, "items"), 5);
});

test("one unreachable collection does not cost the others their sync", async (t) => {
  const client = await makeTestClient();
  await track(client, 10, "Learning");
  await track(client, 20, "Videos");
  await track(client, 30, "Tools");
  stubCollections(t, { 10: makeBookmarks(2, 1), 20: makeBookmarks(2, 100), 30: makeBookmarks(2, 200) }, [20]);

  const result = await syncAll(client, "tok", { ingest: fakeIngest });
  assert.equal(result.synced.length, 2);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].collectionId, 20);
  assert.equal(result.failed[0].collectionTitle, "Videos");
  assert.match(result.failed[0].error, /503/);
  assert.equal(result.totals.created, 4);

  // The collections that ran are durably done: their cursors advanced, so a
  // re-run resumes only what failed rather than redoing everything.
  const cursors = (
    await client.execute(
      "SELECT collection_id FROM sync_state WHERE last_created_cursor IS NOT NULL ORDER BY collection_id",
    )
  ).rows.map((r) => Number(r.collection_id));
  assert.deepEqual(cursors, [10, 30]);
});

test("sync-all is ordered by name, so its output is stable run to run", async (t) => {
  const client = await makeTestClient();
  await track(client, 10, "videos");
  await track(client, 20, "Agentic: Frameworks");
  await track(client, 30, "Learning");
  stubCollections(t, { 10: [], 20: [], 30: [] });

  const result = await syncAll(client, "tok", { ingest: fakeIngest });
  assert.deepEqual(
    result.synced.map((r) => r.collectionTitle),
    ["Agentic: Frameworks", "Learning", "videos"],
  );
});

test("sync-all on a fresh database says so rather than reporting success", async () => {
  const client = await makeTestClient();
  await assert.rejects(
    () => syncAll(client, "tok", { ingest: fakeIngest }),
    /no collections tracked yet/,
  );
});

test("a bookmark URL already ingested as web is refreshed and gains raindrop provenance", async (t) => {
  const client = await makeTestClient();
  const web = await ingestUrl(client, "https://example.com/bookmark-1", {
    extract: fakeExtractOk(richContent("shared")),
  });
  stubRaindropApi(t, makeBookmarks(1));
  const result = await syncRaindrop(client, "tok", "123", { ingest: fakeIngest });
  assert.equal(result.refreshed, 1);
  assert.equal(await countRows(client, "items"), 1);
  const row = (await client.execute("SELECT source_type, raindrop_id FROM items")).rows[0];
  assert.equal(row.source_type, "web"); // original origin preserved
  assert.equal(Number(row.raindrop_id), 1);
  assert.equal(Number((await client.execute("SELECT id FROM items")).rows[0].id), web.id);
});
