// Split markdown into passages for future embeddings. Derived from the
// immutable raw content, so chunks are always regenerable; bump
// CHUNKING_VERSION if the strategy changes.

import { stripSiteFurniture } from "./extract/furniture.js";

export const CHUNKING_VERSION = 3;

const TARGET_CHARS = 1200;
const MAX_CHARS = 2400;

// Inlined data URIs are payloads, not prose: one saved page carried a single
// 973KB percent-encoded SVG that no whitespace split could break up. They
// carry no retrievable meaning, so drop them before chunking rather than
// embedding hundreds of vectors of encoded bytes. Only the derived chunks lose
// them — item_content keeps the original text.
const DATA_URI = /data:[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+[;,][^\s)"'\]]{200,}/g;

export function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/).length;
}

// Site furniture is stripped by extraction too, so this is a no-op for anything
// ingested since. It runs here as well because `item_content` is write-once: the
// 37 items already holding Medium's footer are repaired by `rechunk`, for free,
// rather than by 37 refetches. Only the derived chunks lose it — item_content
// keeps the page as it arrived, which is also why `items_fts` still matches on
// the footer's text and this fix does not claim otherwise.
export function chunkMarkdown(content: string): string[] {
  const blocks = stripSiteFurniture(content)
    .replace(DATA_URI, "")
    .split(/\n(?=#{1,6} )|\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let current = "";
  for (const piece of bindHeadings(blocks)) {
    if (current && current.length + piece.length + 2 > TARGET_CHARS) {
      chunks.push(current);
      current = piece;
    } else {
      current = current ? `${current}\n\n${piece}` : piece;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

// A bare heading labels the block beneath it; it is not a passage. The split
// above promotes every heading line to its own block, and v2 let the
// accumulator flush between the two: item 463 emitted "## MCP Tools" as a whole
// chunk — three words — which then ranked first for "how do I test and debug an
// MCP server I am building", ahead of every real passage in the corpus. Bind to
// the *first piece* of the following block rather than to the block, because an
// oversized block is sliced to TARGET_CHARS afterwards and would strand the
// heading a second time. A run of headings collapses onto the same block, and a
// document ending on one keeps it — a heading carries the block's retrieval
// signal and is never dropped.
const BARE_HEADING = /^#{1,6} [^\n]+$/;

function bindHeadings(blocks: string[]): string[] {
  const pieces: string[] = [];
  let headings: string[] = [];
  for (const block of blocks) {
    if (BARE_HEADING.test(block)) {
      headings.push(block);
      continue;
    }
    const [first, ...rest] = splitOversized(block);
    const bound = [...headings, first].join("\n\n");
    // Bind only while the join still fits. `splitOversized` packs words and
    // discards the whitespace between them, so re-splitting a bound pair to get
    // back under the ceiling would flatten what it split: a 2395-char table
    // under a 9-char heading collapses to one line, and item 13's 41 chained
    // `#` comment lines lost 84 newlines that way. Past the ceiling the
    // headings stand on their own again and the accumulator packs them as v2
    // did — a heading stranded once is cheaper than a table destroyed.
    if (bound.length <= MAX_CHARS) pieces.push(bound, ...rest);
    else pieces.push(...headings.flatMap((h) => splitOversized(h)), first, ...rest);
    headings = [];
  }
  if (headings.length) appendTrailing(pieces, headings);
  return pieces;
}

// A document ending on a heading has nothing beneath to bind it to, and pushing
// it as its own piece hands the accumulator the same three-word chunk this
// function exists to prevent. It goes on the end of the passage above instead —
// backwards, but only where forwards does not exist, so the 979 headings that
// were absorbed backwards in v2 stay bound forwards.
function appendTrailing(pieces: string[], headings: string[]): void {
  const tail = headings.join("\n\n");
  const last = pieces.pop();
  if (last === undefined) return void pieces.push(...headings.flatMap((h) => splitOversized(h)));
  const merged = `${last}\n\n${tail}`;
  if (merged.length <= MAX_CHARS) pieces.push(merged);
  else pieces.push(last, ...headings.flatMap((h) => splitOversized(h)));
}

function splitOversized(block: string): string[] {
  if (block.length <= MAX_CHARS) return [block];
  const pieces: string[] = [];
  let current = "";
  for (const word of block.split(/\s+/)) {
    for (const part of hardSlice(word)) {
      if (current && current.length + part.length + 1 > TARGET_CHARS) {
        pieces.push(current);
        current = part;
      } else {
        current = current ? `${current} ${part}` : part;
      }
    }
  }
  if (current) pieces.push(current);
  return pieces;
}

// A single "word" can exceed the target on its own — a long URL, a token
// stream, an encoded blob. Splitting on whitespace leaves such a run intact,
// which is how one block became one unbounded chunk; slice it so the MAX_CHARS
// ceiling holds for every input.
function hardSlice(word: string): string[] {
  if (word.length <= TARGET_CHARS) return [word];
  const parts: string[] = [];
  for (let i = 0; i < word.length; i += TARGET_CHARS) {
    parts.push(word.slice(i, i + TARGET_CHARS));
  }
  return parts;
}
