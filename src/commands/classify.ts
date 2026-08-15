// Deterministic form classification: what *kind* of thing an item is, derived
// from host and URL shape alone. No model call, no cost, same answer every run.
//
// Form is deliberately not subject matter. In this corpus nearly every item is
// about AI tooling, so a subject taxonomy needs a model to be useful — but
// "repo vs video vs product page" is both mechanical and the filter you
// actually reach for. Subject topics are the LLM pass that comes after.
//
// Tags are namespaced `form:*` so a later topical pass can add flat tags
// without colliding, and so a bad run is revertible with one prefix match.

import type { Client } from "../db.js";
import { attachTags, detachTags } from "../organize.js";

export const FORM_PREFIX = "form:";

const HOST_FORMS: Record<string, string> = {
  "github.com": "repo",
  "gist.github.com": "repo",
  "gitlab.com": "repo",
  "codeberg.org": "repo",
  "huggingface.co": "repo",
  "youtube.com": "video",
  "vimeo.com": "video",
  "reddit.com": "discussion",
  "news.ycombinator.com": "discussion",
  "lobste.rs": "discussion",
  "x.com": "discussion",
  "twitter.com": "discussion",
  "docs.google.com": "reference",
  "notion.so": "reference",
  "arxiv.org": "paper",
  "web.archive.org": "article",
};

const HOST_SUFFIX_FORMS: [suffix: string, form: string][] = [
  [".substack.com", "article"],
  [".medium.com", "article"],
  [".notion.site", "reference"],
  [".readthedocs.io", "reference"],
  [".gumroad.com", "product"],
];

const HOST_PREFIX_FORMS: [prefix: string, form: string][] = [
  ["docs.", "reference"],
  ["developer.", "reference"],
  ["developers.", "reference"],
  ["blog.", "article"],
  ["pub.", "article"],
];

export interface ClassifiableItem {
  id: number;
  source_type: string;
  url: string | null;
  domain: string | null;
}

/**
 * Precedence: PDFs are papers, then exact host, then suffix/prefix host rules,
 * then URL shape. A bare root path is a product/landing page — 57 of the 300
 * live items are exactly that, and calling them "articles" would be wrong.
 * Anything left with a real path is an article.
 */
export function classifyForm(item: ClassifiableItem): string {
  if (item.source_type === "pdf") return "paper";

  const host = (item.domain ?? "").toLowerCase();
  const exact = HOST_FORMS[host];
  if (exact) return exact;
  for (const [suffix, form] of HOST_SUFFIX_FORMS) if (host.endsWith(suffix)) return form;
  for (const [prefix, form] of HOST_PREFIX_FORMS) if (host.startsWith(prefix)) return form;

  if (item.url) {
    try {
      const path = new URL(item.url).pathname;
      if (path === "" || path === "/") return "product";
      if (/\.pdf$/i.test(path)) return "paper";
    } catch {
      // Unparseable url (a PDF's file:// form, say) — fall through to default.
    }
  }
  return "article";
}

export interface ClassifyResult {
  scanned: number;
  /** form -> number of items carrying it after this run */
  counts: Record<string, number>;
  changed: { id: number; from: string | null; to: string }[];
  applied: boolean;
}

export async function classify(
  client: Client,
  opts: { apply: boolean; log?: (msg: string) => void },
): Promise<ClassifyResult> {
  const log = opts.log ?? (() => {});
  const rs = await client.execute(
    `SELECT i.id, i.source_type, i.url, i.domain,
            (SELECT t.name FROM tags t
               JOIN item_tags it ON it.tag_id = t.id
              WHERE it.item_id = i.id AND t.name LIKE '${FORM_PREFIX}%'
              LIMIT 1) AS current_form
     FROM items i ORDER BY i.id`,
  );

  const counts: Record<string, number> = {};
  const changed: ClassifyResult["changed"] = [];
  for (const row of rs.rows) {
    const item: ClassifiableItem = {
      id: Number(row.id),
      source_type: String(row.source_type),
      url: row.url != null ? String(row.url) : null,
      domain: row.domain != null ? String(row.domain) : null,
    };
    const form = classifyForm(item);
    const tag = `${FORM_PREFIX}${form}`;
    counts[form] = (counts[form] ?? 0) + 1;

    const current = row.current_form != null ? String(row.current_form) : null;
    if (current === tag) continue;
    changed.push({ id: item.id, from: current, to: tag });
    if (!opts.apply) continue;

    // One form per item: drop a stale form tag before attaching the new one.
    if (current) await detachTags(client, item.id, [current]);
    await attachTags(client, item.id, [tag]);
  }

  if (opts.apply && changed.length) log(`tagged ${changed.length} item(s)`);
  return { scanned: rs.rows.length, counts, changed, applied: opts.apply };
}
