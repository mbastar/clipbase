// Maintenance pass: re-derive every item's canonical URL with the current
// rules and merge rows that collapse onto the same canonical.
//
// Needed whenever canonicalizeUrl changes: stored urls keep the old shape, so
// re-ingesting a known page would miss the existing row and duplicate it.
// Canonical is recomputed from original_url (the pristine saved form) so the
// pass is idempotent and never compounds an earlier normalization.

import type { Client } from "../db.js";
import { canonicalizeUrl } from "../canonicalize.js";
import { nowIso } from "../db.js";

interface ItemRow {
  id: number;
  url: string;
  original_url: string | null;
  raindrop_id: string | null;
  has_content: boolean;
  word_count: number;
}

export interface Merge {
  canonical: string;
  keep: number;
  drop: number[];
  /** raindrop_id moved off a dropped row onto the survivor, if any. */
  transferred_raindrop_id: string | null;
}

export interface Rewrite {
  id: number;
  from: string;
  to: string;
}

export interface RecanonicalizeResult {
  scanned: number;
  rewrites: Rewrite[];
  merges: Merge[];
  applied: boolean;
}

// Survivor priority: real content beats none, then Raindrop provenance, then
// the oldest row (lowest id) so the choice is stable across runs.
function pickSurvivor(group: ItemRow[]): ItemRow {
  return [...group].sort((a, b) => {
    if (a.has_content !== b.has_content) return a.has_content ? -1 : 1;
    if (a.word_count !== b.word_count) return b.word_count - a.word_count;
    const aDrop = a.raindrop_id != null;
    const bDrop = b.raindrop_id != null;
    if (aDrop !== bDrop) return aDrop ? -1 : 1;
    return a.id - b.id;
  })[0];
}

async function loadItems(client: Client): Promise<ItemRow[]> {
  const rs = await client.execute(
    `SELECT i.id, i.url, i.original_url, i.raindrop_id,
            c.item_id IS NOT NULL AS has_content,
            coalesce(c.word_count, 0) AS word_count
     FROM items i LEFT JOIN item_content c ON c.item_id = i.id
     ORDER BY i.id`,
  );
  return rs.rows.map((r) => ({
    id: Number(r.id),
    url: String(r.url),
    original_url: r.original_url != null ? String(r.original_url) : null,
    raindrop_id: r.raindrop_id != null ? String(r.raindrop_id) : null,
    has_content: Number(r.has_content) === 1,
    word_count: Number(r.word_count),
  }));
}

export async function recanonicalize(
  client: Client,
  opts: { apply: boolean; log?: (msg: string) => void },
): Promise<RecanonicalizeResult> {
  const log = opts.log ?? (() => {});
  const items = await loadItems(client);

  // Group by the canonical the current rules produce. A URL we can no longer
  // parse (or that was never http) keeps its stored value rather than throwing
  // away the row.
  const groups = new Map<string, ItemRow[]>();
  const targets = new Map<number, string>();
  for (const item of items) {
    let canonical: string;
    try {
      canonical = canonicalizeUrl(item.original_url ?? item.url).canonical;
    } catch {
      log(`skipping #${item.id}: cannot canonicalize ${item.original_url ?? item.url}`);
      continue;
    }
    targets.set(item.id, canonical);
    const group = groups.get(canonical);
    if (group) group.push(item);
    else groups.set(canonical, [item]);
  }

  const rewrites: Rewrite[] = [];
  const merges: Merge[] = [];
  for (const [canonical, group] of groups) {
    const keep = group.length > 1 ? pickSurvivor(group) : group[0];
    if (group.length > 1) {
      const dropped = group.filter((r) => r.id !== keep.id);
      const donor = keep.raindrop_id == null ? dropped.find((r) => r.raindrop_id != null) : undefined;
      merges.push({
        canonical,
        keep: keep.id,
        drop: dropped.map((r) => r.id),
        transferred_raindrop_id: donor?.raindrop_id ?? null,
      });
    }
    if (keep.url !== canonical) rewrites.push({ id: keep.id, from: keep.url, to: canonical });
  }

  if (!opts.apply) {
    return { scanned: items.length, rewrites, merges, applied: false };
  }

  // Deletes run first: a dropped row may be squatting on the canonical the
  // survivor is about to take, and items.url is UNIQUE.
  for (const merge of merges) {
    if (merge.transferred_raindrop_id != null) {
      await client.execute({
        sql: "UPDATE items SET raindrop_id = NULL WHERE id IN (SELECT value FROM json_each(?))",
        args: [JSON.stringify(merge.drop)],
      });
      await client.execute({
        sql: "UPDATE items SET raindrop_id = ?, updated_at = ? WHERE id = ?",
        args: [merge.transferred_raindrop_id, nowIso(), merge.keep],
      });
    }
    await client.execute({
      sql: "DELETE FROM items WHERE id IN (SELECT value FROM json_each(?))",
      args: [JSON.stringify(merge.drop)],
    });
    log(`merged ${merge.drop.map((id) => `#${id}`).join(", ")} into #${merge.keep}`);
  }

  // Two-phase rewrite: one row's new url can be another row's current url, so
  // parking every mover on a unique placeholder avoids a transient collision.
  for (const rewrite of rewrites) {
    await client.execute({
      sql: "UPDATE items SET url = ? WHERE id = ?",
      args: [`recanonicalize:pending:${rewrite.id}`, rewrite.id],
    });
  }
  for (const rewrite of rewrites) {
    const { canonical, domain } = canonicalizeUrl(rewrite.to);
    await client.execute({
      sql: "UPDATE items SET url = ?, domain = ?, updated_at = ? WHERE id = ?",
      args: [canonical, domain, nowIso(), rewrite.id],
    });
  }
  if (rewrites.length) log(`rewrote ${rewrites.length} canonical url(s)`);

  return { scanned: items.length, rewrites, merges, applied: true };
}
