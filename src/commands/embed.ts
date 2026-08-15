// Backfill pass: embed every chunk that has no current vector.
//
// A chunk needs embedding when it has none, or when the stored vector came from
// a different model. rechunk deletes and reinserts a rewritten item's chunks,
// so changed text drops its embedding automatically — stale vectors cannot
// outlive the passage they describe.

import type { Client } from "../db.js";
import { embed as defaultEmbed, EMBEDDING_MODEL, type Embedder } from "../embed.js";

// Rows per write batch, independent of the provider's request batching. Each
// row carries a 768-float vector as JSON, so 64 rows is a ~600KB write — large
// enough that a stalled connection costs minutes and loses the whole batch.
// Smaller batches bound both the payload and how much progress a failure
// discards; the pass is resumable, so the only cost is more round trips.
const WRITE_BATCH = 16;

export interface EmbedResult {
  pending: number;
  embedded: number;
  tokens: number;
  applied: boolean;
}

interface PendingChunk {
  id: number;
  content: string;
}

async function loadPending(client: Client, limit?: number): Promise<PendingChunk[]> {
  const rs = await client.execute({
    sql: `SELECT id, content FROM chunks
          WHERE embedding IS NULL OR embedding_model IS NULL OR embedding_model != ?
          ORDER BY id${limit != null ? " LIMIT ?" : ""}`,
    args: limit != null ? [EMBEDDING_MODEL, limit] : [EMBEDDING_MODEL],
  });
  return rs.rows.map((r) => ({ id: Number(r.id), content: String(r.content) }));
}

export async function embedChunks(
  client: Client,
  opts: {
    apply: boolean;
    limit?: number;
    embed?: Embedder;
    log?: (msg: string) => void;
  },
): Promise<EmbedResult> {
  const log = opts.log ?? (() => {});
  const embed = opts.embed ?? defaultEmbed;
  const pending = await loadPending(client, opts.limit);

  if (!opts.apply || pending.length === 0) {
    return { pending: pending.length, embedded: 0, tokens: 0, applied: false };
  }

  let embedded = 0;
  let tokens = 0;
  for (let i = 0; i < pending.length; i += WRITE_BATCH) {
    const batch = pending.slice(i, i + WRITE_BATCH);
    const result = await embed(
      batch.map((c) => c.content),
      "document",
    );
    tokens += result.tokens;

    await client.batch(
      batch.map((chunk, n) => ({
        sql: `UPDATE chunks SET embedding = vector32(?), embedding_model = ? WHERE id = ?`,
        args: [JSON.stringify(result.vectors[n]), EMBEDDING_MODEL, chunk.id],
      })),
      "write",
    );
    embedded += batch.length;
    log(`embedded ${embedded}/${pending.length} chunk(s)`);
  }

  return { pending: pending.length, embedded, tokens, applied: true };
}
