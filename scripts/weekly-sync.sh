#!/bin/sh
# The weekly catch-up, as one command. Runs locally: the laptop already has the
# whole toolchain and an authenticated `claude`, and its residential IP extracts
# better than a datacenter one — `defuddle` fetches directly and did 319 of 398
# items, so that difference is the corpus, not a detail.
#
# Order matters. sync-all lands items that are findable by keyword but carry no
# summary, no topics and no vectors, which is exactly what the agent contract
# triages on. A sync without the three passes behind it produces items an agent
# can find and cannot describe. Run all four or none.
#
# Usage: sh scripts/weekly-sync.sh [--sync-only]
#
# --sync-only is not a dry run and is deliberately not called one: sync-all has
# already pulled, fetched and stored by the time it takes effect. It stops before
# the three passes that spend — nothing more.

set -eu

SYNC_ONLY=0
[ "${1:-}" = "--sync-only" ] && SYNC_ONLY=1

cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
CLIPBASE="${CLIPBASE_BIN:-clipbase}"

say() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

# Under launchd there is no shell profile and no fnm hook, so the PATH a
# terminal has is not the PATH this gets. `defuddle` and `firecrawl` are npm
# globals living under an fnm node version, and `extract/web.ts` resolves them
# with execFile on PATH — so a missing one is not an error the run reports.
# defuddle ENOENT falls through to firecrawl, firecrawl ENOENT fails the item,
# and the night's work lands as `extraction_failed:thin_content` on every URL:
# indistinguishable from the attrition this corpus already has. Refuse to start.
need() {
  command -v "$1" >/dev/null 2>&1 && return 0
  say "missing required tool: $1"
  say "PATH=$PATH"
  exit 127
}
need "$CLIPBASE"
need defuddle
# claude backs `enrich`; only the spending path needs it.
[ "$SYNC_ONLY" -eq 1 ] || need claude

# Fallbacks, not requirements: web.ts deliberately falls through when yt-dlp is
# absent, and firecrawl is the last resort behind defuddle. Missing either
# degrades the run without invalidating it, so say so and continue.
for optional in yt-dlp firecrawl; do
  command -v "$optional" >/dev/null 2>&1 || say "warning: $optional not on PATH — extraction will fall back"
done

say "sync-all starting"
SYNC_JSON="$(mktemp)"
trap 'rm -f "$SYNC_JSON"' EXIT

# sync-all exits non-zero when any collection was unreachable. That is a partial
# sync, not a failed one: the collections that ran keep their advanced cursors.
# Capture the code, report it, and still act on what did come back.
SYNC_RC=0
"$CLIPBASE" sync-all --json > "$SYNC_JSON" || SYNC_RC=$?

# sync-all writes nothing to stdout when it fails before reaching the API — an
# unset credential, say. Parsing that buries the one line the operator can act
# on under a JSON stack trace, so check before reading.
COUNTS="$(node -e '
  const fs = require("fs");
  let r;
  try { r = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch { process.exit(3); }
  console.log(`${r.totals?.created ?? 0} ${(r.failed ?? []).length}`);
' "$SYNC_JSON" 2>/dev/null)" || {
  say "sync-all returned no usable output (exit $SYNC_RC) — see the error above"
  [ "$SYNC_RC" -eq 0 ] && exit 1
  exit "$SYNC_RC"
}
NEW="${COUNTS% *}"
FAILED="${COUNTS#* }"

say "sync-all: $NEW new, $FAILED collection(s) unreachable (exit $SYNC_RC)"

# Deliberately above the spend gate, so it runs on the nights that ingest
# nothing too — those are the nights it exists for. sync pages `-created` and
# stops at the cursor, but triage files bookmarks by moving them, which changes
# `lastUpdate` and not `created`; an old bookmark filed today lands behind the
# cursor and no future run reaches it. The collection then reports "0 new",
# which is also what a genuinely quiet night reports. This tells the two apart.
#
# Read-only and unbilled. It exits non-zero on a gap because a scheduled caller
# needs some way to escalate one, but a gap is a finding and not a failed sync —
# so swallow the code here and let the run continue to the passes.
say "reconcile (read-only, no spend)"
# 0 = all present, 2 = a gap was found, 1 = the check itself failed. The old
# `|| true` swallowed all three, which discarded the one distinction that
# matters here: "nothing is stranded" and "we never found out" printed the same
# thing. Both stdout and stderr land in the same log, so the error text was
# never invisible — it was just unstamped, between two say lines. Neither code
# stops the run: a gap is a finding, and a failed check is not a failed sync.
RECONCILE_RC=0
"$CLIPBASE" reconcile || RECONCILE_RC=$?
case "$RECONCILE_RC" in
  0) ;;
  2) say "reconcile: gap found — ingest line(s) above say which" ;;
  *) say "reconcile: CHECK FAILED (exit $RECONCILE_RC) — cursor gap unverified tonight" ;;
esac

# The spend gate. enrich bills per model call whether or not anything changed,
# and --apply gates the writes rather than the calls, so a no-op week must not
# reach it at all.
if [ "$NEW" -eq 0 ]; then
  say "nothing new — skipping classify/enrich/embed"
  exit "$SYNC_RC"
fi

if [ "$SYNC_ONLY" -eq 1 ]; then
  say "sync-only: $NEW item(s) stored, stopping before classify/enrich/embed"
  exit "$SYNC_RC"
fi

say "classify (free, deterministic)"
"$CLIPBASE" classify --apply

say "enrich (spends model calls)"
"$CLIPBASE" enrich --apply

say "embed (spends OpenRouter credits)"
"$CLIPBASE" embed --apply

say "done: $NEW item(s) fully processed"
exit "$SYNC_RC"
