import type { Client } from "../db.js";

export interface ListFilters {
  sourceType?: string;
  status?: string;
  limit: number;
}

export interface ListRow {
  id: number;
  source_type: string;
  status: string;
  failure_reason: string | null;
  title: string | null;
  url: string | null;
  domain: string | null;
  word_count: number | null;
  created_at: string;
}

export async function listItems(client: Client, filters: ListFilters): Promise<ListRow[]> {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (filters.sourceType) {
    where.push("i.source_type = ?");
    args.push(filters.sourceType);
  }
  if (filters.status) {
    where.push("i.status = ?");
    args.push(filters.status);
  }
  args.push(filters.limit);
  const rs = await client.execute({
    sql: `SELECT i.id, i.source_type, i.status, i.failure_reason, i.title, i.url, i.domain,
                 c.word_count, i.created_at
          FROM items i LEFT JOIN item_content c ON c.item_id = i.id
          ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
          ORDER BY i.created_at DESC, i.id DESC
          LIMIT ?`,
    args,
  });
  return rs.rows.map((r) => ({
    id: Number(r.id),
    source_type: String(r.source_type),
    status: String(r.status),
    failure_reason: r.failure_reason != null ? String(r.failure_reason) : null,
    title: r.title != null ? String(r.title) : null,
    url: r.url != null ? String(r.url) : null,
    domain: r.domain != null ? String(r.domain) : null,
    word_count: r.word_count != null ? Number(r.word_count) : null,
    created_at: String(r.created_at),
  }));
}
