// YouTube serves its transcript to a player, never to a page fetcher. That is
// why the generic chain fails on it in two different ways: defuddle returns
// the 1-word JS shell, and firecrawl returned a bot-block page on five of six
// real attempts at item 5's URL. Neither is a bug in those tools — the
// document they are asked to extract is not in the HTML. yt-dlp asks the
// caption endpoint instead, which returned the transcript on every attempt.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalizeUrl } from "../canonicalize.js";

const execFileAsync = promisify(execFile);

// Longer than either page fetcher's: yt-dlp resolves formats and may solve a
// JS challenge before it ever reaches the captions.
const TIMEOUT_MS = 180_000;

const MAX_BUFFER = 64 * 1024 * 1024;

export interface YoutubeTranscript {
  content: string;
  title?: string;
  author?: string;
  published?: string;
}

// All 35 youtube.com items in the corpus canonicalize to `/watch?v=<id>`, and
// `canonicalizeUrl` already folds `youtu.be` and `m.youtube.com` into that
// shape. The other three paths are the same document wearing a different URL;
// they cost one alternation, and a miss here degrades to the page fetchers
// that are known not to work on this host.
const VIDEO_PATH = /^\/(?:shorts|live|embed)\/([\w-]+)$/;

/**
 * The video id when `url` addresses a YouTube video, else null. Null is the
 * ordinary answer for every other host and is not an error.
 */
export function youtubeVideoId(url: string): string | null {
  let canonical: string;
  try {
    ({ canonical } = canonicalizeUrl(url));
  } catch {
    return null;
  }
  const parsed = new URL(canonical);
  if (parsed.hostname !== "youtube.com") return null;
  if (parsed.pathname === "/watch") return parsed.searchParams.get("v") || null;
  return parsed.pathname.match(VIDEO_PATH)?.[1] ?? null;
}

interface Json3Caption {
  events?: { segs?: { utf8?: unknown }[] }[];
}

/**
 * Caption text from YouTube's `json3` track.
 *
 * json3 rather than vtt because of how rolling captions are encoded. In vtt
 * each displayed row is re-emitted with every new line that scrolls in, so the
 * same sentence appears three or four times and the transcript has to be
 * de-duplicated by guesswork. json3 expresses the same roll as an append event
 * carrying a newline, so concatenating every segment in order *is* the
 * transcript — no dedupe, nothing to get wrong.
 */
export function transcriptFromJson3(raw: string): string {
  let parsed: Json3Caption;
  try {
    parsed = JSON.parse(raw) as Json3Caption;
  } catch {
    return "";
  }
  const text = (parsed.events ?? [])
    .flatMap((event) => event.segs ?? [])
    .map((seg) => (typeof seg.utf8 === "string" ? seg.utf8 : ""))
    .join("");
  // Auto-captions arrive as unpunctuated ASR text. It is stored as-is: the raw
  // layer holds what the extractor returned, and inventing headings or
  // paragraphs here would be authoring content rather than extracting it.
  return text.trim();
}

// `--sub-langs en.*` is a glob because which English track a video carries is
// not knowable in advance: this one has both `en` and `en-orig`, others have
// only one, and a non-English video has `en` as a machine translation. Take
// whatever landed, preferring the plainest name, so the choice is deterministic
// rather than dependent on readdir order.
function pickCaptions(files: string[]): string | null {
  const captions = files.filter((f) => f.endsWith(".json3")).sort();
  return (
    captions.find((f) => f.endsWith(".en.json3")) ??
    captions.find((f) => f.endsWith(".en-orig.json3")) ??
    captions[0] ??
    null
  );
}

function clean(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** yt-dlp reports `upload_date` as YYYYMMDD; `published_at` holds ISO dates. */
function isoDate(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d{8}$/.test(value)) return undefined;
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

async function readIfPresent(dir: string, files: string[], suffix: string): Promise<string | null> {
  const name = files.find((f) => f.endsWith(suffix));
  if (!name) return null;
  return readFile(join(dir, name), "utf8").catch(() => null);
}

/**
 * Fetch a video's transcript and metadata, or null if yt-dlp is missing, the
 * fetch failed, or the video has no English captions at all. Null means "this
 * path has nothing", which leaves the caller free to fall through.
 */
export async function fetchTranscript(videoId: string): Promise<YoutubeTranscript | null> {
  const dir = await mkdtemp(join(tmpdir(), "clipbase-youtube-"));
  try {
    await execFileAsync(
      "yt-dlp",
      [
        "--skip-download",
        // Manual captions win over automatic ones when a video has both;
        // yt-dlp writes only the better track per language.
        "--write-subs",
        "--write-auto-subs",
        "--sub-langs",
        "en.*",
        "--sub-format",
        "json3",
        "--write-info-json",
        "--no-playlist",
        "-o",
        join(dir, "%(id)s.%(ext)s"),
        // Rebuilt from the id rather than passed through, so a `list=` or `t=`
        // param on the original URL cannot turn this into a playlist fetch.
        `https://www.youtube.com/watch?v=${videoId}`,
      ],
      { maxBuffer: MAX_BUFFER, timeout: TIMEOUT_MS },
    );

    const files = await readdir(dir);
    const captionFile = pickCaptions(files);
    if (!captionFile) return null;

    const content = transcriptFromJson3(await readFile(join(dir, captionFile), "utf8"));
    if (content === "") return null;

    // Metadata is best-effort: a transcript with no title still beats the
    // block page it replaces.
    const info = await readIfPresent(dir, files, ".info.json");
    let meta: Record<string, unknown> = {};
    if (info !== null) {
      try {
        meta = JSON.parse(info) as Record<string, unknown>;
      } catch {
        // leave meta empty
      }
    }

    return {
      content,
      title: clean(meta.title),
      author: clean(meta.uploader) ?? clean(meta.channel),
      published: isoDate(meta.upload_date),
    };
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
