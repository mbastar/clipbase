import { test } from "node:test";
import assert from "node:assert/strict";
import { ingestUrl } from "../src/ingest.js";
import { searchItems } from "../src/commands/search.js";
import type { Client } from "../src/db.js";
import {
  makeTestClient,
  fakeExtractOk,
  fakeExtractFail,
  fakeExtractFailWith,
  richContent,
  countRows,
} from "./helpers.js";

test("ingest creates item, content, chunks, and FTS row", async () => {
  const client = await makeTestClient();
  const result = await ingestUrl(client, "https://example.com/post?utm_source=news", {
    extract: fakeExtractOk(richContent("turso"), "About Turso"),
  });
  assert.equal(result.action, "created");
  assert.equal(result.status, "ok");
  assert.equal(result.url, "https://example.com/post");
  assert.ok(result.wordCount && result.wordCount > 100);

  assert.equal(await countRows(client, "items"), 1);
  assert.equal(await countRows(client, "item_content"), 1);
  const chunks = await client.execute("SELECT seq FROM chunks ORDER BY seq");
  assert.ok(chunks.rows.length >= 1);
  assert.deepEqual(
    chunks.rows.map((r) => Number(r.seq)),
    [...chunks.rows.keys()],
  );

  const hits = await searchItems(client, "turso", 10);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, result.id);
});

test("re-ingest of URL variants refreshes metadata, never duplicates", async () => {
  const client = await makeTestClient();
  const first = await ingestUrl(client, "https://example.com/a/b/?utm_campaign=x", {
    extract: fakeExtractOk(richContent("dedupe"), "Original"),
  });
  const second = await ingestUrl(client, "https://EXAMPLE.com/a/b#section", {
    extract: fakeExtractOk(richContent("changed"), "Newer Title"),
    meta: { title: "Newer Title" },
  });
  assert.equal(second.action, "refreshed");
  assert.equal(second.id, first.id);
  assert.equal(await countRows(client, "items"), 1);
  assert.equal(await countRows(client, "item_content"), 1);

  // metadata refreshed, raw content untouched
  const row = (await client.execute("SELECT title FROM items")).rows[0];
  assert.equal(row.title, "Newer Title");
  const content = (await client.execute("SELECT content FROM item_content")).rows[0];
  assert.match(String(content.content), /dedupe/);
});

test("raw content is write-once at the database level", async () => {
  const client = await makeTestClient();
  await ingestUrl(client, "https://example.com/immutable", {
    extract: fakeExtractOk(richContent("immutable")),
  });
  await assert.rejects(
    client.execute("UPDATE item_content SET content = 'mutated'"),
    /write-once/,
  );
});

test("failed extraction stores status row without content; re-ingest retries", async () => {
  const client = await makeTestClient();
  const failed = await ingestUrl(client, "https://example.com/paywalled", {
    extract: fakeExtractFail,
  });
  assert.equal(failed.action, "created");
  assert.equal(failed.status, "extraction_failed");
  assert.equal(await countRows(client, "item_content"), 0);
  assert.equal((await searchItems(client, "paywalled", 10)).length, 0);

  const retried = await ingestUrl(client, "https://example.com/paywalled", {
    extract: fakeExtractOk(richContent("paywalled"), "Now Readable"),
  });
  assert.equal(retried.action, "retried");
  assert.equal(retried.id, failed.id);
  assert.equal(retried.status, "ok");
  assert.equal(await countRows(client, "items"), 1);
  assert.equal(await countRows(client, "item_content"), 1);
  assert.equal((await searchItems(client, "paywalled", 10)).length, 1);
});

async function storedContent(client: Client, id: number): Promise<string> {
  const rs = await client.execute({
    sql: "SELECT content FROM item_content WHERE item_id = ?",
    args: [id],
  });
  return String(rs.rows[0]?.content ?? "");
}

test("--force replaces raw content and rebuilds everything derived from it", async () => {
  const client = await makeTestClient();
  const first = await ingestUrl(client, "https://example.com/wrong-doc", {
    extract: fakeExtractOk(richContent("blockpage"), "Error 403"),
  });
  assert.equal(await countRows(client, "item_content"), 1);
  const staleChunks = (await client.execute("SELECT id FROM chunks")).rows.length;
  assert.ok(staleChunks > 0);

  const repaired = await ingestUrl(client, "https://example.com/wrong-doc", {
    force: true,
    extract: fakeExtractOk(richContent("transcript", 900), "The Real Talk"),
  });
  assert.equal(repaired.action, "replaced");
  assert.equal(repaired.id, first.id);
  assert.equal(repaired.status, "ok");

  // One content row, holding the new document.
  assert.equal(await countRows(client, "item_content"), 1);
  assert.match(await storedContent(client, first.id), /transcript/);
  assert.doesNotMatch(await storedContent(client, first.id), /blockpage/);

  // FTS follows the content: the old text is unfindable, the new text is.
  assert.equal((await searchItems(client, "blockpage", 10)).length, 0);
  assert.equal((await searchItems(client, "transcript", 10)).length, 1);
});

