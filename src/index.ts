#!/usr/bin/env node
import { Command } from "commander";
import { getClient, getReplicaClient, type Client } from "./db.js";
import { getStatus, formatStatus, getCorpusAge, formatStaleBanner } from "./commands/status.js";
import { reconcile, formatReconcile } from "./commands/reconcile.js";
import { applyMigrations } from "./migrate.js";
import { ingestUrl, ingestPdf, type IngestResult } from "./ingest.js";
import { syncRaindrop, syncAll, type SyncAllResult } from "./raindrop.js";
import { searchItems, searchSemantic, searchHybrid } from "./commands/search.js";
import { loadQuerySpecs, runEval, formatReport } from "./commands/eval.js";
import { resolveCollection } from "./commands/eval-collection.js";
import {
  buildPool,
  poolEvidence,
  formatPool,
  formatEvidence,
  POOL_DEPTH,
} from "./commands/pool.js";
import { judgePool, toQuerySpecs, formatAgreement } from "./commands/judge.js";
import { listItems } from "./commands/list.js";
import { showItem } from "./commands/show.js";
import { recanonicalize } from "./commands/recanonicalize.js";
import { rechunk } from "./commands/rechunk.js";
import { embedChunks } from "./commands/embed.js";
import { classify, FORM_PREFIX } from "./commands/classify.js";
import { enrich } from "./commands/enrich.js";
import {
  attachTags,
  detachTags,
  attachTopics,
  upsertTopic,
  setSummary,
  addLink,
  listTags,
  listTopics,
} from "./organize.js";

// Progress goes to stderr so --json stdout is always clean machine output.
const log = (msg: string) => process.stderr.write(`${msg}\n`);

