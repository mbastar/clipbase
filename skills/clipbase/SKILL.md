---
name: clipbase
description: Search the user's saved knowledge base — bookmarked repos, articles, videos and papers on AI agents, agent memory/context, Claude Code, MCP, coding agents, prompting, no-code automation and AI infra. Trigger when asked about a specific tool, library, framework or approach in that space ("what's good for agent memory", "is there a tool that does X", "what was that MCP server for Y"), or on any explicit ask — "check clipbase", "what have I saved about...". Read-only.
---

# clipbase

A personal knowledge base of **things the user deliberately saved** — mostly from
Raindrop, fetched and cleaned to markdown, chunked, embedded, and tagged with
topics and one-line summaries.

**What it is good for: what exists, and what the user has already seen.** It answers
"is there a tool for X", "what was that thing called", "what have I read about
Y". It is a curated index of a field, not a reference manual: GitHub repos are
the single largest form, so it leans toward *projects and products* over
tutorials and explanation. `clipbase tags` and `clipbase status` report the
actual shape — this file deliberately states none of it, because every count in
it goes stale on the next sync.

**Read-only.** Nothing in this skill writes, and that is deliberate rather than
incidental — collecting is the user's act (they save to Raindrop), and the
catch-up that follows (sync, embed, enrich, classify) belongs to
`clipbase-sync`, which they run by hand, not to an agent answering a question.
If the corpus needs refreshing, **say so and let them run it**; do not reach
for the write path.

## Choosing the call

Invoke the `clipbase` bin directly. It resolves its own credentials and pins its
own interpreter, so it works from any directory and needs no `npm`, no
`--silent`.

If the command is not found, the launcher is missing rather than the tool:
`sh /path/to/clipbase/scripts/install-bin.sh`. Say
so rather than falling back to reading the database directly.

| You want | Call |
|---|---|
| Best general answer — **start here** | `clipbase search "<query>" --hybrid --json` |
| An exact term, name, or repo you know | `clipbase search "<term>" --json` (FTS, the default) |
| A concept where you don't know their word for it | `clipbase search "<description>" --semantic --json` |
| What an item actually is, cheaply | `clipbase show <id> --no-content --json` |
| To read the document | `clipbase show <id> --json` |
| What subjects the corpus covers at all | `clipbase topics` |
| What forms it holds (`form:repo`, `form:video`, …) | `clipbase tags` |
| Recent items / failed extractions | `clipbase list --limit 20 --json` · `--status extraction_failed` |
| Whether the corpus is current enough to trust | `clipbase status` · `--json` |

`--limit` defaults to 10 on search, 20 on list.

**Read `--no-content` before reading content.** A full `show` returns the whole
stored document — 84KB on a large item, ~100× the trimmed record. Search results
already carry `summary` and `topics`; between those and `show --no-content`, the
full document is rarely the right call. Fetch it when the answer depends on what
the document *says*, not on what it *is*.

The first `--semantic` or `--hybrid` call of a session pulls a local replica
(~8s). Later ones are ~200ms. That pause is normal, not a hang.

## Scores do not mean the same thing across methods

Three rankers, three scales — never compare or merge scores across them:

| Method | Field | Direction |
|---|---|---|
| FTS (default) | bm25 | **lower is better** (values are negative) |
| `--semantic` | cosine similarity | higher is better, 0–1 |
| `--hybrid` | RRF | higher is better, but tiny — ~0.016–0.033 |

In all three the **list is already ranked best-first**. Trust the order, not the
number. A low-looking hybrid score is not a weak result.

## When a search misses — in order

1. **Switch to `--hybrid`.** Plain FTS treats the query as literal words ORed
   together, so a paraphrase that shares no word with the document is
   unreachable by it. This is the single most common miss.
2. **Use fewer words.** Three beat seven. Long natural-language questions drag
   in terms that no document contains.
