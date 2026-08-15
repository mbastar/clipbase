// Subject-matter classification: topics + a one-line summary per item.
//
// The judgement half of organization (form is mechanical — see classify.ts).
// Runs through the already-authenticated Claude Code CLI rather than the API,
// so no ANTHROPIC_API_KEY is needed. Rationale, cost model, and fallbacks:
// docs/topic-taxonomy.md.

import { execFile } from "node:child_process";
import type { Client } from "../db.js";
import { setTopics, upsertTopic, setTopicDescription, setSummary } from "../organize.js";

/** Fixed, reviewable taxonomy. Changing this is a deliberate act — see the decision record. */
export const TOPICS: Record<string, string> = {
  "agent-frameworks":
    "Libraries, SDKs and runtimes you BUILD an agent with — not products, skills or commentary",
  "agent-orchestration":
    "Running many agents at once — multi-agent coordination, fleet control, parallel sandboxed runners",
  "agent-workspaces":
    "Shared surfaces where people and agents work together — agent workspaces, AI coworker products",
  "claude-code": "Claude Code specifically — skills, subagents, plugins, workflows",
  mcp: "Model Context Protocol servers, clients, registries, inspectors",
  "memory-and-context": "Agent memory, RAG, context engineering, knowledge stores",
  prompting: "Prompt engineering, system prompts, prompt libraries",
  "coding-agents": "AI coding assistants, code generation, agentic coding practice",
  "automation-and-nocode": "n8n, Make, Zapier, visual workflow automation",
  "infra-and-sandboxes": "Hosting, sandboxes, containers, VMs, deploy for AI workloads",
  "content-generation": "AI video/audio/image/writing generation and content systems",
  "business-and-strategy": "AI business models, productization, monetization, careers",
  "llm-fundamentals": "How LLMs work — research papers, architecture, explainers, evaluation",
  "developer-tools": "General developer tooling not specific to AI",
  "productivity-and-collab":
    "Productivity, collaboration and self-hosted app suites — notes, tasks, CRM, docs",
};

const EXCERPT_CHARS = 300;
const CLI_TIMEOUT_MS = 300_000;

interface Candidate {
  id: number;
  title: string | null;
  domain: string | null;
  excerpt: string;
}

interface Classification {
  id: number;
  topics: string[];
  summary: string;
}

function buildPrompt(items: Candidate[]): string {
  const topicLines = Object.entries(TOPICS)
    .map(([slug, description]) => `- ${slug}: ${description}`)
    .join("\n");
  const itemLines = items
    .map((i) => {
      const head = `id=${i.id} | ${i.domain ?? "-"} | ${i.title ?? "(untitled)"}`;
      return i.excerpt ? `${head}\n    ${i.excerpt}` : head;
    })
    .join("\n");

  return `You are classifying items in a personal knowledge base. The corpus is mostly AI/agent tooling, with a tail of general developer tools and unrelated SaaS.

Assign each item 1-3 topics from this FIXED list. Use the exact slugs. If an item genuinely fits none, return an empty array — do NOT force a bad fit.

${topicLines}

Also write a one-sentence summary (max 25 words) describing what the item IS. No marketing language.

Return ONLY a JSON array, no prose, no markdown fence:
[{"id":<int>,"topics":["slug",...],"summary":"..."}]

ITEMS:
${itemLines}`;
}

function runClaude(prompt: string, model: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "claude",
      ["-p", "--model", model, "--output-format", "json"],
      { timeout: CLI_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          const hint =
            (err as NodeJS.ErrnoException).code === "ENOENT"
              ? "the `claude` CLI is not on PATH (see docs/topic-taxonomy.md for the API-key alternative)"
              : err.message;
          reject(new Error(`claude -p failed: ${hint}`));
          return;
        }
        resolve(stdout);
      },
    );
    child.stdin?.end(prompt);
  });
}

/** The CLI wraps the model's reply in an envelope, and the reply itself often arrives fenced. */
function parseReply(stdout: string): Classification[] {
  let envelope: { result?: string; is_error?: boolean };
  try {
    envelope = JSON.parse(stdout);
  } catch {
    throw new Error(`claude -p returned non-JSON: ${stdout.slice(0, 200)}`);
  }
  if (envelope.is_error || typeof envelope.result !== "string") {
    throw new Error(`claude -p reported an error: ${stdout.slice(0, 200)}`);
  }
  const body = envelope.result.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`model reply was not JSON: ${body.slice(0, 200)}`);
  }
  if (!Array.isArray(parsed)) throw new Error("model reply was not a JSON array");
  return parsed as Classification[];
}

