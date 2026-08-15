import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { applyMigrations } from "../src/migrate.js";
import type { WebExtract, FailureReason } from "../src/extract/web.js";

export async function makeTestClient(): Promise<Client> {
  const dir = mkdtempSync(join(tmpdir(), "clipbase-test-"));
  const client = createClient({ url: `file:${join(dir, "test.db")}` });
  await applyMigrations(client);
  return client;
}

export function richContent(marker = "alpha", words = 300): string {
  return `# Heading about ${marker}\n\n${`${marker} content word `.repeat(words / 3)}`;
}

// Medium's site footer as the corpus carries it: every link of item 458's
// block, in order, with the `?source=post_page-----0ae12dc18d3e------…` query
// shortened for width. The first and last are the ones the strip keys on.
const MEDIUM_FOOTER_LINKS: ReadonlyArray<readonly [string, string]> = [
  ["Help", "https://help.medium.com/hc/en-us?source=post_page-----0ae12dc18d3e--"],
  ["Status", "https://status.medium.com/?source=post_page-----0ae12dc18d3e--"],
  ["About", "https://medium.com/about?autoplay=1&source=post_page-----0ae12dc18d3e--"],
  ["Careers", "https://medium.com/jobs-at-medium/work-at-medium-959d1a85284e?source=post_page--"],
  ["Press", "mailto:pressinquiries@medium.com"],
  ["Blog", "https://blog.medium.com/?source=post_page-----0ae12dc18d3e--"],
  ["Store", "https://medium.com/store"],
  ["Privacy", "https://policy.medium.com/medium-privacy-policy-f03bf92035c9?source=post_page--"],
  ["Rules", "https://policy.medium.com/medium-rules-30e5502c4eb4?source=post_page--"],
  ["Terms", "https://policy.medium.com/medium-terms-of-service-9db0094a1e0f?source=post_page--"],
  ["Text to speech", "https://speechify.com/medium?source=post_page-----0ae12dc18d3e--"],
];

/**
 * The two shapes the same footer arrives in. firecrawl puts each link on one
 * line, defuddle breaks the label onto its own — 15 of the 37 affected items
 * are the first, 22 the second, so a fixture for one covers the smaller half.
 */
export function mediumFooter(shape: "firecrawl" | "defuddle"): string {
  return MEDIUM_FOOTER_LINKS.map(([label, href]) =>
    shape === "firecrawl" ? `[${label}](${href})` : `[\n\n${label}\n\n](${href})`,
  ).join("\n\n");
}

export function fakeExtractOk(content: string, title = "Fake Title") {
  return async (): Promise<WebExtract> => ({
    ok: true,
    method: "defuddle",
    content,
    title,
  });
}

export function fakeExtractFailWith(reason: FailureReason) {
  return async (): Promise<WebExtract> => ({ ok: false, reason });
}

export const fakeExtractFail = fakeExtractFailWith("thin_content");

export async function countRows(client: Client, table: string): Promise<number> {
  const rs = await client.execute(`SELECT count(*) AS n FROM ${table}`);
  return Number(rs.rows[0].n);
}
