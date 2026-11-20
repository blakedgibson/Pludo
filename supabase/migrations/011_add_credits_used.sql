-- Track Meshy credit cost per generated game.
-- credits_before/after = balance snapshot; credits_used = before - after (may be 0 in dev mode).
ALTER TABLE public.forge_games
  ADD COLUMN IF NOT EXISTS credits_before  INT,
  ADD COLUMN IF NOT EXISTS credits_after   INT,
  ADD COLUMN IF NOT EXISTS credits_used    INT GENERATED ALWAYS AS (
    CASE WHEN credits_before IS NOT NULL AND credits_after IS NOT NULL
         THEN credits_before - credits_after ELSE NULL END
  ) STORED;
