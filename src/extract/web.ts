import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wordCount } from "../chunk.js";
import { stripSiteFurniture } from "./furniture.js";
import { fetchTranscript, youtubeVideoId, type YoutubeTranscript } from "./youtube.js";

const execFileAsync = promisify(execFile);

// Below this, extraction is considered "thin" (paywall stub, JS shell,
// cookie wall) and not worth storing.
export const THIN_WORD_THRESHOLD = 100;

// A length check cannot tell a *wrong* document from a right one. Item 5 held
// a YouTube 403 page for three sessions: 1,972 words, comfortably above the
// thin threshold, and utterly not the talk it claimed to be. These markers
// catch the block page itself, independent of how long it is.
//
// Only the head of the document is scanned. A block page announces itself
// immediately; an article that *discusses* bot walls mentions them in the
// body. That distinction is the whole reason this is not a whole-document
// search — see the false-positive note below.
export const MARKER_SCAN_CHARS = 2500;

// Verified against all 291 content-bearing items in the real corpus: zero
// matches. Bare "captcha" was a candidate and is deliberately absent — it hit
// two legitimate items (#36, #82) that advertise captcha *solving* as a
// product feature. Any marker added here should be re-checked the same way,
// because a false positive silently discards a good document.
const BLOCK_MARKERS = [
  "error 403",
  "403 forbidden",
  "sign in to confirm",
  "unusual traffic",
  "checking your browser before",
  "enable javascript and cookies to continue",
  "attention required!",
  "access denied",
  "verify you are human",
  "complete the captcha",
  "captcha challenge",
  "are you a robot",
  "rate limit exceeded",
  "429 too many requests",
];

const MAX_BUFFER = 64 * 1024 * 1024;

export interface WebMeta {
  title?: string;
  author?: string;
  published?: string;
}

/**
 * Why extraction failed. Distinguishes a permanent wall from a transient
 * error: `thin_content` means a fetcher returned a page but it was a stub
 * (paywall, login gate, JS shell), which re-fetching will not fix, whereas
 * `fetch_error` means no fetcher produced anything at all and may be worth
 * another attempt.
 *
 * `blocked_content` is the third case and the reason the other two were not
 * enough: a full-length page arrived and it was the *wrong document* — a bot
 * wall or an error page wearing the URL's clothes. Unlike `thin_content` it is
 * usually worth retrying, because it is a property of the request (rate limit,
 * missing cookies, datacentre IP) rather than of the page.
 */
export type FailureReason = "thin_content" | "fetch_error" | "blocked_content";

export type FetchMethod = "defuddle" | "firecrawl" | "yt-dlp";

export type WebExtract =
  | ({ ok: true; content: string; method: FetchMethod } & WebMeta)
  | ({ ok: false; reason: FailureReason } & WebMeta);

export function isThin(content: string): boolean {
  return wordCount(content) < THIN_WORD_THRESHOLD;
}

/**
 * True when the head of `content` carries a marker of a bot wall or error
 * page. Independent of length: this is the check `isThin` cannot make.
 */
export function isBlocked(content: string): boolean {
  const head = content.slice(0, MARKER_SCAN_CHARS).toLowerCase();
  return BLOCK_MARKERS.some((marker) => head.includes(marker));
}

/** Content worth storing: long enough to be a document, and the right one. */
function isUsable(content: string): boolean {
  return !isThin(content) && !isBlocked(content);
}