function printJson(data: unknown): void {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

function run<A extends unknown[]>(
  fn: (...args: A) => Promise<void>,
): (...args: A) => Promise<void> {
  return async (...args: A) => {
    try {
      await fn(...args);
    } catch (err) {
      process.stderr.write(`error: ${(err as Error).message}\n`);
      process.exitCode = 1;
    }
  };
}

/**
 * Annotate a read with the corpus's age, but only when it is stale enough to
 * change how the answer should be taken.
 *
 * Swallows its own failures on purpose. This is a diagnostic wrapped around
 * someone else's answer, and a diagnostic that can break the command it
 * annotates is worse than no diagnostic at all.
 */
async function warnIfStale(client: Client): Promise<void> {
  try {
    const banner = formatStaleBanner(await getCorpusAge(client));
    if (banner) log(banner);
  } catch {
    // Non-fatal by design — see above.
  }
}

function reportIngest(result: IngestResult, json: boolean): void {
  // `kept` leaves the item healthy, but the re-fetch the operator asked for
  // did not happen — exiting 0 would hide that from a bulk repair loop.
  if (result.status === "extraction_failed" || result.action === "kept") process.exitCode = 1;
  if (json) {
    printJson(result);
    return;
  }
  const words = result.wordCount != null ? `, ${result.wordCount} words` : "";
  const method = result.fetchMethod ? ` via ${result.fetchMethod}` : "";
  const why = result.failureReason ? `: ${result.failureReason}` : "";
  console.log(
    `#${result.id} ${result.action} (${result.status}${why}${method}${words}) ${result.title ?? result.url}`,
  );
}

const program = new Command();
program.name("clipbase").description("personal knowledge base on Turso");

program
  .command("migrate")
  .description("apply pending SQL migrations")
  .action(
    run(async () => {
      const ran = await applyMigrations(getClient(), (name) => log(`applying ${name}`));
      console.log(ran.length ? `applied: ${ran.join(", ")}` : "already up to date");
    }),
  );

program
  .command("ingest")
  .description("ingest a web URL or a local PDF")
  .argument("[url]", "web URL to ingest")
  .option("--pdf <path>", "ingest a local PDF instead of a URL")
  .option("--force", "re-fetch and replace the stored content of a known-good item")
  .option("--json", "machine-readable output")
  .action(
    run(async (url?: string, opts?: { pdf?: string; force?: boolean; json?: boolean }) => {
      const client = getClient();
      if (opts?.pdf && url) throw new Error("pass either a URL or --pdf <path>, not both");
      if (!opts?.pdf && !url) throw new Error("nothing to ingest: pass a URL or --pdf <path>");
      const force = Boolean(opts?.force);
      const result = opts?.pdf
        ? await ingestPdf(client, opts.pdf, { log, force })
        : await ingestUrl(client, url!, { log, force });
      reportIngest(result, Boolean(opts?.json));
    }),
  );

program
  .command("sync-raindrop")
  .description("pull new bookmarks from a Raindrop.io collection")
  .requiredOption("--collection <idOrName>", "Raindrop collection id or name")
  .option("--json", "machine-readable output")
  .action(
    run(async (opts: { collection: string; json?: boolean }) => {
      const client = getClient(); // also loads .env
      const token = process.env.RAINDROP_TOKEN;
      if (!token) throw new Error("RAINDROP_TOKEN is not set (see .env.example)");
      const result = await syncRaindrop(client, token, opts.collection, { log });
      if (opts.json) {
        printJson(result);
      } else {
        console.log(
          `synced "${result.collectionTitle}": ${result.scanned} new — ` +
            `${result.created} created, ${result.refreshed} refreshed, ${result.retried} retried, ` +
            `${result.extractionFailed} failed extraction, ${result.skippedInvalid} skipped`,
        );
      }
    }),
  );

// One line per collection, dot-leadered to a common column so thirteen of them
// scan as a column of numbers rather than thirteen sentences.
function reportSyncAll(result: SyncAllResult): void {
  const rows = [
    ...result.synced.map((r) => ({
      title: r.collectionTitle,
      detail:
        `${r.created} new` +
        (r.extractionFailed ? `, ${r.extractionFailed} failed extraction` : "") +
        (r.skippedInvalid ? `, ${r.skippedInvalid} skipped` : ""),
    })),
    ...result.failed.map((f) => ({ title: f.collectionTitle, detail: `unreachable: ${f.error}` })),
  ];
  const width = Math.max(...rows.map((r) => r.title.length));
  for (const row of rows) {
    console.log(`  ${row.title} ${".".repeat(width - row.title.length + 3)} ${row.detail}`);
  }
  const { totals } = result;
  const parts = [`${totals.created} new`];
  if (totals.extractionFailed) parts.push(`${totals.extractionFailed} failed extraction`);
  if (totals.skippedInvalid) parts.push(`${totals.skippedInvalid} skipped`);
  if (result.failed.length) parts.push(`${result.failed.length} unreachable`);
  console.log(`\n${result.synced.length + result.failed.length} collections: ${parts.join(", ")}`);
}

program
  .command("sync-all")
  .description("pull new bookmarks for every collection already tracked in sync_state")
  .option("--json", "machine-readable output")
  .action(
    run(async (opts: { json?: boolean }) => {
      const client = getClient(); // also loads .env
      const token = process.env.RAINDROP_TOKEN;
      if (!token) throw new Error("RAINDROP_TOKEN is not set (see .env.example)");
      const result = await syncAll(client, token, { log });
      // An unreachable collection is a partial sync, and a scheduled run that
      // exits 0 on one is a sync that quietly stops happening.
      if (result.failed.length > 0) process.exitCode = 1;
      if (opts.json) {
        printJson(result);
      } else {
        reportSyncAll(result);
      }
    }),
  );

program
  .command("search")
  .description("full-text search over titles and content")
  .argument("<query>", "search query (treated as literal words, ORed)")
  .option("--limit <n>", "max results", "10")
  .option("--semantic", "rank by meaning over chunk embeddings instead of FTS")
  .option("--hybrid", "fuse keyword and semantic rankings (RRF)")
  .option("--json", "machine-readable output")
  .action(
    run(
      async (
        query: string,
        opts: { limit: string; semantic?: boolean; hybrid?: boolean; json?: boolean },
      ) => {
        const limit = parseLimit(opts.limit);
        if (opts.semantic && opts.hybrid) {
          throw new Error("--semantic and --hybrid pick different rankers; pass one");
        }
        // Anything reading embeddings scans them all, which is ~10ms locally and
        // ~15s against remote Turso, so those paths use the embedded replica.
        const client =
          opts.hybrid || opts.semantic ? await getReplicaClient() : getClient();
        const hits = opts.hybrid
          ? await searchHybrid(client, query, limit)
          : opts.semantic
            ? await searchSemantic(client, query, limit)
            : await searchItems(client, query, limit);
        // Before the results, not after: a warning below the answer is read
        // second or not at all, and this one changes how the answer should be
        // taken. Goes to stderr, so --json stdout stays a clean array.
        await warnIfStale(client);
        if (opts.json) {
          printJson(hits);
          return;
        }
        if (!hits.length) {
          console.log("no results");
          return;
        }
        for (const h of hits) {
          console.log(`#${h.id} [${h.score}] ${h.title ?? h.url} (${h.domain ?? h.source_type})`);
          console.log(`    ${h.snippet.replaceAll("\n", " ")}`);
        }
      },
    ),
  );

program
  .command("eval")
  .description("measure FTS, semantic and hybrid retrieval over a labelled query set")
  .option("--queries <path>", "JSONL query set (query, gold ids, note)", "eval/queries.jsonl")
  .option("--k <n>", "results per query to score", "10")
  // Scoring is pinned to what pooling already covered; the default comes from
  // the query set's sibling .collection.json. Pooling is what extends the
  // collection, so `eval-pool` and `eval-judge` stay uncapped on purpose —
  // capping them would make it impossible to judge the items above the ceiling.
  .option("--collection <n|all>", "override the judged collection ceiling ('all' scores the whole corpus)")
  .option("--json", "machine-readable output")
  .action(
    run(async (opts: { queries: string; k: string; collection?: string; json?: boolean }) => {
      const specs = await loadQuerySpecs(opts.queries);
      const collection = await resolveCollection(opts.queries, opts.collection);
      const k = parseLimit(opts.k);
      // Every method reads through the embedded replica: all three scored
      // against identical rows, and no remote round trips per query.
      const report = await runEval(await getReplicaClient(), specs, k, { collection });
      if (opts.json) {
        printJson(report);
        return;
      }
      console.log(formatReport(report));
    }),
  );

program
  .command("eval-pool")
  .description("build the candidate pool a judge works through, for re-judging gold")
  .option("--queries <path>", "JSONL query set (query, gold ids, note)", "eval/queries.jsonl")
  .option("--depth <n>", "results per ranker in the union", String(POOL_DEPTH))
  .option("--query <n>", "show matched passages for one query index, with --ids")
  .option("--ids <list>", "comma-separated item ids to show evidence for")
  .option("--json", "machine-readable output")
  .action(
    run(
      async (opts: {
        queries: string;
        depth: string;
        query?: string;
        ids?: string;
        json?: boolean;
      }) => {
        const specs = await loadQuerySpecs(opts.queries);
        const client = await getReplicaClient();

        // Evidence mode: the passages behind a judgement, for the ids being ruled
        // on. Titles are what got the gold mis-judged the first time.
        if (opts.ids) {
          if (opts.query === undefined) {
            throw new Error("--ids needs --query <n> to say which query to match against");
          }
          const index = Number(opts.query);
          if (!Number.isInteger(index) || index < 0 || index >= specs.length) {
            throw new Error(`--query must be 0..${specs.length - 1}`);
          }
          const ids = opts.ids
            .split(",")
            .map((s) => Number(s.trim()))
            .filter((n) => Number.isInteger(n) && n > 0);
          if (!ids.length) throw new Error("--ids listed no valid item ids");
          const { query } = specs[index];
          const evidence = await poolEvidence(client, query, ids);
          if (opts.json) {
            printJson({ query, evidence });
            return;
          }
          console.log(formatEvidence(query, evidence));
          return;
        }

        const report = await buildPool(client, specs, parseLimit(opts.depth));
        if (opts.json) {
          printJson(report);
          return;
        }
        console.log(formatPool(report));
      },
    ),
  );

program
  .command("eval-judge")
  .description("grade pooled candidates against their content via the claude CLI (no API key)")
  .option("--queries <path>", "JSONL query set (query, gold ids, note)", "eval/queries.jsonl")
  .option(
    "--validate",
    "score the run against the human grades (batches stay production-shaped; only scoring narrows)",
  )
  .option("--anchors <n>", "worked examples per grade, shown ahead of the task to fix the scale", "0")
  .option("--depth <n>", "results per ranker in the union", String(POOL_DEPTH))
  .option("--limit <n>", "max queries to process — cost scales with this", "30")
  .option("--batch <n>", "candidates per model call", "20")
  .option("--model <model>", "model for the judge", "claude-sonnet-5")
  .option("--json", "machine-readable output")
  .action(
    run(
      async (opts: {
        queries: string;
        validate?: boolean;
        anchors: string;
        depth: string;
        limit: string;
        batch: string;
        model: string;
        json?: boolean;
      }) => {
        const specs = await loadQuerySpecs(opts.queries);
        const result = await judgePool(await getReplicaClient(), specs, {
          validate: Boolean(opts.validate),
          anchorsPerGrade: Number(opts.anchors) || 0,
          depth: parseLimit(opts.depth),
          limit: parseLimit(opts.limit),
          batchSize: parseLimit(opts.batch),
          model: opts.model,
          log: (msg) => console.error(msg),
        });

        // Validation reports agreement and stops. Its judgements are of items
        // already judged, so writing them over the gold would just overwrite
        // human work with a copy of itself.
        if (opts.validate) {
          if (opts.json) printJson(result);
          else console.log(formatAgreement(result));
          return;
        }

        // A full run emits a proposed query set on stdout and never edits the
        // file in place: replacing gold is a reviewed act, so this is piped to a
        // new file and diffed, not applied.
        const proposed = toQuerySpecs(specs, result);
        if (opts.json) {
          printJson({
            proposed,
            failures: result.failures,
            batches: result.batches,
            unjudged: result.unjudged,
          });
        } else {
          for (const spec of proposed) console.log(JSON.stringify(spec));
        }
        // An ungraded candidate is absent from the proposed set, which reads
        // identically to one judged irrelevant. Never let that pass silently —
        // and check it on BOTH output paths, since --json returning early is
        // how a run with 13 ungraded candidates once exited 0.
        if (result.failures.length || result.unjudged) {
          console.error(
            `${result.failures.length} batch(es) failed, ${result.unjudged} candidate(s) ungraded` +
              ` — the set is incomplete, and a missing item is not a verdict`,
          );
          process.exitCode = 1;
        }
      },
    ),
  );

program
  .command("list")
  .description("recent items")
  .option("--source-type <type>", "filter by source_type (web|pdf|raindrop)")
  .option("--status <status>", "filter by status (ok|extraction_failed)")
  .option("--limit <n>", "max rows", "20")
  .option("--json", "machine-readable output")
  .action(
    run(async (opts: { sourceType?: string; status?: string; limit: string; json?: boolean }) => {
      const rows = await listItems(getClient(), {
        sourceType: opts.sourceType,
        status: opts.status,
        limit: parseLimit(opts.limit),
      });
      if (opts.json) {
        printJson(rows);
        return;
      }
      if (!rows.length) {
        console.log("no items");
        return;
      }
      for (const r of rows) {
        const words = r.word_count != null ? `${r.word_count}w` : "-";
        const status = r.failure_reason ? `${r.status}:${r.failure_reason}` : r.status;
        console.log(
          `#${r.id}\t${r.source_type}\t${status}\t${words}\t${r.created_at.slice(0, 10)}\t${r.title ?? r.url}`,
        );
      }
    }),
  );

program
  .command("show")
  .description("full record for one item")
  .argument("<id>", "item id")
  .option("--json", "machine-readable output")
  .option("--no-content", "omit the stored document, leaving the record and its annotations")
  .action(
    run(async (idArg: string, opts: { json?: boolean; content?: boolean }) => {
      const id = Number(idArg);
      if (!Number.isInteger(id) || id <= 0) throw new Error(`invalid item id: ${idArg}`);
      const result = await showItem(getClient(), id, { content: opts.content });
      if (opts.json) {
        printJson(result);
        return;
      }
      for (const [key, value] of Object.entries(result.item)) {
        console.log(`${key}: ${value ?? ""}`);
      }
      console.log(`chunks: ${result.chunk_count}`);
      if (result.summary) console.log(`summary: ${result.summary}`);
      if (result.topics.length) console.log(`topics: ${result.topics.join(", ")}`);
      if (result.tags.length) console.log(`tags: ${result.tags.join(", ")}`);
      if (result.content) console.log(`\n${result.content}`);
    }),
  );

program
  .command("recanonicalize")
  .description("re-derive canonical urls with the current rules and merge duplicates")
  .option("--apply", "write the changes (default is a dry run)")
  .option("--json", "machine-readable output")
  .action(
    run(async (opts: { apply?: boolean; json?: boolean }) => {
      const result = await recanonicalize(getClient(), { apply: Boolean(opts.apply), log });
      if (opts.json) {
        printJson(result);
        return;
      }
      const verb = result.applied ? "applied" : "dry run";
      console.log(`${verb}: scanned ${result.scanned} items`);
      for (const m of result.merges) {
        console.log(`  merge #${m.drop.join(", #")} -> #${m.keep}  ${m.canonical}`);
      }
      for (const r of result.rewrites) {
        console.log(`  rewrite #${r.id}\n    ${r.from}\n    ${r.to}`);
      }
      if (!result.merges.length && !result.rewrites.length) console.log("  nothing to change");
      if (!result.applied && (result.merges.length || result.rewrites.length)) {
        console.log("re-run with --apply to write");
      }
    }),
  );

program
  .command("rechunk")
  .description("re-derive chunks from stored content with the current chunking rules")
  .option("--apply", "write the changes (default is a dry run)")
  .option("--json", "machine-readable output")
  .action(
    run(async (opts: { apply?: boolean; json?: boolean }) => {
      const result = await rechunk(getClient(), { apply: Boolean(opts.apply), log });
      if (opts.json) {
        printJson(result);
        return;
      }
      const verb = result.applied ? "applied" : "dry run";
      console.log(`${verb}: scanned ${result.scanned} items with content`);
      for (const c of result.changes) {
        console.log(`  rechunk #${c.itemId}  ${c.from} -> ${c.to} chunk(s)`);
      }
      if (result.restamped) {
        console.log(`  restamp ${result.restamped} item(s) already at the current shape`);
      }
      if (!result.changes.length && !result.restamped) console.log("  nothing to change");
      if (!result.applied && (result.changes.length || result.restamped)) {
        console.log("re-run with --apply to write");
      }
    }),
  );

program
  .command("embed")
  .description("embed chunks that have no current vector")
  .option("--apply", "call the provider and write vectors (default is a dry run)")
  .option("--limit <n>", "only embed the first n pending chunks")
  .option("--json", "machine-readable output")
  .action(
    run(async (opts: { apply?: boolean; limit?: string; json?: boolean }) => {
      const result = await embedChunks(getClient(), {
        apply: Boolean(opts.apply),
        limit: opts.limit != null ? parseLimit(opts.limit) : undefined,
        log,
      });
      if (opts.json) {
        printJson(result);
        return;
      }
      if (!result.applied) {
        console.log(`dry run: ${result.pending} chunk(s) pending`);
        if (result.pending) console.log("re-run with --apply to embed (this spends credits)");
        return;
      }
      console.log(`applied: embedded ${result.embedded} chunk(s), ${result.tokens} token(s)`);
    }),
  );

program
  .command("classify")
  .description("derive form:* tags (repo|video|article|product|reference|discussion|paper)")
  .option("--apply", "write the tags (default is a dry run)")
  .option("--json", "machine-readable output")
  .action(
    run(async (opts: { apply?: boolean; json?: boolean }) => {
      const result = await classify(getClient(), { apply: Boolean(opts.apply), log });
      if (opts.json) {
        printJson(result);
        return;
      }
      console.log(`${result.applied ? "applied" : "dry run"}: scanned ${result.scanned} items`);
      for (const [form, n] of Object.entries(result.counts).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${String(n).padStart(4)}  ${FORM_PREFIX}${form}`);
      }
      console.log(`  ${result.changed.length} item(s) to change`);
      if (!result.applied && result.changed.length) console.log("re-run with --apply to write");
    }),
  );

program
  .command("enrich")
  .description("assign subject topics and summaries via the claude CLI (no API key)")
  .option("--apply", "write the topics and summaries (default is a dry run)")
  .option("--all", "re-classify every item, not just those without topics")
  .option("--limit <n>", "max items to process", "1000")
  .option("--ids <list>", "re-classify exactly these item ids (comma-separated), ignoring --all")
  .option("--batch <n>", "items per model call — cost scales with call count", "20")
  .option("--model <model>", "model for the classifier", "claude-sonnet-5")
  .option("--json", "machine-readable output")
  .action(
    run(
      async (opts: {
        apply?: boolean;
        all?: boolean;
        limit: string;
        ids?: string;
        batch: string;
        model: string;
        json?: boolean;
      }) => {
        const ids = opts.ids ? parseIdList(opts.ids) : undefined;
        const result = await enrich(getClient(), {
          apply: Boolean(opts.apply),
          all: Boolean(opts.all),
          limit: parseLimit(opts.limit),
          ids,
          batchSize: parseLimit(opts.batch),
          model: opts.model,
          log,
        });
        if (opts.json) {
          printJson(result);
          return;
        }
        console.log(
          `${result.applied ? "applied" : "dry run"}: ${result.classified}/${result.scanned} ` +
            `item(s) classified in ${result.batches} batch(es)`,
        );
        if (result.unclassified.length) {
          console.log(
            `  ${result.unclassified.length} fit no topic: #${result.unclassified.join(", #")}`,
          );
        }
        if (result.removed) {
          console.log(`  ${result.removed} stale topic(s) detached by the re-classification`);
        }
        if (ids && result.scanned < ids.length) {
          // Silence here would read as "classified", when the id was wrong or
          // names one of the extraction walls that has no text to send.
          console.log(
            `  ${ids.length - result.scanned} of ${ids.length} id(s) had no content to classify`,
          );
        }
        if (result.rejected.length) {
          console.log(`  dropped invented slug(s): ${result.rejected.join(", ")}`);
        }
        for (const f of result.failures) console.log(`  batch ${f.batch} failed: ${f.error}`);
        if (!result.applied && result.classified) console.log("re-run with --apply to write");
      },
    ),
  );

