import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { stat } from "node:fs/promises";
import type { Client } from "./db.js";
import { nowIso } from "./db.js";
import { canonicalizeUrl } from "./canonicalize.js";
import { extractWeb, type FailureReason } from "./extract/web.js";
import { extractPdf } from "./extract/pdf.js";
import { chunkMarkdown, wordCount, CHUNKING_VERSION } from "./chunk.js";

// PDFs only fail extraction when there is essentially no text layer at all
// (e.g. a pure scan); short-but-real documents are kept.
const PDF_MIN_WORDS = 10;

/**
 * What ingest did. `replaced` and `kept` are reachable only under `force`:
 * the first swapped an item's raw content for a fresh fetch, the second tried
 * and failed, leaving the previous content in place.
 */
export type IngestAction = "created" | "refreshed" | "retried" | "replaced" | "kept";

export interface IngestMeta {
  title?: string;
  author?: string;
  published?: string;
}

export interface IngestOptions {
  sourceType?: "web" | "raindrop";
  raindropId?: number;
  meta?: IngestMeta;
  log?: (msg: string) => void;
  extract?: typeof extractWeb;
  /**
   * Re-fetch an item that already extracted successfully and replace its raw
   * content. Off by default: ordinary re-ingest must never touch the raw
   * layer. This is the operator's explicit escape hatch for a stored document
   * that turned out to be wrong, and the only path that can discard one.
   */
  force?: boolean;
}

export interface IngestResult {
  id: number;
  action: IngestAction;
  /** The item's status after ingest — on `kept`, still `ok`. */
  status: "ok" | "extraction_failed";
  /**
   * Why extraction failed; null when it succeeded. On `kept` this is why the
   * re-fetch failed, while the item keeps the content it already had.
   */
  failureReason: FailureReason | null;
  url: string;
  title: string | null;
  fetchMethod: string | null;
  wordCount: number | null;
}

interface ExistingItem {
  id: number;
  status: string;
  hasContent: boolean;
  wordCount: number | null;
}

async function findExisting(
  client: Client,
  url: string,
  raindropId?: number,
): Promise<ExistingItem | null> {
  const rs = await client.execute({
    sql: `SELECT i.id, i.status, c.item_id IS NOT NULL AS has_content, c.word_count
          FROM items i LEFT JOIN item_content c ON c.item_id = i.id
          WHERE i.url = ?${raindropId !== undefined ? " OR i.raindrop_id = ?" : ""}
          LIMIT 1`,
    args: raindropId !== undefined ? [url, raindropId] : [url],
  });
  const row = rs.rows[0];
  if (!row) return null;
  return {
    id: Number(row.id),
    status: String(row.status),
    hasContent: Boolean(row.has_content),
    wordCount: row.word_count != null ? Number(row.word_count) : null,
  };
}

async function refreshMetadata(
  client: Client,
  id: number,
  meta: IngestMeta,
  raindropId?: number,
): Promise<void> {
  await client.execute({
    sql: `UPDATE items SET
            title = COALESCE(?, title),
            author = COALESCE(?, author),
            published_at = COALESCE(?, published_at),
            raindrop_id = COALESCE(?, raindrop_id),
            updated_at = ?
          WHERE id = ?`,
    args: [
      meta.title ?? null,
      meta.author ?? null,
      meta.published ?? null,
      raindropId ?? null,
      nowIso(),
      id,
    ],
  });
}

async function writeContent(
  client: Client,
  itemId: number,
  content: string,
  replace = false,
): Promise<number> {
  const words = wordCount(content);
  const now = nowIso();
  const chunks = chunkMarkdown(content);
  await client.batch(
    [
      // The immutability trigger fires BEFORE UPDATE, so replacing content is
      // a delete-then-insert rather than an in-place edit. The batch is one
      // transaction, so an item is never left with no content row at all.
      // Dropping the row also clears its FTS entry, which the insert restores.
      ...(replace
        ? [{ sql: "DELETE FROM item_content WHERE item_id = ?", args: [itemId] }]
        : []),
      {
        sql: "INSERT INTO item_content (item_id, content, word_count, created_at) VALUES (?, ?, ?, ?)",
        args: [itemId, content, words, now],
      },
      { sql: "DELETE FROM chunks WHERE item_id = ?", args: [itemId] },
      ...chunks.map((chunk, seq) => ({
        sql: `INSERT INTO chunks (item_id, seq, content, word_count, chunking_version)
              VALUES (?, ?, ?, ?, ?)`,
        args: [itemId, seq, chunk, wordCount(chunk), CHUNKING_VERSION],
      })),
    ],
    "write",
  );
  return words;
}