function clean(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

// Both CLIs write to a temp file rather than stdout: defuddle (at least)
// exits before flushing a piped stdout, silently truncating output at the
// 64KB pipe buffer on large pages.
async function runToFile(
  cmd: string,
  args: (outFile: string) => string[],
  timeout: number,
): Promise<string | null> {
  const dir = await mkdtemp(join(tmpdir(), "clipbase-extract-"));
  const outFile = join(dir, "out");
  try {
    await execFileAsync(cmd, args(outFile), { maxBuffer: MAX_BUFFER, timeout });
    return await readFile(outFile, "utf8");
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function tryDefuddle(url: string): Promise<({ content: string } & WebMeta) | null> {
  const raw = await runToFile(
    "defuddle",
    (out) => ["parse", url, "--markdown", "--json", "-o", out],
    60_000,
  );
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw);
    return {
      content: typeof parsed.content === "string" ? parsed.content : "",
      title: clean(parsed.title),
      author: clean(parsed.author),
      published: clean(parsed.published),
    };
  } catch {
    return null;
  }
}

async function tryFirecrawl(url: string): Promise<string | null> {
  return runToFile(
    "firecrawl",
    (out) => ["scrape", url, "-f", "markdown", "--only-main-content", "-o", out],
    120_000,
  );
}

function titleFromMarkdown(content: string): string | undefined {
  return content.match(/^#{1,2} (.+)$/m)?.[1]?.trim();
}

/** Why a fetcher's output was rejected, for the fallback log line. */
function why(content: string | null | undefined): string {
  if (content == null) return "no output";
  if (isBlocked(content)) return "a blocked page";
  return `thin content (${wordCount(content)} words)`;
}

export interface WebFetchers {
  defuddle: typeof tryDefuddle;
  firecrawl: typeof tryFirecrawl;
  youtube: typeof fetchTranscript;
}

export async function extractWeb(
  url: string,
  log?: (msg: string) => void,
  fetchers: WebFetchers = {
    defuddle: tryDefuddle,
    firecrawl: tryFirecrawl,
    youtube: fetchTranscript,
  },
): Promise<WebExtract> {
  // A video is tried by the transcript path *first*, not as a fallback. On
  // youtube.com the page fetchers do not fail slowly and honestly — they fail
  // by returning a plausible wrong document, which is the failure this whole
  // gate exists to catch. Asking the source that has the transcript is both
  // faster and the only one that answers.
  let transcript: YoutubeTranscript | null = null;
  const videoId = youtubeVideoId(url);
  if (videoId !== null) {
    log?.(`fetching ${url} via yt-dlp`);
    transcript = await fetchers.youtube(videoId);
    if (transcript && isUsable(transcript.content)) {
      return {
        ok: true,
        method: "yt-dlp",
        content: transcript.content,
        title: transcript.title,
        author: transcript.author,
        published: transcript.published,
      };
    }
    // Falling through rather than failing: yt-dlp may be absent, and a video
    // page can still carry a real description worth keeping.
    log?.(`yt-dlp returned ${why(transcript?.content)}; falling back to defuddle`);
  }

  // Furniture comes off before the gates, not after: the text that is judged
  // for length has to be the text that gets stored, or `thin_content` starts
  // meaning "thin, once you count the nav". The transcript path is exempt
  // because yt-dlp returns speech, not a page.
  log?.(`fetching ${url} via defuddle`);
  const defuddled = await fetchers.defuddle(url);
  const article = defuddled === null ? null : stripSiteFurniture(defuddled.content);
  const meta: WebMeta = {
    title: defuddled?.title,
    author: defuddled?.author,
    published: defuddled?.published,
  };
  if (article !== null && isUsable(article)) {
    return { ok: true, method: "defuddle", content: article, ...meta };
  }

  log?.(`defuddle returned ${why(article)}; falling back to firecrawl`);
  const fetched = await fetchers.firecrawl(url);
  const scraped = fetched === null ? null : stripSiteFurniture(fetched);
  if (scraped !== null && isUsable(scraped)) {
    return {
      ok: true,
      method: "firecrawl",
      content: scraped,
      ...meta,
      title: meta.title ?? titleFromMarkdown(scraped),
    };
  }

  // Every fetcher is spent, and which reason gets recorded decides whether a
  // retry is ever worth spending. A block seen by *any* of them outranks the
  // others: it is the one failure that says "the request was refused", rather
  // than "the page is a wall" (thin) or "nothing answered" (error). The
  // transcript counts on both scores — something did answer, even if it was
  // useless — so the rule stays uniform as fetchers are added.
  const blocked =
    (transcript != null && isBlocked(transcript.content)) ||
    (article != null && isBlocked(article)) ||
    (scraped != null && isBlocked(scraped));
  const reason: FailureReason = blocked
    ? "blocked_content"
    : scraped === null && article === null && transcript === null
      ? "fetch_error"
      : "thin_content";
  return { ok: false, reason, ...meta };
}
