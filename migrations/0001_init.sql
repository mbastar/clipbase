-- 0001_init: core schema.
-- Enum-like TEXT columns (source_type, status, fetch_method, link_type) are
-- deliberately unconstrained: adding values later must not require a table
-- rebuild. Valid values are enforced in app code and documented in
-- docs/data-model.md.

CREATE TABLE IF NOT EXISTS items (
  id            INTEGER PRIMARY KEY,
  source_type   TEXT NOT NULL,           -- 'web' | 'pdf' | 'raindrop'
  url           TEXT UNIQUE,             -- canonical URL; file:// for PDFs
  original_url  TEXT,                    -- URL exactly as saved (provenance)
  title         TEXT,
  domain        TEXT,
  author        TEXT,
  published_at  TEXT,
  status        TEXT NOT NULL,           -- 'ok' | 'extraction_failed'
  fetch_method  TEXT,                    -- 'defuddle' | 'firecrawl' | 'pdf'
  fetched_at    TEXT,
  raindrop_id   INTEGER UNIQUE,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- Immutable raw layer: cleaned markdown, write-once after ingest.
CREATE TABLE IF NOT EXISTS item_content (
  item_id     INTEGER PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  content     TEXT NOT NULL,
  word_count  INTEGER NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS item_content_immutable
BEFORE UPDATE ON item_content
BEGIN
  SELECT RAISE(ABORT, 'item_content is write-once; re-ingest cannot mutate raw content');
END;

-- Derived, regenerable passage chunks (future embedding target; no vector
-- column yet — see docs/data-model.md for the exact migration to add one).
CREATE TABLE IF NOT EXISTS chunks (
  id                INTEGER PRIMARY KEY,
  item_id           INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  seq               INTEGER NOT NULL,
  content           TEXT NOT NULL,
  word_count        INTEGER NOT NULL,
  chunking_version  INTEGER NOT NULL DEFAULT 1,
  UNIQUE (item_id, seq)
);

-- Organization layer: agent-owned, empty in v1.
CREATE TABLE IF NOT EXISTS topics (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS item_topics (
  item_id   INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  topic_id  INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, topic_id)
);

CREATE TABLE IF NOT EXISTS tags (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS item_tags (
  item_id  INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  tag_id   INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, tag_id)
);

CREATE TABLE IF NOT EXISTS item_links (
  from_item_id  INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  to_item_id    INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  link_type     TEXT NOT NULL,           -- e.g. 'related' | 'contradicts' | 'expands_on'
  note          TEXT,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (from_item_id, to_item_id, link_type)
);

CREATE TABLE IF NOT EXISTS item_annotations (
  item_id     INTEGER PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  summary     TEXT,
  updated_at  TEXT NOT NULL
);

-- Raindrop sync cursor, one row per collection. The cursor is the max
-- bookmark `created` timestamp ingested: listing is sorted -created, so
-- sync can stop paging once it sees created <= cursor. Edits to old
-- bookmarks are not re-pulled in v1.
CREATE TABLE IF NOT EXISTS sync_state (
  collection_id        INTEGER PRIMARY KEY,
  collection_title     TEXT,
  last_created_cursor  TEXT,
  last_synced_at       TEXT
);

-- Full-text index over title + content. Stores its own copy of the text
-- (needed for snippet()); rowid = items.id; rows exist only for items that
-- have content. Kept in sync by the triggers below.
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(title, content);

CREATE TRIGGER IF NOT EXISTS items_fts_after_content_insert
AFTER INSERT ON item_content
BEGIN
  INSERT INTO items_fts (rowid, title, content)
  VALUES (NEW.item_id, (SELECT title FROM items WHERE id = NEW.item_id), NEW.content);
END;

CREATE TRIGGER IF NOT EXISTS items_fts_after_title_update
AFTER UPDATE OF title ON items
WHEN EXISTS (SELECT 1 FROM item_content WHERE item_id = OLD.id)
BEGIN
  UPDATE items_fts SET title = NEW.title WHERE rowid = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS items_fts_after_item_delete
AFTER DELETE ON items
BEGIN
  DELETE FROM items_fts WHERE rowid = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS items_fts_after_content_delete
AFTER DELETE ON item_content
BEGIN
  DELETE FROM items_fts WHERE rowid = OLD.item_id;
END;

CREATE INDEX IF NOT EXISTS idx_items_created_at ON items (created_at);
CREATE INDEX IF NOT EXISTS idx_items_source_type ON items (source_type);
CREATE INDEX IF NOT EXISTS idx_items_status ON items (status);
CREATE INDEX IF NOT EXISTS idx_chunks_item_id ON chunks (item_id);
