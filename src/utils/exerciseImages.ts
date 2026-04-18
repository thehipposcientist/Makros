import AsyncStorage from '@react-native-async-storage/async-storage';

const CACHE_KEY = 'exercise_image_map_v1';
let _cache: Map<string, string> | null = null;
let _loadPromise: Promise<void> | null = null;

function _ensureLoaded(): void {
  if (_cache !== null) return;
  if (_loadPromise) return;
  _loadPromise = AsyncStorage.getItem(CACHE_KEY).then(raw => {
    if (raw && !_cache) {
      try {
        const parsed = JSON.parse(raw) as Record<string, string>;
        _cache = new Map(Object.entries(parsed));
      } catch {
        _cache = new Map();
      }
    }
    if (!_cache) _cache = new Map();
  }).catch(() => { _cache = new Map(); });
}

// Kick off load immediately on import
_ensureLoaded();

export async function refreshExerciseImageMap(exercises: Array<{ name: string; image_url?: string | null }>): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const ex of exercises) {
    if (ex.image_url) map.set(ex.name.toLowerCase(), ex.image_url);
  }
  _cache = map;
  try {
    await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(map)));
  } catch {}
  return map;
}

export function getExerciseImage(name: string): string | undefined {
  if (!_cache) {
    _ensureLoaded();
    return undefined;
  }
  return _cache.get((name || '').toLowerCase());
}
