# Topic taxonomy — decision record

Decided 2026-07-19, during the organize pass. Records what was chosen, why, and
what to try instead if it stops working.

## Context

409 items, 398 with content (measured 2026-07-27; the 11 without are permanent
extraction walls — see *Failure reasons* in `docs/data-model.md`). Form
(`repo`, `video`, `article`, …) is already
derived mechanically by `clipbase classify` — see `docs/data-model.md`. This
record covers the other half: **subject matter**, which needs judgement and
therefore a model.

The corpus is not general-interest. Roughly nine in ten items are AI/agent
tooling — agent frameworks, Claude Code, MCP, LLM memory, no-code automation —
with a real tail of ordinary developer tools (a Markdown editor) and unrelated
SaaS (clinic-management software). Any taxonomy that cuts at the level of
"Technology / Business / Science" puts nearly everything in one bucket and
carries no information.

## Decisions

### 1. The topic list is fixed up front, not discovered per run

Fifteen slugs, defined in `src/commands/enrich.ts` and seeded into `topics` with
descriptions: `agent-frameworks`, `agent-orchestration`, `agent-workspaces`,
`claude-code`, `mcp`, `memory-and-context`, `prompting`, `coding-agents`,
`automation-and-nocode`, `infra-and-sandboxes`, `content-generation`,
`business-and-strategy`, `llm-fundamentals`, `developer-tools`,
`productivity-and-collab`.

`llm-fundamentals` was added after the first dry run, which left the *Attention
Is All You Need* paper and a talk on how LLMs work with no topic — the list had
covered tools built *with* models but nothing about the models themselves. That
is the maintenance loop in *If this stops working* item 1, working as intended
on its first outing: zero-topic items are the signal, and the fix is a slug plus
a re-run.

`productivity-and-collab` was added 2026-08-14 on the same signal, at 597 items:
46 zero-topic items with content, roughly two thirds of them notes/tasks/CRM/docs
SaaS with no AI angle — Nextcloud, EspoCRM, Obsidian plugins, task
managers, mind-mappers. `developer-tools` is the nearest bucket and is explicitly
dev tooling, so the classifier declined rather than force a fit, exactly as
Decision 3 asks it to. The remaining tail (Engelbart 1962, a sales-funnel video,
clinic software) is genuinely off-corpus and should stay topicless.

`agent-orchestration` and `agent-workspaces` were split out of `agent-frameworks`
the same day, on the *other* half of the same maintenance signal: one slug had
reached 174 of 584 items, just under the third-of-the-corpus line in *If this
stops working* item 1. Reading all 174 showed it was holding four different
things — the libraries you build with (Agno, Mastra, CAMEL, agentscope), the
harnesses that run many agents at once (cmux, emdash, Herdr, Orca, sandcastle),
the shared surfaces where people and agents work together (Buzz, Remnus, hilos,
KiroCrew), and spillover that only mentions agents (Claude Code skills, opinion
posts). Co-occurrence confirmed the diagnosis rather than a real hub: 31 items
solo and the rest spread thin over nine partners with no dominant pairing.

The two new slugs take the second and third groups. `agent-frameworks` keeps the
first and its description now says what it excludes, because a description that
only says what fits is what let the spillover in. The fourth group has no new
home by design — it belongs on `claude-code`, `coding-agents` or
`business-and-strategy`, and the narrowed description is what sends it there.

**Why.** A discovered (bottom-up) taxonomy fits the data more snugly, but the
labels drift between runs — "agent memory" one run, "memory systems" the next —
so re-running needs a consolidation step that is itself a judgement call, and
the topic set stops being comparable over time. A fixed list makes the pass
idempotent and reviewable: the taxonomy is a small artifact a human can read and
argue with, separate from the 398 assignments. That matters more here than
snugness, because the corpus is coherent enough for one person to enumerate its
axes from a sample.

### 2. Multi-label, up to three topics per item

**Why.** Single-label forces false choices that are common in this corpus, not
rare. Storybloq (item 151) is a Claude Code tool, an MCP server, *and* a memory
system; picking one loses the other two. `item_topics` is already many-to-many,
so nothing in the schema resists this. Three is a cap, not a target — most items
take one or two.

