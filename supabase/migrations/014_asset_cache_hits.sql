-- Audit log for fuzzy asset cache hits.
-- Every time findFuzzy() returns a match, one row is written here.
-- Use this table to tune JACCARD_THRESHOLD after 50+ real generations:
--   SELECT similarity, query_prompt, matched_prompt FROM asset_cache_hits ORDER BY created_at DESC;
CREATE TABLE IF NOT EXISTS public.asset_cache_hits (
  id             BIGSERIAL PRIMARY KEY,
  query_prompt   TEXT           NOT NULL,
  matched_prompt TEXT           NOT NULL,
  similarity     NUMERIC(4, 3)  NOT NULL,
  cache_key      TEXT           NOT NULL,
  is_humanoid    BOOLEAN        NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_asset_cache_hits_created ON public.asset_cache_hits (created_at DESC);
