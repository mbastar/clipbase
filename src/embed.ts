// Embedding provider: Gemini Embedding 2, reached through OpenRouter's
// OpenAI-compatible /embeddings endpoint.
//
// Why via OpenRouter rather than the Gemini API: Gemini Embedding 2 dropped the
// task_type parameter its predecessor had — retrieval intent is expressed as an
// instruction inside the input text instead. That is the one thing a proxy
// could have silently swallowed, so with it gone the two routes are equivalent
// and OpenRouter costs one integration instead of one per provider.

const ENDPOINT = "https://openrouter.ai/api/v1/embeddings";

export const EMBEDDING_MODEL = "google/gemini-embedding-2";
export const EMBEDDING_DIMS = 768;

/** Chunks cap at 2400 chars (~600 tokens); the model's limit is 8192. */
const BATCH_SIZE = 64;
const MAX_ATTEMPTS = 5;

// Node's fetch has no default timeout: a wedged connection hangs until the OS
// gives up, which cost one backfill five minutes before failing on its first
// batch. Measured batches of 64 return in under a second, so a minute is a
// generous ceiling that still fails fast enough to retry.
const REQUEST_TIMEOUT_MS = 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const backoffMs = (attempt: number) => 2 ** attempt * 500;

// Gemini Embedding 2 has no task_type: "include the task as an instruction in
// your prompt". Retrieval is asymmetric, so only the query carries one — the
// stored side is the plain passage.
const QUERY_INSTRUCTION =
  "Represent this search query for retrieving relevant passages: ";

export interface EmbedResult {
  vectors: number[][];
  tokens: number;
}

export type Embedder = (texts: string[], kind: "document" | "query") => Promise<EmbedResult>;

function apiKey(): string {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY is not set (see .env.example)");
  return key;
}

// Matryoshka truncation: a prefix of the vector is itself a valid embedding.
// Gemini re-normalizes when *it* truncates, but OpenRouter's OpenAI-compatible
// surface does not document passing `dimensions` through — so if a full-length
// vector comes back we truncate here, and must re-normalize ourselves. Cosine
// ranking assumes unit vectors; skipping this skews results silently instead of
// failing, which is why it is not left to chance.
export function fitDimensions(vector: number[], dims = EMBEDDING_DIMS): number[] {
  if (vector.length === dims) return vector;
  if (vector.length < dims) {
    throw new Error(`embedding has ${vector.length} dims, expected at least ${dims}`);
  }
  const head = vector.slice(0, dims);
  const norm = Math.hypot(...head);
  if (norm === 0) throw new Error("embedding truncated to a zero vector");
  return head.map((v) => v / norm);
}

async function post(body: unknown, attempt = 1): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    // fetch *throws* on connection-level failure — reset, DNS, abort — instead
    // of returning a response, so these never reach the status checks below.
    // A full backfill is ~100 sequential requests; one blip 20 requests in must
    // not discard the run, which is exactly what it did before this branch.
    if (attempt >= MAX_ATTEMPTS) throw err;
    await sleep(backoffMs(attempt));
    return post(body, attempt + 1);
  }
  // 429 and 5xx are transient; anything else is a request problem that retrying
  // will not fix, so surface it immediately with the provider's own message.
  if (res.ok || attempt >= MAX_ATTEMPTS || (res.status !== 429 && res.status < 500)) {
    return res;
  }
  const backoff = Number(res.headers.get("retry-after")) * 1000 || backoffMs(attempt);
  await sleep(backoff);
  return post(body, attempt + 1);
}

async function embedBatch(
  texts: string[],
  kind: "document" | "query",
  attempt = 1,
): Promise<EmbedResult> {
  const input = kind === "query" ? texts.map((t) => `${QUERY_INSTRUCTION}${t}`) : texts;
  const res = await post({ model: EMBEDDING_MODEL, input, dimensions: EMBEDDING_DIMS });
  if (!res.ok) {
    throw new Error(`embeddings request failed (${res.status}): ${await res.text()}`);
  }

  const json = (await res.json()) as {
    data?: { embedding: number[]; index: number }[];
    usage?: { prompt_tokens?: number; total_tokens?: number };
    error?: unknown;
  };

  // An upstream hiccup can arrive as HTTP 200 with an error body or an empty
  // data array rather than a failure status, so the retry above never sees it.
  // That ended a backfill 3040 chunks in; treat it as transient, and quote the
  // body so the next occurrence explains itself instead of just saying "no data".
  if (!json.data?.length) {
    const detail = JSON.stringify(json.error ?? json).slice(0, 300);
    if (attempt >= MAX_ATTEMPTS) {
      throw new Error(`embeddings response contained no data: ${detail}`);
    }
    await sleep(backoffMs(attempt));
    return embedBatch(texts, kind, attempt + 1);
  }
  if (json.data.length !== texts.length) {
    throw new Error(`asked for ${texts.length} embeddings, got ${json.data.length}`);
  }

  // The response carries an index per row; ordering is not promised, so sort
  // rather than trusting position — a silent misalignment would attach every
  // vector to the wrong chunk.
  const ordered = [...json.data].sort((a, b) => a.index - b.index);
  return {
    vectors: ordered.map((d) => fitDimensions(d.embedding)),
    tokens: json.usage?.prompt_tokens ?? json.usage?.total_tokens ?? 0,
  };
}

export const embed: Embedder = async (texts, kind) => {
  const vectors: number[][] = [];
  let tokens = 0;
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = await embedBatch(texts.slice(i, i + BATCH_SIZE), kind);
    vectors.push(...batch.vectors);
    tokens += batch.tokens;
  }
  return { vectors, tokens };
};

export { BATCH_SIZE };