program
  .command("tag")
  .description("attach tags to an item")
  .argument("<id>", "item id")
  .argument("<names...>", "tag names")
  .option("--remove", "detach the named tags instead")
  .action(
    run(async (idArg: string, names: string[], opts: { remove?: boolean }) => {
      const client = getClient();
      const id = parseItemId(idArg);
      if (opts.remove) {
        const removed = await detachTags(client, id, names);
        console.log(`#${id}: removed ${removed} tag(s)`);
        return;
      }
      const added = await attachTags(client, id, names);
      console.log(added.length ? `#${id}: tagged ${added.join(", ")}` : `#${id}: no new tags`);
    }),
  );

program
  .command("topic")
  .description("attach topics to an item, or define one with --describe")
  .argument("<idOrName>", "item id, or topic name when using --describe")
  .argument("[names...]", "topic names")
  .option("--describe <text>", "define a topic instead of attaching one")
  .action(
    run(async (idOrName: string, names: string[], opts: { describe?: string }) => {
      const client = getClient();
      if (opts.describe) {
        await upsertTopic(client, idOrName, opts.describe);
        console.log(`topic "${idOrName.trim().toLowerCase()}" defined`);
        return;
      }
      if (!names.length) throw new Error("pass topic names, or --describe to define a topic");
      const id = parseItemId(idOrName);
      const added = await attachTopics(client, id, names);
      console.log(added.length ? `#${id}: topics ${added.join(", ")}` : `#${id}: no new topics`);
    }),
  );

