// Site chrome that survives extraction. Every gate in web.ts decides whether to
// keep a document, never which part of it — `isThin` counts words and
// `isBlocked` reads the head — so a full article arriving with its nav and
// footer attached passes both and is stored whole. This is where a part gets
// dropped instead of the document.
//
// Each rule here is the exact signature of one publisher's furniture, never a
// shape. The shape rules were measured and are not defensible on this corpus:
// dropping every chunk with fewer than 12 words outside links and headings
// takes 716 of 8522 chunks across 262 items, among them item 7's table of
// contents and item 22's sentence "agent-standard keeps day-to-day work safe
// with:"; dropping link-dense final chunks destroys GitHub's `## About` repo
// description on ~147 items, where the sidebar shares a chunk with the single
// most retrievable line on the page. A false positive deletes real content and
// says nothing about it, which is worse than the noise it removes.

// Medium's footer: the nav block running from the help-centre link to EOF and
// closing on Speechify's "Text to speech" ad. On item 458 that ad became a
// three-word chunk of its own and took semantic rank 2 for "clone a voice and
// generate speech from text" — furniture that ranks confidently, where the 13
// known extraction failures at least fail loudly.
//
// `\s*` inside the brackets is load-bearing rather than cosmetic: firecrawl
// emits each link on one line and defuddle breaks the label onto its own, and
// 22 of the 37 affected items came from defuddle, so a one-line pattern would
// fix the smaller half of the problem and read as a firecrawl bug.
const MEDIUM_FOOTER_HEAD = /\n\[\s*Help\s*\]\(https:\/\/help\.medium\.com\//g;

const MEDIUM_FOOTER_END = "speechify.com/medium";

/**
 * `content` with known site furniture removed, byte-identical when no rule
 * matches.
 *
 * Applied to what a page fetcher returns, so newly ingested items are clean at
 * rest, and again in `chunkMarkdown`, because `item_content` is write-once: the
 * 37 items already carrying Medium's footer are repaired by a free `rechunk`
 * rather than by 37 refetches against a paywall.
 *
 * Verified against all 472 content-bearing items in the real corpus: fires on
 * 37, misses none of the 37 that carry the footer, touches none of the other
 * 435, and grows nothing. The population it must not touch is the corpus's
 * seven genuine text-to-speech items (#133, #402, #324, #474, #121, #111, #54,
 * all github.com, including both gold answers for the query item 458 hijacked)
 * — all seven come through byte-identical. Re-check any rule added here the
 * same way, against real content, and check what it removes as well as what it
 * fires on: a rule that silently deletes a paragraph reports nothing, and
 * `writeContent`'s shrink warning only fires on the `replacing` path.
 */
export function stripSiteFurniture(content: string): string {
  // Both markers are required, and the cut runs from the *last* help-centre
  // link so that an article linking Medium's help centre in its own prose keeps
  // everything it wrote. Demanding Speechify's ad below the cut is what makes
  // this Medium's footer rather than "everything after any Medium link".
  const heads = [...content.matchAll(MEDIUM_FOOTER_HEAD)];
  const cut = heads.at(-1)?.index ?? -1;
  if (cut < 0 || !content.slice(cut).includes(MEDIUM_FOOTER_END)) return content;

  // The signature is not enough on its own, because `chunkMarkdown` runs this
  // over every item on every host: a post *about* Medium's Speechify integration
  // can open a line with the help-centre link and mention the ad below it, and
  // the two markers alone would delete the rest of the article silently. So the
  // cut has to look like a footer as well as start like one. Across all 37 real
  // cuts no removed line reaches eight words once link targets are dropped —
  // furniture is labels and URLs — and a prose line below the head means this is
  // a body, not a footer. Nothing on the corpus is saved by this today; it is
  // here for the article the corpus has not collected yet.
  const removed = content.slice(cut).split("\n");
  if (removed.some(isProse)) return content;

  const kept = content.slice(0, cut).trimEnd();
  // A page that is nothing but footer has nothing to keep, and returning "" here
  // would have `rechunk` delete every chunk of the item and insert none.
  return kept === "" ? content : kept;
}

const LINK_TARGET = /\]\([^)]*\)/g;
const PROSE_WORDS = 8;

function isProse(line: string): boolean {
  const words = line.replace(LINK_TARGET, "]").trim().split(/\s+/).filter(Boolean);
  return words.length >= PROSE_WORDS;
}