### 3. An item may receive zero topics

**Why.** The tail is real. Clinic-management software is in the corpus and fits
no AI-tooling topic; a catch-all `other` bucket would collect unrelated things
and mean nothing. Zero topics is honest and queryable — items with no topics are
exactly the list to review when deciding whether the taxonomy needs a new slug.

### 4. Classification runs through `claude -p`, not an API key

**Why.** No `ANTHROPIC_API_KEY` and no `ant auth login` profile exists on this
machine, and adding one is avoidable: the Claude Code CLI is already installed
and authenticated, and `claude -p` runs headless against that same session. No
new credential, no separate billing.

**The cost is per-invocation, not per-item.** Every `claude -p` call reloads
Claude Code's own system prompt — measured at ~17.5K cache-creation tokens on a
call whose payload was two tokens. Cost is therefore dominated by the number of
invocations, so items are batched (default 20) and the classifier is sent title,
domain, and a short content excerpt rather than full text. Measured: ~$0.15 per
12-item batch, so the full corpus lands around $3–4 of subscription quota.
Per-item calls would have cost roughly $29 for the same work.

### 5. Re-classification replaces an item's topics rather than adding to them

`enrich --apply` writes through `setTopics`, which detaches whatever the fresh
answer no longer claims.

**Why.** It used to call `attachTopics`, which is `INSERT ... ON CONFLICT DO
NOTHING`, and nothing in the pass ever deleted. That made Decision 1's
maintenance loop half a loop: a slug could be added but never narrowed, because
re-running `--all` under a tightened description left the old label attached
alongside the new one. It was caught during the `agent-frameworks` split — the
run was dutifully attaching `agent-orchestration` and `agent-workspaces` while
`agent-frameworks` sat at 174, unchanged and unchangeable. Every topic count in
this corpus had only ever gone up, which reads like a generous classifier and
was really an arithmetic floor.

An empty answer is exempt: it means "nothing here fits" (Decision 3), and it is
also what a truncated batch looks like, so it never removes anything.

## If this stops working

In rough order of what to reach for:

1. **The topic list stops fitting.** Symptom: a growing pile of zero-topic
   items, or one slug swallowing a third of the corpus. Fix: add or split a
   slug and re-run — the pass is idempotent, and `--all` re-classifies
   everything. This is expected maintenance, not failure.
2. **`claude -p` becomes unavailable or too slow.** Fix: the classifier is a
   single `classifyBatch` function that shells out and parses JSON. Swap it for
   an Anthropic SDK call (`npm i @anthropic-ai/sdk`) and an
   `ANTHROPIC_API_KEY`; the prompt, batching, and write path are unchanged.
   Structured outputs (`output_config.format`) would also remove the
   fence-stripping hack.
3. **Batch quality degrades.** Symptom: the model drifts, truncates, or invents
   slugs late in a batch. Unknown slugs are already dropped rather than
   inserted, so the failure is visible as missing topics rather than junk ones.
   Fix: repair the stranded items with `enrich --ids 364,369 --apply`, which
   ignores the annotation gate and costs one batch. Lowering `--batch` is the
   other lever but a weaker one than it looks: truncation hit one batch at size
   20 and again at size 12, so reply length was not what drove it. Below ~8 the
   per-call overhead starts to dominate cost.

   A truncated batch is not neutral. `setTopics` (Decision 5) only rewrites the
   items it gets an answer for, so the rest keep the labels a tightened taxonomy
   was in the middle of taking away — the run reports a clean exit while a
   handful of rows quietly disagree with the vocabulary.
4. **The fixed taxonomy proves genuinely wrong for the corpus.** Fix: run a
   discovery pass — ask the model to propose topics bottom-up over a sample,
   consolidate by hand into a new fixed list, then re-run. This is decision 1
   reversed, and is worth doing if the corpus subject matter broadens.
5. **Topics turn out to be the wrong structure entirely.** The schema is already
   vector-ready (`docs/data-model.md` → *Future migrations: vectors*); embedding
   the existing chunks and clustering would give similarity and
   "more like this" without any taxonomy at all. Topics and embeddings are
   complements — losing the argument for topics does not mean losing the data,
   since the organization layer is regenerable by contract.