program
  .command("summarize")
  .description("set an item's agent summary")
  .argument("<id>", "item id")
  .argument("<text>", "summary text")
  .action(
    run(async (idArg: string, text: string) => {
      await setSummary(getClient(), parseItemId(idArg), text);
      console.log(`#${idArg}: summary set`);
    }),
  );

program
  .command("link")
  .description("draw a typed edge between two items")
  .argument("<fromId>", "source item id")
  .argument("<toId>", "target item id")
  .option("--type <type>", "link type (related|contradicts|expands_on)", "related")
  .option("--note <text>", "why the edge exists")
  .action(
    run(async (fromArg: string, toArg: string, opts: { type: string; note?: string }) => {
      const from = parseItemId(fromArg);
      const to = parseItemId(toArg);
      await addLink(getClient(), from, to, opts.type, opts.note);
      console.log(`#${from} -[${opts.type}]-> #${to}`);
    }),
  );

program
  .command("tags")
  .description("all tags with item counts")
  .option("--json", "machine-readable output")
  .action(
    run(async (opts: { json?: boolean }) => {
      const rows = await listTags(getClient());
      if (opts.json) return printJson(rows);
      if (!rows.length) return console.log("no tags");
      for (const r of rows) console.log(`${String(r.item_count).padStart(4)}  ${r.name}`);
    }),
  );