/**
 * Report an item whose stored content this run left alone — either an
 * ordinary re-ingest (`refreshed`) or a forced re-fetch that failed and fell
 * back to what was already there (`kept`).
 */
async function existingResult(
  client: Client,
  id: number,
  canonical: string,
  action: Extract<IngestAction, "refreshed" | "kept">,
  failureReason: FailureReason | null = null,
): Promise<IngestResult> {
  const row = (
    await client.execute({
      sql: `SELECT i.title, i.status, i.fetch_method, c.word_count FROM items i
            LEFT JOIN item_content c ON c.item_id = i.id WHERE i.id = ?`,
      args: [id],
    })
  ).rows[0];
  return {
    id,
    action,
    // Read from the row rather than assumed: this run did not change it, and
    // `kept` is guarded on the item having content, not on it being `ok`.
    status: row?.status === "extraction_failed" ? "extraction_failed" : "ok",
    failureReason,
    url: canonical,
    title: row?.title != null ? String(row.title) : null,
    fetchMethod: row?.fetch_method != null ? String(row.fetch_method) : null,
    wordCount: row?.word_count != null ? Number(row.word_count) : null,
  };
}

interface UpsertParams {
  existing: ExistingItem | null;
  sourceType: string;
  url: string;
  originalUrl: string;
  domain: string | null;
  meta: IngestMeta;
  status: "ok" | "extraction_failed";
  failureReason: FailureReason | null;
  fetchMethod: string | null;
  raindropId?: number;
}

