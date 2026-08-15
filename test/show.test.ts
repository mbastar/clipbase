import { test } from "node:test";
import assert from "node:assert/strict";
import { ingestUrl } from "../src/ingest.js";
import { showItem } from "../src/commands/show.js";
import { makeTestClient, fakeExtractOk, fakeExtractFail, richContent } from "./helpers.js";

test("show returns the stored document by default", async () => {
  const client = await makeTestClient();
  const item = await ingestUrl(client, "https://example.com/doc", {
    extract: fakeExtractOk(richContent("possum"), "Possum notes"),
  });

  const result = await showItem(client, item.id);
  assert.match(String(result.content), /possum/);
  assert.ok(result.chunk_count > 0);
});

// The whole document is the expensive part of this call, and a caller that only
// needs to confirm which item an id refers to should not have to pay for it.
test("--no-content omits the document but keeps what identifies the item", async () => {
  const client = await makeTestClient();
  const item = await ingestUrl(client, "https://example.com/doc", {
    extract: fakeExtractOk(richContent("possum"), "Possum notes"),
  });

  const full = await showItem(client, item.id);
  const lean = await showItem(client, item.id, { content: false });

  assert.ok(!("content" in lean), "the key is absent, not null");
  assert.equal(lean.chunk_count, full.chunk_count);
  assert.equal(lean.item.title, "Possum notes");
  assert.deepEqual(lean.topics, full.topics);
});

// `null` is already the answer for an item whose extraction failed. If skipping
// the fetch also produced `null`, those two would be indistinguishable and a
// caller could conclude a healthy document was empty.
test("an item with no stored content reports null, which absence does not imitate", async () => {
  const client = await makeTestClient();
  const failed = await ingestUrl(client, "https://example.com/blocked", {
    extract: fakeExtractFail,
  });

  const result = await showItem(client, failed.id);
  assert.ok("content" in result);
  assert.equal(result.content, null);
  assert.equal(result.item.status, "extraction_failed");
});
