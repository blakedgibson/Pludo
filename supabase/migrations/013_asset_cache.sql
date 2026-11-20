-- Fuzzy asset cache index. Maps normalised prompt tokens → R2 cache key so
-- similar prompts (different wording, same intent) reuse existing 3D models.
CREATE TABLE IF NOT EXISTS public.asset_cache (
  id               BIGSERIAL PRIMARY KEY,
  prompt_raw       TEXT        NOT NULL,
  prompt_normalized TEXT        NOT NULL,
  cache_key        TEXT        NOT NULL,
  is_humanoid      BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_asset_cache_normalized ON public.asset_cache (prompt_normalized);
CREATE INDEX IF NOT EXISTS idx_asset_cache_humanoid   ON public.asset_cache (is_humanoid);
