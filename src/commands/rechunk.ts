// Maintenance pass: re-derive every item's chunks from the immutable raw
// content with the current chunking rules.
//
// Needed whenever chunkMarkdown changes: ingest chunks an item once, on the
// write that first stores its content, so stored chunks otherwise keep the
// shape they were written with forever. Chunks are derived and regenerable, so
// the pass is safe to re-run — it compares against the recomputed result and
// rewrites only the items that actually differ.

import type { Client } from "../db.js";
import { chunkMarkdown, wordCount, CHUNKING_VERSION } from "../chunk.js";

export interface Rechunk {
  itemId: number;
  from: number;
  to: number;
}

export interface RechunkResult {
  scanned: number;
  changes: Rechunk[];
  /**
   * Items whose chunks the current rules reproduce exactly but which were
   * written by an older version. Their text is already current, so only the
   * stamp moves — that keeps `chunking_version` meaning "conforms to", not
   * "was last rewritten by", so a stale-chunk query stays truthful.
   */
  restamped: number;
  applied: boolean;
}

export async function rechunk(
  client: Client,
  opts: { apply: boolean; log?: (msg: string) => void },
): Promise<RechunkResult> {
  const log = opts.log ?? (() => {});
  const contents = await client.execute(
    "SELECT item_id, content FROM item_content ORDER BY item_id",
  );

  const changes: Rechunk[] = [];
  let restamped = 0;
  for (const row of contents.rows) {
    const itemId = Number(row.item_id);
    const next = chunkMarkdown(String(row.content));

    const stored = await client.execute({
      sql: "SELECT content, chunking_version FROM chunks WHERE item_id = ? ORDER BY seq",
      args: [itemId],
    });
    const before = stored.rows.map((r) => String(r.content));
    if (before.length === next.length && before.every((c, i) => c === next[i])) {
      const stale = stored.rows.some((r) => Number(r.chunking_version) !== CHUNKING_VERSION);
      if (!stale) continue;
      restamped++;
      if (opts.apply) {
        await client.execute({
          sql: "UPDATE chunks SET chunking_version = ? WHERE item_id = ?",
          args: [CHUNKING_VERSION, itemId],
        });
      }
      continue;
    }

    changes.push({ itemId, from: before.length, to: next.length });
    if (!opts.apply) continue;

    await client.batch(
      [
        { sql: "DELETE FROM chunks WHERE item_id = ?", args: [itemId] },
        ...next.map((chunk, seq) => ({
          sql: `INSERT INTO chunks (item_id, seq, content, word_count, chunking_version)
                VALUES (?, ?, ?, ?, ?)`,
          args: [itemId, seq, chunk, wordCount(chunk), CHUNKING_VERSION],
        })),
      ],
      "write",
    );
    log(`rechunked #${itemId}: ${before.length} -> ${next.length} chunk(s)`);
  }

  if (restamped) log(`restamped ${restamped} item(s) already at the current shape`);
  return { scanned: contents.rows.length, changes, restamped, applied: opts.apply };
}
