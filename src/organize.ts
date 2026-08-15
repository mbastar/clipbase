// Write primitives for the agent-owned organization layer (topics, tags,
// links, annotations). Ingestion never calls these; the CLI and any future
// organize pass do. Nothing here touches items, item_content, or chunks —
// that boundary is the whole point of the schema (see docs/data-model.md).

import type { Client } from "./db.js";
import { nowIso } from "./db.js";

async function requireItem(client: Client, itemId: number): Promise<void> {
  const rs = await client.execute({ sql: "SELECT 1 FROM items WHERE id = ?", args: [itemId] });
  if (!rs.rows.length) throw new Error(`no item with id ${itemId}`);
}

// Names are the stable identity of a tag/topic, so they are trimmed and
// lowercased once here rather than at every call site.
function normalizeName(name: string): string {
  const clean = name.trim().toLowerCase().replace(/\s+/g, " ");
  if (!clean) throw new Error("tag/topic name cannot be empty");
  return clean;
}

async function upsertNamed(
  client: Client,
  table: "tags" | "topics",
  name: string,
  description?: string,
): Promise<number> {
  const clean = normalizeName(name);
  const cols = table === "topics" ? "(name, description, created_at)" : "(name, created_at)";
  const vals = table === "topics" ? "(?, ?, ?)" : "(?, ?)";
  const args =
    table === "topics" ? [clean, description ?? null, nowIso()] : [clean, nowIso()];
  // ON CONFLICT DO NOTHING keeps re-derivation idempotent; a later run that
  // supplies a description fills one in without clobbering an existing one.
  await client.execute({
    sql: `INSERT INTO ${table} ${cols} VALUES ${vals} ON CONFLICT(name) DO NOTHING`,
    args,
  });
  if (table === "topics" && description) {
    await client.execute({
      sql: "UPDATE topics SET description = ? WHERE name = ? AND description IS NULL",
      args: [description, clean],
    });
  }
  const rs = await client.execute({
    sql: `SELECT id FROM ${table} WHERE name = ?`,
    args: [clean],
  });
  return Number(rs.rows[0].id);
}

export async function upsertTag(client: Client, name: string): Promise<number> {
  return upsertNamed(client, "tags", name);
}

export async function upsertTopic(
  client: Client,
  name: string,
  description?: string,
): Promise<number> {
  return upsertNamed(client, "topics", name, description);
}

/** Returns the names actually newly attached (already-attached names are skipped). */
export async function attachTags(
  client: Client,
  itemId: number,
  names: string[],
): Promise<string[]> {
  await requireItem(client, itemId);
  const attached: string[] = [];
  for (const name of names) {
    const tagId = await upsertTag(client, name);
    const rs = await client.execute({
      sql: `INSERT INTO item_tags (item_id, tag_id) VALUES (?, ?)
            ON CONFLICT(item_id, tag_id) DO NOTHING`,
      args: [itemId, tagId],
    });
    if (rs.rowsAffected > 0) attached.push(normalizeName(name));
  }
  return attached;
}

export async function detachTags(
  client: Client,
  itemId: number,
  names: string[],
): Promise<number> {
  let removed = 0;
  for (const name of names) {
    const rs = await client.execute({
      sql: `DELETE FROM item_tags
            WHERE item_id = ? AND tag_id = (SELECT id FROM tags WHERE name = ?)`,
      args: [itemId, normalizeName(name)],
    });
    removed += rs.rowsAffected;
  }
  return removed;
}

export async function attachTopics(
  client: Client,
  itemId: number,
  names: string[],
): Promise<string[]> {
  await requireItem(client, itemId);
  const attached: string[] = [];
  for (const name of names) {
    const topicId = await upsertTopic(client, name);
    const rs = await client.execute({
      sql: `INSERT INTO item_topics (item_id, topic_id) VALUES (?, ?)
            ON CONFLICT(item_id, topic_id) DO NOTHING`,
      args: [itemId, topicId],
    });
    if (rs.rowsAffected > 0) attached.push(normalizeName(name));
  }
  return attached;
}

