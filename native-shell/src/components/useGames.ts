import { useCallback, useEffect, useState } from 'react';
import { fetchGames, type GameSummary } from '../api';

export function useGames() {
  const [games, setGames] = useState<GameSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try { setGames(await fetchGames()); setError(null); }
    catch (e: any) { setError(String(e?.message ?? e)); }
    finally { setLoading(false); }
  }, []);

  // Initial load: state starts as loading, so nothing is set synchronously here.
  useEffect(() => {
    let alive = true;
    fetchGames()
      .then(list => { if (alive) { setGames(list); setError(null); } })
      .catch(e => { if (alive) setError(String(e?.message ?? e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);
  return { games, error, loading, reload: load };
}
