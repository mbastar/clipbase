import { test } from "node:test";
import assert from "node:assert/strict";
import type { Client } from "@libsql/client";
import { makeTestClient, countRows } from "./helpers.js";
import {
  attachTags,
  detachTags,
  attachTopics,
  setTopics,
  setTopicDescription,
  upsertTopic,
  setSummary,
  addLink,
  listTags,
  listTopics,
} from "../src/organize.js";
import { classifyForm, classify } from "../src/commands/classify.js";

async function seedItem(
  client: Client,
  id: number,
  overrides: { sourceType?: string; url?: string; domain?: string } = {},
): Promise<void> {
  await client.execute({
    sql: `INSERT INTO items (id, source_type, url, domain, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'ok', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    args: [
      id,
      overrides.sourceType ?? "web",
      overrides.url ?? `https://example.com/${id}`,
      overrides.domain ?? "example.com",
    ],
  });
}

test("tags are normalized and attaching twice is idempotent", async () => {
  const client = await makeTestClient();
  await seedItem(client, 1);

  assert.deepEqual(await attachTags(client, 1, ["  MCP  ", "Agent Frameworks"]), [
    "mcp",
    "agent frameworks",
  ]);
  assert.deepEqual(await attachTags(client, 1, ["mcp"]), []);
  assert.equal(await countRows(client, "item_tags"), 2);
  assert.equal(await countRows(client, "tags"), 2);
});

test("detaching removes the join row, not the tag itself", async () => {
  const client = await makeTestClient();
  await seedItem(client, 1);
  await attachTags(client, 1, ["mcp"]);

  assert.equal(await detachTags(client, 1, ["MCP"]), 1);
  assert.equal(await countRows(client, "item_tags"), 0);
  assert.equal(await countRows(client, "tags"), 1);
});

test("writes are rejected for an item that does not exist", async () => {
  const client = await makeTestClient();
  await assert.rejects(() => attachTags(client, 99, ["x"]), /no item with id 99/);
  await assert.rejects(() => setSummary(client, 99, "s"), /no item with id 99/);
});

test("empty tag names are rejected", async () => {
  const client = await makeTestClient();
  await seedItem(client, 1);
  await assert.rejects(() => attachTags(client, 1, ["   "]), /cannot be empty/);
});

test("a topic description is set once and not clobbered by a later attach", async () => {
  const client = await makeTestClient();
  await seedItem(client, 1);

  await upsertTopic(client, "Agent Frameworks", "Libraries for building agents");
  await attachTopics(client, 1, ["agent frameworks"]);

  const topics = await listTopics(client);
  assert.equal(topics.length, 1);
  assert.equal(topics[0].description, "Libraries for building agents");
  assert.equal(topics[0].item_count, 1);
});

test("setTopicDescription rewords a topic that upsertTopic would have left alone", async () => {
  const client = await makeTestClient();
  await seedItem(client, 1);

  await upsertTopic(client, "agent-frameworks", "Libraries and harnesses for building or running agents");
  await upsertTopic(client, "agent-frameworks", "narrower wording that upsert will not apply");
  const [before] = await listTopics(client);
  assert.match(String(before.description), /^Libraries and harnesses/);

  await setTopicDescription(client, "agent-frameworks", "Libraries you BUILD an agent with");
  const [after] = await listTopics(client);
  assert.equal(after.description, "Libraries you BUILD an agent with");
});

test("setTopics takes a topic away, which is what a tightened taxonomy needs", async () => {
  const client = await makeTestClient();
  await seedItem(client, 1);

  await attachTopics(client, 1, ["agent-frameworks", "mcp"]);
  const removed = await setTopics(client, 1, ["agent-orchestration", "mcp"]);

  assert.deepEqual(removed, ["agent-frameworks"]);
  const rs = await client.execute(
    `SELECT t.name FROM item_topics it JOIN topics t ON t.id = it.topic_id
     WHERE it.item_id = 1 ORDER BY t.name`,
  );
  assert.deepEqual(
    rs.rows.map((r) => String(r.name)),
    ["agent-orchestration", "mcp"],
  );
});

test("setTopics with no names leaves the item alone, so a blank reply cannot strip it", async () => {
  const client = await makeTestClient();
  await seedItem(client, 1);

  await attachTopics(client, 1, ["agent-frameworks"]);
  const removed = await setTopics(client, 1, []);

  assert.deepEqual(removed, []);
  assert.equal(await countRows(client, "item_topics"), 1);
});