/**
 * Force a topic's description to `description`, unlike `upsertTopic`, which
 * writes one only when none is stored.
 *
 * Set-once is right for a topic a human described by hand, and wrong for the
 * canonical taxonomy: narrowing a slug in code has to reach the copy `clipbase
 * topics` prints, or the corpus advertises a meaning the classifier stopped
 * using.
 */
export async function setTopicDescription(
  client: Client,
  name: string,
  description: string,
): Promise<void> {
  await client.execute({
    sql: `UPDATE topics SET description = ? WHERE name = ?`,
    args: [description, normalizeName(name)],
  });
}

/**
 * Make `names` the item's whole topic set: attach what is missing, drop what the
 * caller no longer claims. Returns the names removed.
 *
 * `attachTopics` alone cannot narrow a label. Re-classifying under a tightened
 * taxonomy would leave the very topic the tightening was meant to replace still
 * attached, so the count never falls and the split reads as cosmetic — which is
 * exactly how `agent-frameworks` survived its own split at 174 items.
 *
 * An empty `names` is a no-op, deliberately. The classifier returns an empty
 * array for "nothing here fits", which is an answer about the taxonomy and not
 * an instruction to forget what the item already carries — and it is also what
 * a degraded batch looks like. Removing on empty would let one bad reply strip
 * an item bare.
 */
export async function setTopics(
  client: Client,
  itemId: number,
  names: string[],
): Promise<string[]> {
  await requireItem(client, itemId);
  if (!names.length) return [];

  await attachTopics(client, itemId, names);

  const keep = names.map(normalizeName);
  const placeholders = keep.map(() => "?").join(",");
  const stale = await client.execute({
    sql: `SELECT t.name FROM item_topics it
          JOIN topics t ON t.id = it.topic_id
          WHERE it.item_id = ? AND t.name NOT IN (${placeholders})`,
    args: [itemId, ...keep],
  });
  const removed = stale.rows.map((r) => String(r.name));
  if (!removed.length) return [];

  await client.execute({
    sql: `DELETE FROM item_topics
          WHERE item_id = ?
            AND topic_id IN (SELECT id FROM topics WHERE name NOT IN (${placeholders}))`,
    args: [itemId, ...keep],
  });
  return removed;
}

export async function setSummary(client: Client, itemId: number, summary: string): Promise<void> {
  await requireItem(client, itemId);
  await client.execute({
    sql: `INSERT INTO item_annotations (item_id, summary, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(item_id) DO UPDATE SET summary = excluded.summary,
                                             updated_at = excluded.updated_at`,
    args: [itemId, summary, nowIso()],
  });
}

export async function addLink(
  client: Client,
  fromItemId: number,
  toItemId: number,
  linkType: string,
  note?: string,
): Promise<void> {
  if (fromItemId === toItemId) throw new Error("an item cannot link to itself");
  await requireItem(client, fromItemId);
  await requireItem(client, toItemId);
  await client.execute({
    sql: `INSERT INTO item_links (from_item_id, to_item_id, link_type, note, created_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(from_item_id, to_item_id, link_type)
          DO UPDATE SET note = excluded.note`,
    args: [fromItemId, toItemId, linkType, note ?? null, nowIso()],
  });
}

export interface NamedCount {
  name: string;
  item_count: number;
  description?: string | null;
}

export async function listTags(client: Client): Promise<NamedCount[]> {
  const rs = await client.execute(
    `SELECT t.name, count(it.item_id) AS n
     FROM tags t LEFT JOIN item_tags it ON it.tag_id = t.id
     GROUP BY t.id ORDER BY n DESC, t.name`,
  );
  return rs.rows.map((r) => ({ name: String(r.name), item_count: Number(r.n) }));
}

export async function listTopics(client: Client): Promise<NamedCount[]> {
  const rs = await client.execute(
    `SELECT t.name, t.description, count(it.item_id) AS n
     FROM topics t LEFT JOIN item_topics it ON it.topic_id = t.id
     GROUP BY t.id ORDER BY n DESC, t.name`,
  );
  return rs.rows.map((r) => ({
    name: String(r.name),
    description: r.description != null ? String(r.description) : null,
    item_count: Number(r.n),
  }));
}
