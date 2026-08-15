import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { reconcile, formatReconcile } from "../src/commands/reconcile.js";
import { ingestUrl } from "../src/ingest.js";
import type { Client } from "../src/db.js";
import { makeTestClient, fakeExtractOk, richContent } from "./helpers.js";

interface FakeBookmark {
  _id: number;
  link: string;
  title: string;
  created: string;
  lastUpdate: string;
}

function bookmark(id: number, link: string, created: string): FakeBookmark {
  return { _id: id, link, title: `Bookmark ${id}`, created, lastUpdate: created };
}

/** One tracked collection, its cursor set where the caller wants it. */
async function track(client: Client, id: number, title: string, cursor: string | null) {
  await client.execute({
    sql: `INSERT INTO sync_state (collection_id, collection_title, last_created_cursor, last_synced_at)
          VALUES (?, ?, ?, ?)`,
    args: [id, title, cursor, "2026-08-13T09:02:08.000Z"],
  });
}

function stubRaindropApi(t: TestContext, byCollection: Record<number, FakeBookmark[]>): void {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const match = url.match(/\/raindrops\/(\d+)\?sort=-created&perpage=(\d+)&page=(\d+)/);
    if (!match) return new Response("not found", { status: 404 });
    const bookmarks = byCollection[Number(match[1])] ?? [];
    const perpage = Number(match[2]);
    const page = Number(match[3]);
    const sorted = [...bookmarks].sort((a, b) => b.created.localeCompare(a.created));
    const items = sorted.slice(page * perpage, (page + 1) * perpage);
    return new Response(JSON.stringify({ items }), { status: 200 });
  }) as typeof fetch;
}

const store = (client: Client, url: string) =>
  ingestUrl(client, url, { extract: fakeExtractOk(richContent("reconcile")) });

test("a corpus holding every bookmark reports no gap", async (t) => {
  const client = await makeTestClient();
  await track(client, 1, "Tools", "2026-08-12T00:00:00.000Z");
  stubRaindropApi(t, {
    1: [
      bookmark(10, "https://example.com/a", "2026-08-10T00:00:00.000Z"),
      bookmark(11, "https://example.com/b", "2026-08-11T00:00:00.000Z"),
    ],
  });
  await store(client, "https://example.com/a");
  await store(client, "https://example.com/b");

  const result = await reconcile(client, "tok");
  assert.equal(result.absent.length, 0);
  assert.equal(result.remoteTotal, 2);
  assert.match(formatReconcile(result), /all present/);
});

test("a bookmark behind the cursor is reported as stranded", async (t) => {
  const client = await makeTestClient();
  // The DriveDeck case: created 2026-08-04, filed into the collection today by
  // triage, cursor already advanced past it on 2026-08-12.
  await track(client, 1, "Cloud & SaaS", "2026-08-12T13:25:15.839Z");
  stubRaindropApi(t, {
    1: [
      bookmark(10, "https://example.com/present", "2026-08-11T00:00:00.000Z"),
      bookmark(11, "https://drivedeck.xyz/", "2026-08-04T01:40:38.241Z"),
    ],
  });
  await store(client, "https://example.com/present");

  const result = await reconcile(client, "tok");
  assert.equal(result.absent.length, 1);
  assert.equal(result.absent[0].raindropId, 11);
  assert.equal(result.absent[0].behindCursor, true);

  const report = formatReconcile(result);
  assert.match(report, /1 stranded behind the cursor/);
  assert.match(report, /clipbase ingest https:\/\/drivedeck\.xyz\//);
});

test("a bookmark ahead of the cursor is pending, not stranded", async (t) => {
  const client = await makeTestClient();
  await track(client, 1, "Tools", "2026-08-01T00:00:00.000Z");
  stubRaindropApi(t, { 1: [bookmark(10, "https://example.com/new", "2026-08-12T00:00:00.000Z")] });

  const result = await reconcile(client, "tok");
  assert.equal(result.absent.length, 1);
  assert.equal(result.absent[0].behindCursor, false);
  // The next sync reaches it on its own, so it must not ask for a manual ingest.
  assert.doesNotMatch(formatReconcile(result), /ingest by hand/);
});

test("a duplicate saved under a non-canonical URL is not a gap", async (t) => {
  const client = await makeTestClient();
  await track(client, 1, "Videos", "2026-08-12T00:00:00.000Z");
  // Raindrop holds the same video twice; the corpus canonicalizes both to one
  // row. Diffing raindrop ids instead of canonical URLs would report a phantom.
  stubRaindropApi(t, {
    1: [
      bookmark(10, "https://youtube.com/watch?v=4jy0T98dYoI", "2026-08-01T00:00:00.000Z"),
      bookmark(11, "https://m.youtube.com/watch?v=4jy0T98dYoI&pp=ugUEEgJlbg%3D%3D", "2026-08-02T00:00:00.000Z"),
    ],
  });
  await store(client, "https://youtube.com/watch?v=4jy0T98dYoI");

  const result = await reconcile(client, "tok");
  assert.equal(result.absent.length, 0);
});

test("an unreachable collection is a partial check, not a failed one", async (t) => {
  const client = await makeTestClient();
  await track(client, 1, "Tools", null);
  await track(client, 2, "Learning", null);
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/raindrops/1")) return new Response("boom", { status: 503 });
    return new Response(JSON.stringify({ items: [] }), { status: 200 });
  }) as typeof fetch;

  const result = await reconcile(client, "tok");
  assert.equal(result.unreachable.length, 1);
  assert.equal(result.unreachable[0].collectionId, 1);
  assert.match(formatReconcile(result), /not checked: "Tools"/);
});

test("a link clipbase cannot hold is counted, not reported as a gap", async (t) => {
  const client = await makeTestClient();
  await track(client, 1, "Tools", null);
  stubRaindropApi(t, { 1: [bookmark(10, "ftp://example.com/file", "2026-08-01T00:00:00.000Z")] });

  const result = await reconcile(client, "tok");
  assert.equal(result.absent.length, 0);
  assert.equal(result.invalid, 1);
});
