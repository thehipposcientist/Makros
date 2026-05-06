import { useEffect, useRef, useState } from 'react';
import { searchFoodNutrition, type FoodSearchResult } from '../services/api';

type LiveFoodSearchOptions = {
  enabled?: boolean;
  minChars?: number;
  debounceMs?: number;
  allowAiFallback?: boolean;
};

export function useLiveFoodSearch(
  authToken: string | undefined,
  query: string,
  options: LiveFoodSearchOptions = {},
) {
  const {
    enabled = true,
    minChars = 2,
    debounceMs = 300,
    allowAiFallback = false,
  } = options;
  const [results, setResults] = useState<FoodSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  useEffect(() => {
    const normalizedQuery = query.trim();
    requestIdRef.current += 1;
    const requestId = requestIdRef.current;

    if (!enabled || !authToken || normalizedQuery.length < minChars) {
      setResults([]);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);
    const timer = setTimeout(async () => {
      try {
        const response = await searchFoodNutrition(authToken, normalizedQuery, { allowAiFallback });
        if (requestIdRef.current !== requestId) return;
        setResults(response.results ?? []);
      } catch (e: any) {
        if (requestIdRef.current !== requestId) return;
        setResults([]);
        setError(e?.message ?? 'Food search failed.');
      } finally {
        if (requestIdRef.current === requestId) setLoading(false);
      }
    }, debounceMs);

    return () => clearTimeout(timer);
  }, [allowAiFallback, authToken, debounceMs, enabled, minChars, query]);

  return { results, loading, error };
}