async function upsertItem(client: Client, p: UpsertParams): Promise<{ id: number; action: IngestAction }> {
  const now = nowIso();
  if (p.existing) {
    await client.execute({
      sql: `UPDATE items SET
              title = COALESCE(?, title),
              author = COALESCE(?, author),
              published_at = COALESCE(?, published_at),
              status = ?, failure_reason = ?, fetch_method = ?, fetched_at = ?,
              raindrop_id = COALESCE(?, raindrop_id),
              updated_at = ?
            WHERE id = ?`,
      args: [
        p.meta.title ?? null,
        p.meta.author ?? null,
        p.meta.published ?? null,
        p.status,
        p.failureReason,
        p.fetchMethod,
        now,
        p.raindropId ?? null,
        now,
        p.existing.id,
      ],
    });
    return { id: p.existing.id, action: "retried" };
  }
  const rs = await client.execute({
    sql: `INSERT INTO items
            (source_type, url, original_url, title, domain, author, published_at,
             status, failure_reason, fetch_method, fetched_at, raindrop_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      p.sourceType,
      p.url,
      p.originalUrl,
      p.meta.title ?? null,
      p.domain,
      p.meta.author ?? null,
      p.meta.published ?? null,
      p.status,
      p.failureReason,
      p.fetchMethod,
      now,
      p.raindropId ?? null,
      now,
      now,
    ],
  });
  return { id: Number(rs.lastInsertRowid), action: "created" };
}

export async function ingestUrl(
  client: Client,
  rawUrl: string,
  opts: IngestOptions = {},
): Promise<IngestResult> {
  const { canonical, domain } = canonicalizeUrl(rawUrl);
  const existing = await findExisting(client, canonical, opts.raindropId);
  // Only a forced re-fetch of an item that *has* content is a replacement.
  // Forcing an item that failed extraction is just the ordinary retry path.
  const replacing = Boolean(opts.force) && existing?.hasContent === true;

  // A known-good item is never re-fetched or mutated in its raw layer:
  // re-ingest just refreshes metadata and provenance. `--force` is the one
  // way past this, and it is never reached by a Raindrop sync.
  if (existing && existing.status === "ok" && existing.hasContent && !opts.force) {
    await refreshMetadata(client, existing.id, opts.meta ?? {}, opts.raindropId);
    return existingResult(client, existing.id, canonical, "refreshed");
  }

  const extracted = await (opts.extract ?? extractWeb)(rawUrl, opts.log);

  // The failure mode that makes force dangerous: a re-fetch that comes back
  // blocked, walled or empty must not cost the item the content it already
  // has. Repairing item 5 hit exactly this — one attempt returned the real
  // transcript and five returned a bot-block shell. Keep what we have and
  // report why, rather than trading a good document for a bad one.
  if (replacing && !extracted.ok) {
    opts.log?.(`re-fetch failed (${extracted.reason}); keeping the existing content`);
    return existingResult(client, existing!.id, canonical, "kept", extracted.reason);
  }

  const meta: IngestMeta = {
    title: opts.meta?.title ?? extracted.title,
    author: opts.meta?.author ?? extracted.author,
    published: opts.meta?.published ?? extracted.published,
  };
  const status = extracted.ok ? "ok" : "extraction_failed";
  const failureReason = extracted.ok ? null : extracted.reason;

  const { id, action } = await upsertItem(client, {
    existing,
    sourceType: opts.sourceType ?? "web",
    url: canonical,
    originalUrl: rawUrl,
    domain,
    meta,
    status,
    failureReason,
    fetchMethod: extracted.ok ? extracted.method : null,
    raindropId: opts.raindropId,
  });

  let words: number | null = null;
  if (extracted.ok) {
    words = await writeContent(client, id, extracted.content, replacing);
  }

  if (replacing && words != null) {
    const before = existing?.wordCount ?? 0;
    opts.log?.(`replaced content for #${id}: ${before} -> ${words} words`);
    // A replacement is the one operation here that destroys data, and a much
    // shorter document is the shape a bad swap takes. Not blocked — a genuine
    // repair can legitimately shrink an item (stripped boilerplate, a purged
    // data URI) — but never silent.
    if (before > 0 && words < before / 2) {
      opts.log?.(`warning: #${id} lost ${Math.round((1 - words / before) * 100)}% of its words`);
    }
    // Chunks were rebuilt from the new text, so any embeddings they carried
    // are gone with them. `embed --apply` backfills.
    opts.log?.(`#${id} needs re-embedding: run \`clipbase embed --apply\``);
  }

  return {
    id,
    action: replacing && extracted.ok ? "replaced" : action,
    status,
    failureReason,
    url: canonical,
    title: meta.title ?? null,
    fetchMethod: extracted.ok ? extracted.method : null,
    wordCount: words,
  };
}

export async function ingestPdf(
  client: Client,
  path: string,
  opts: Pick<IngestOptions, "log" | "force"> = {},
): Promise<IngestResult> {
  const absPath = resolve(path);
  const info = await stat(absPath).catch(() => null);
  if (!info?.isFile()) throw new Error(`PDF not found: ${absPath}`);

  const canonical = pathToFileURL(absPath).href;
  const existing = await findExisting(client, canonical);
  const replacing = Boolean(opts.force) && existing?.hasContent === true;
  if (existing && existing.status === "ok" && existing.hasContent && !opts.force) {
    await refreshMetadata(client, existing.id, {});
    return existingResult(client, existing.id, canonical, "refreshed");
  }

  opts.log?.(`extracting text from ${absPath}`);
  const pdf = await extractPdf(absPath);
  const ok = wordCount(pdf.content) >= PDF_MIN_WORDS;

  // Same guarantee as the web path: a re-extraction that yields nothing does
  // not cost the item the text it already had.
  if (replacing && !ok) {
    opts.log?.("re-extraction produced no text; keeping the existing content");
    return existingResult(client, existing!.id, canonical, "kept", "thin_content");
  }

  const meta: IngestMeta = { title: pdf.title, author: pdf.author };

  const { id, action } = await upsertItem(client, {
    existing,
    sourceType: "pdf",
    url: canonical,
    originalUrl: absPath,
    domain: null,
    meta,
    status: ok ? "ok" : "extraction_failed",
    // A PDF that parsed but yielded no text is a scan, not a fetch problem.
    failureReason: ok ? null : "thin_content",
    fetchMethod: ok ? "pdf" : null,
  });

  let words: number | null = null;
  if (ok) {
    words = await writeContent(client, id, pdf.content, replacing);
  }

  return {
    id,
    action: replacing && ok ? "replaced" : action,
    status: ok ? "ok" : "extraction_failed",
    failureReason: ok ? null : "thin_content",
    url: canonical,
    title: meta.title ?? null,
    fetchMethod: ok ? "pdf" : null,
    wordCount: words,
  };
}