/** Exported for testing: the selection rule is the part worth pinning down. */
export async function loadCandidates(
  client: Client,
  opts: { all: boolean; limit: number; ids?: number[] },
): Promise<Candidate[]> {
  // Only items with content can be classified; extraction_failed rows have none.
  //
  // "Already processed" is the presence of an annotation, NOT of a topic. The
  // model may legitimately decline to place an item, and a summary is written
  // either way — so gating on item_topics would re-send every declined item on
  // every run, spending tokens to receive the same empty answer forever.
  //
  // Named ids override both rules. A truncated batch strands its items on
  // whatever they already carried, and without this the only way to reach them
  // again is `--all`, which re-bills the whole corpus to repair twelve rows.
  const where = opts.ids?.length
    ? `WHERE i.id IN (${opts.ids.map(() => "?").join(",")})`
    : opts.all
      ? ""
      : "WHERE NOT EXISTS (SELECT 1 FROM item_annotations a WHERE a.item_id = i.id)";
  const rs = await client.execute({
    sql: `SELECT i.id, i.title, i.domain, substr(c.content, 1, ?) AS excerpt
          FROM items i JOIN item_content c ON c.item_id = i.id
          ${where}
          ORDER BY i.id
          LIMIT ?`,
    args: [EXCERPT_CHARS, ...(opts.ids ?? []), opts.limit],
  });
  return rs.rows.map((r) => ({
    id: Number(r.id),
    title: r.title != null ? String(r.title) : null,
    domain: r.domain != null ? String(r.domain) : null,
    // Collapse whitespace: markdown newlines waste tokens and hurt nothing when flattened.
    excerpt: String(r.excerpt ?? "")
      .replace(/\s+/g, " ")
      .trim(),
  }));
}

export interface EnrichResult {
  scanned: number;
  classified: number;
  /** Items the model declined to place — the review queue for taxonomy gaps. */
  unclassified: number[];
  /** Slugs the model invented; dropped rather than written. */
  rejected: string[];
  /** Topics detached because the re-classification no longer claimed them. */
  removed: number;
  batches: number;
  failures: { batch: number; error: string }[];
  applied: boolean;
}

export async function enrich(
  client: Client,
  opts: {
    apply: boolean;
    all: boolean;
    limit: number;
    ids?: number[];
    batchSize: number;
    model: string;
    log?: (msg: string) => void;
  },
): Promise<EnrichResult> {
  const log = opts.log ?? (() => {});
  const candidates = await loadCandidates(client, {
    all: opts.all,
    limit: opts.limit,
    ids: opts.ids,
  });

  const result: EnrichResult = {
    scanned: candidates.length,
    classified: 0,
    unclassified: [],
    rejected: [],
    removed: 0,
    batches: 0,
    failures: [],
    applied: opts.apply,
  };
  // Seeding runs before the early return: syncing the taxonomy is not
  // conditional on there being items left to classify, so a re-worded
  // description reaches the corpus on the next apply run rather than waiting
  // for one that happens to have candidates.
  if (opts.apply) {
    for (const [slug, description] of Object.entries(TOPICS)) {
      await upsertTopic(client, slug, description);
      await setTopicDescription(client, slug, description);
    }
  }

  if (!candidates.length) return result;

  for (let start = 0; start < candidates.length; start += opts.batchSize) {
    const batch = candidates.slice(start, start + opts.batchSize);
    const batchNo = ++result.batches;
    log(`batch ${batchNo}: ${batch.length} item(s) (#${batch[0].id}–#${batch[batch.length - 1].id})`);

    let classifications: Classification[];
    try {
      classifications = parseReply(await runClaude(buildPrompt(batch), opts.model));
    } catch (err) {
      // One bad batch must not lose the rest of the run.
      result.failures.push({ batch: batchNo, error: (err as Error).message });
      log(`batch ${batchNo} failed: ${(err as Error).message}`);
      continue;
    }

    const inBatch = new Set(batch.map((b) => b.id));
    for (const c of classifications) {
      if (!inBatch.has(c.id)) continue; // ignore ids the model hallucinated into the reply
      const topics = (Array.isArray(c.topics) ? c.topics : []).filter((slug) => {
        if (slug in TOPICS) return true;
        if (!result.rejected.includes(slug)) result.rejected.push(slug);
        return false;
      });
      if (!topics.length) result.unclassified.push(c.id);
      if (opts.apply) {
        // setTopics, not attachTopics: the model's answer is the item's whole
        // topic set, so a tightened description can take a label away again.
        if (topics.length) result.removed += (await setTopics(client, c.id, topics)).length;
        if (typeof c.summary === "string" && c.summary.trim()) {
          await setSummary(client, c.id, c.summary.trim());
        }
      }
      result.classified++;
    }
  }

  return result;
}
