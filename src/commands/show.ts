import type { Client, Row } from "@libsql/client";

export interface ShowResult {
  item: Record<string, unknown>;
  /**
   * Absent when the caller asked not to fetch it — which is not the same thing
   * as `null`, the answer for an item that genuinely has no stored content
   * (every `extraction_failed` row). An agent reading this has to be able to
   * tell "I did not ask" from "there is nothing there".
   */
  content?: string | null;
  chunk_count: number;
  summary: string | null;
  topics: string[];
  tags: string[];
}

function rowToObject(row: Row): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  for (const key of Object.keys(row)) obj[key] = row[key];
  return obj;
}

export async function showItem(
  client: Client,
  id: number,
  opts: { content?: boolean } = {},
): Promise<ShowResult> {
  const wantContent = opts.content !== false;
  const item = (await client.execute({ sql: "SELECT * FROM items WHERE id = ?", args: [id] }))
    .rows[0];
  if (!item) throw new Error(`no item with id ${id}`);

  const [content, chunkCount, annotation, topics, tags] = await Promise.all([
    wantContent
      ? client.execute({ sql: "SELECT content FROM item_content WHERE item_id = ?", args: [id] })
      : null,
    client.execute({ sql: "SELECT count(*) AS n FROM chunks WHERE item_id = ?", args: [id] }),
    client.execute({ sql: "SELECT summary FROM item_annotations WHERE item_id = ?", args: [id] }),
    client.execute({
      sql: `SELECT t.name FROM topics t JOIN item_topics it ON it.topic_id = t.id
            WHERE it.item_id = ? ORDER BY t.name`,
      args: [id],
    }),
    client.execute({
      sql: `SELECT t.name FROM tags t JOIN item_tags it ON it.tag_id = t.id
            WHERE it.item_id = ? ORDER BY t.name`,
      args: [id],
    }),
  ]);

  return {
    item: rowToObject(item),
    ...(content
      ? { content: content.rows[0]?.content != null ? String(content.rows[0].content) : null }
      : {}),
    chunk_count: Number(chunkCount.rows[0]?.n ?? 0),
    summary: annotation.rows[0]?.summary != null ? String(annotation.rows[0].summary) : null,
    topics: topics.rows.map((r) => String(r.name)),
    tags: tags.rows.map((r) => String(r.name)),
  };
}