test("a forced re-fetch that fails keeps the content it could not replace", async () => {
  // The failure that makes --force dangerous: repairing item 5, one fetch
  // returned the transcript and five returned a bot-block shell. Trading a
  // good document for a bad one is the outcome this must never allow.
  const client = await makeTestClient();
  const good = await ingestUrl(client, "https://example.com/keeps", {
    extract: fakeExtractOk(richContent("original"), "Good Doc"),
  });

  const attempted = await ingestUrl(client, "https://example.com/keeps", {
    force: true,
    extract: fakeExtractFailWith("blocked_content"),
  });

  assert.equal(attempted.action, "kept");
  assert.equal(attempted.id, good.id);
  // The item is still healthy; the *re-fetch* is what failed.
  assert.equal(attempted.status, "ok");
  assert.equal(attempted.failureReason, "blocked_content");

  assert.equal(await countRows(client, "item_content"), 1);
  assert.match(await storedContent(client, good.id), /original/);
  assert.equal(await storedReason(client, good.id), null);
  assert.equal((await searchItems(client, "original", 10)).length, 1);
});

test("--force on an item with no content is an ordinary retry", async () => {
  const client = await makeTestClient();
  const failed = await ingestUrl(client, "https://example.com/never-worked", {
    extract: fakeExtractFailWith("blocked_content"),
  });
  assert.equal(failed.status, "extraction_failed");

  const retried = await ingestUrl(client, "https://example.com/never-worked", {
    force: true,
    extract: fakeExtractOk(richContent("finally"), "Works Now"),
  });
  // Nothing was replaced, because there was nothing there to replace.
  assert.equal(retried.action, "retried");
  assert.equal(retried.status, "ok");
  assert.equal(await countRows(client, "item_content"), 1);
});

test("without --force, a known-good item is never re-fetched at all", async () => {
  const client = await makeTestClient();
  await ingestUrl(client, "https://example.com/untouched", {
    extract: fakeExtractOk(richContent("kept"), "Original"),
  });
  let fetched = false;
  const second = await ingestUrl(client, "https://example.com/untouched", {
    extract: async () => {
      fetched = true;
      return { ok: true, method: "defuddle", content: richContent("replacement") };
    },
  });
  assert.equal(second.action, "refreshed");
  assert.equal(fetched, false);
  assert.match(await storedContent(client, second.id), /kept/);
});

async function storedReason(client: Client, id: number): Promise<string | null> {
  const rs = await client.execute({
    sql: "SELECT failure_reason FROM items WHERE id = ?",
    args: [id],
  });
  const value = rs.rows[0]?.failure_reason;
  return value != null ? String(value) : null;
}

test("a failure records why it failed", async () => {
  const client = await makeTestClient();
  const walled = await ingestUrl(client, "https://example.com/login-wall", {
    extract: fakeExtractFailWith("thin_content"),
  });
  const offline = await ingestUrl(client, "https://example.com/unreachable", {
    extract: fakeExtractFailWith("fetch_error"),
  });

  assert.equal(walled.failureReason, "thin_content");
  assert.equal(offline.failureReason, "fetch_error");
  assert.equal(await storedReason(client, walled.id), "thin_content");
  assert.equal(await storedReason(client, offline.id), "fetch_error");
});

test("a reason does not outlive the failure that caused it", async () => {
  const client = await makeTestClient();
  const failed = await ingestUrl(client, "https://example.com/recovers", {
    extract: fakeExtractFailWith("fetch_error"),
  });
  assert.equal(await storedReason(client, failed.id), "fetch_error");

  // The site comes back: a stale reason on a now-healthy row would make the
  // corpus look permanently broken.
  const recovered = await ingestUrl(client, "https://example.com/recovers", {
    extract: fakeExtractOk(richContent("recovers")),
  });
  assert.equal(recovered.id, failed.id);
  assert.equal(recovered.status, "ok");
  assert.equal(recovered.failureReason, null);
  assert.equal(await storedReason(client, failed.id), null);
});