3. **Try `--semantic` alone** if hybrid still leans keyword-ish — it finds items
   that never use your phrasing.
4. **Check `clipbase topics`.** The taxonomy is fixed and small. If the subject
   isn't in it, the corpus most likely does not cover the subject — say so
   rather than returning a weak hit as though it answered.
5. **Accept the miss.** A handful of known items cannot be retrieved by any
   method at the depth search reads. A confident "not in here" is a correct
   answer and more useful than a stretch.

## A miss is only evidence when the corpus is current

Search and `topics` print a staleness warning **to stderr** when the corpus has
gone `STALE_AFTER_DAYS` (14) past its last sync. You do not have to ask for it,
and stdout stays clean machine output, so a `--json | jq` pipeline is unaffected.

- **If that warning appears, relay it.** Say "your corpus is N days stale — run
  `clipbase-sync`" rather than quietly answering from an old index. Never suppress
  it with `2>/dev/null`.
- **A miss under that warning is not evidence of absence**, and step 4 above stops
  applying: an absent topic may just be a subject saved after the last sync.
  Downgrade "not in here" to "not in here as of <date>".
- **`clipbase status`** gives the detail behind the warning — pending embeds and
  missing topics matter too, because freshly synced items are findable by keyword
  before they are rankable by `--hybrid` or describable by `topics`. Its `stalest`
  field catches the case a headline age hides: one collection stuck behind while
  the rest synced fine.

## Result fields

`id` · `title` · `url` · `domain` · `source_type` · `summary` · `topics` ·
`score` · `snippet`.

- `summary` — one line, model-written. `null` on items `enrich` hasn't reached.
- `topics` — from a fixed taxonomy; `[]` when unassigned. Both are `null`/`[]`
  rather than missing, so every hit reads the same way.
- `snippet` — says **why it matched** (`>>>terms<<<` marked on FTS hits), not
  what the item is. That's what `summary` is for.

`show` adds `content`, `chunk_count`, `tags`, and the full item record. With
`--no-content` the `content` key is **absent** — distinct from `null`, which
means the item genuinely has no stored text (every `extraction_failed` row).

## Subject coverage

The taxonomy is fixed, so these are the only subjects an item can be filed
under — and these are the exact strings a hit's `topics` array contains:

`agent-frameworks` · `coding-agents` · `claude-code` · `memory-and-context` ·
`developer-tools` · `business-and-strategy` · `content-generation` ·
`infra-and-sandboxes` · `mcp` · `automation-and-nocode` · `prompting` ·
`llm-fundamentals`

`clipbase topics` gives the live counts, and is the call to make before
concluding a subject is absent — the names here are stable, the weights are not.

Note that **an item can be filed under none of them**. `enrich` leaves a topic
off rather than forcing a wrong one, so `topics: []` means unplaced, not
uncategorisable — those items are a taxonomy-gap queue, and they are still
fully searchable.

There is no way to list a topic's items — `list` filters on source and status
only. To browse a subject, search its terms.

## How much to trust a ranking

Measured over 30 labelled queries: hybrid MRR 0.816, semantic 0.766, FTS 0.642.
Hybrid wins on every metric, which is why it's the default recommendation above.

Treat those as *directional*. The gold was pooled against a smaller corpus, so
items added since are scored as irrelevant by construction and the real numbers
are somewhat better than these. Either way they describe the average query, not
yours.

## Widening the trigger

This skill currently fires on a **narrow band**: named tools and approaches,
and explicit asks. It deliberately stays out of general conversation.

To make it a general-purpose knowledge base — consulted whenever a question
touches anything it might hold — edit **one sentence**: the `Trigger when...`
clause of the `description` in the frontmatter above. Replace it with something
like *"Trigger on any question about AI tooling, agents, or development practice
where prior saved material might inform the answer."* Nothing else needs to
change; the description is the whole trigger contract.

Widen it once there's evidence the narrow band is being useful and the misses
are cheap — not before.