test("summary upserts rather than duplicating", async () => {
  const client = await makeTestClient();
  await seedItem(client, 1);

  await setSummary(client, 1, "first");
  await setSummary(client, 1, "second");
  const rs = await client.execute("SELECT summary FROM item_annotations WHERE item_id = 1");
  assert.equal(rs.rows.length, 1);
  assert.equal(String(rs.rows[0].summary), "second");
});

test("links are idempotent per type and reject self-reference", async () => {
  const client = await makeTestClient();
  await seedItem(client, 1);
  await seedItem(client, 2);

  await addLink(client, 1, 2, "related", "first note");
  await addLink(client, 1, 2, "related", "better note");
  await addLink(client, 1, 2, "expands_on");
  assert.equal(await countRows(client, "item_links"), 2);

  const rs = await client.execute(
    "SELECT note FROM item_links WHERE from_item_id = 1 AND link_type = 'related'",
  );
  assert.equal(String(rs.rows[0].note), "better note");
  await assert.rejects(() => addLink(client, 1, 1, "related"), /cannot link to itself/);
});

test("tag listing counts items and orders by frequency", async () => {
  const client = await makeTestClient();
  await seedItem(client, 1);
  await seedItem(client, 2);
  await attachTags(client, 1, ["common", "rare"]);
  await attachTags(client, 2, ["common"]);

  assert.deepEqual(await listTags(client), [
    { name: "common", item_count: 2 },
    { name: "rare", item_count: 1 },
  ]);
});

test("classifyForm maps hosts and url shape to a form", () => {
  const form = (url: string, sourceType = "web") => {
    const domain = new URL(url).hostname.replace(/^www\./, "");
    return classifyForm({ id: 1, source_type: sourceType, url, domain });
  };

  assert.equal(form("https://github.com/o/r"), "repo");
  assert.equal(form("https://gist.github.com/o/abc123"), "repo");
  assert.equal(form("https://youtube.com/watch?v=abc"), "video");
  assert.equal(form("https://reddit.com/r/x/comments/1"), "discussion");
  assert.equal(form("https://docs.turso.tech/features"), "reference");
  assert.equal(form("https://developers.cloudflare.com/sandbox"), "reference");
  assert.equal(form("https://someone.substack.com/p/post"), "article");
  assert.equal(form("https://paulgraham.com/greatwork.html"), "article");
  assert.equal(form("https://arxiv.org/abs/1706.03762"), "paper");
  assert.equal(form("https://example.com/whitepaper.pdf"), "paper");
  assert.equal(form("https://anything.com/x", "pdf"), "paper");
  // A bare root path is a product/landing page, not an article.
  assert.equal(form("https://membase.so"), "product");
  assert.equal(form("https://membase.so/"), "product");
});

test("classify assigns exactly one form tag and re-runs cleanly", async () => {
  const client = await makeTestClient();
  await seedItem(client, 1, { url: "https://github.com/o/r", domain: "github.com" });
  await seedItem(client, 2, { url: "https://membase.so", domain: "membase.so" });

  const dry = await classify(client, { apply: false });
  assert.equal(dry.changed.length, 2);
  assert.equal(await countRows(client, "item_tags"), 0);

  await classify(client, { apply: true });
  assert.deepEqual(await listTags(client), [
    { name: "form:product", item_count: 1 },
    { name: "form:repo", item_count: 1 },
  ]);

  const again = await classify(client, { apply: true });
  assert.equal(again.changed.length, 0);
  assert.equal(await countRows(client, "item_tags"), 2);
});

test("a reclassified item loses its stale form tag", async () => {
  const client = await makeTestClient();
  await seedItem(client, 1, { url: "https://membase.so", domain: "membase.so" });
  await classify(client, { apply: true });

  // The same page, later re-ingested with a real path: product -> article.
  await client.execute(
    "UPDATE items SET url = 'https://membase.so/blog/post', domain = 'membase.so' WHERE id = 1",
  );
  const result = await classify(client, { apply: true });

  assert.deepEqual(result.changed, [{ id: 1, from: "form:product", to: "form:article" }]);
  const rs = await client.execute(
    `SELECT t.name FROM tags t JOIN item_tags it ON it.tag_id = t.id WHERE it.item_id = 1`,
  );
  assert.deepEqual(
    rs.rows.map((r) => String(r.name)),
    ["form:article"],
  );
});