program
  .command("status")
  .description("corpus health: items, embeds, annotations, and how stale the sync is")
  .option("--json", "machine-readable output")
  .action(
    run(async (opts: { json?: boolean }) => {
      const status = await getStatus(getClient());
      if (opts.json) return printJson(status);
      console.log(formatStatus(status));
    }),
  );

program
  .command("reconcile")
  .description("find bookmarks Raindrop holds that the sync cursor never reached")
  .option("--json", "machine-readable output")
  .addHelpText(
    "after",
    [
      "",
      "Exit codes:",
      "  0  checked, every remote bookmark is present",
      "  1  the check itself failed (missing credential, API unreachable) — result unknown",
      "  2  the check ran and found a gap: bookmarks absent, and/or collections not reached",
      "",
      "0 and 2 are both answers; 1 is the absence of one. A caller that treats any",
      "non-zero as failure will report a working check as broken.",
      "",
    ].join("\n"),
  )
  .action(
    run(async (opts: { json?: boolean }) => {
      const client = getClient(); // also loads .env
      const token = process.env.RAINDROP_TOKEN;
      if (!token) throw new Error("RAINDROP_TOKEN is not set (see .env.example)");
      const result = await reconcile(client, token);
      // A gap is a finding, not a failure, and the two need separate codes: a
      // scheduled caller must escalate a crash loudly and a gap calmly. run()
      // already owns 1 for anything thrown, so a finding takes 2. Collapsing
      // them means "nothing is stranded" and "we never found out" look alike —
      // which is the exact confusion this command exists to remove.
      if (result.absent.length > 0 || result.unreachable.length > 0) process.exitCode = 2;
      if (opts.json) return printJson(result);
      console.log(formatReconcile(result));
    }),
  );

program
  .command("topics")
  .description("all topics with item counts")
  .option("--json", "machine-readable output")
  .action(
    run(async (opts: { json?: boolean }) => {
      const client = getClient();
      const rows = await listTopics(client);
      // topics is the "does this corpus cover X at all" oracle — an agent reads
      // an absent topic as evidence the subject is not covered. Stale, that
      // inference is wrong in the one direction that matters, so it warns too.
      await warnIfStale(client);
      if (opts.json) return printJson(rows);
      if (!rows.length) return console.log("no topics");
      for (const r of rows) {
        console.log(
          `${String(r.item_count).padStart(4)}  ${r.name}${r.description ? ` — ${r.description}` : ""}`,
        );
      }
    }),
  );

function parseItemId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new Error(`invalid item id: ${raw}`);
  return id;
}

function parseIdList(raw: string): number[] {
  const ids = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map(parseItemId);
  if (!ids.length) throw new Error(`--ids named no items: ${raw}`);
  return [...new Set(ids)];
}

function parseLimit(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`invalid --limit: ${raw}`);
  return n;
}

await program.parseAsync();
