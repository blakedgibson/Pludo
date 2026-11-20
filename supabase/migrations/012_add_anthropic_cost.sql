-- Track Claude API token usage and USD cost per generated game.
ALTER TABLE public.forge_games
  ADD COLUMN IF NOT EXISTS anthropic_input_tokens      INT,
  ADD COLUMN IF NOT EXISTS anthropic_output_tokens     INT,
  ADD COLUMN IF NOT EXISTS anthropic_cache_read_tokens INT,
  ADD COLUMN IF NOT EXISTS anthropic_cost_usd          NUMERIC(10, 6);
