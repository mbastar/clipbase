-- Vector search over chunks.
--
-- 768 dims: Gemini Embedding 2's recommended production width (native 3072,
-- Matryoshka-truncatable), and also EmbeddingGemma's native width, so a move
-- to local embedding needs no schema change.
--
-- embedding_model records what produced the vector. A chunk is "embedded" iff
-- both columns are non-null, and swapping models is detectable rather than
-- silent — the same role chunking_version plays for chunk text.
--
-- Note: ALTER TABLE ADD COLUMN has no IF NOT EXISTS in SQLite, so unlike the
-- other migrations this one cannot self-converge after a partial failure.
-- schema_migrations only records a fully applied migration, so a failure
-- between the two ALTERs needs the applied column dropped by hand before retry.

ALTER TABLE chunks ADD COLUMN embedding F32_BLOB(768);
ALTER TABLE chunks ADD COLUMN embedding_model TEXT;

CREATE INDEX IF NOT EXISTS chunks_embedding_idx
  ON chunks (libsql_vector_idx(embedding));
