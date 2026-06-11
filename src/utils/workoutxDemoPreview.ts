export type WorkoutXDemoPreview = {
  id?: string | null;
  label: string | null;
  gifUrl: string;
};

type WorkoutXPreviewContext = {
  authToken?: string | null;
  exerciseName?: string | null;
  equipment?: string | null;
  primaryMuscle?: string | null;
  movementPattern?: string | null;
};

type CacheEntry = {
  savedAt: number;
  demo: WorkoutXDemoPreview | null;
};

const WORKOUTX_PREVIEW_CACHE_TTL_MS = 30 * 60 * 1000;
const workoutxPreviewCache = new Map<string, CacheEntry>();
const workoutxPreviewInflight = new Map<string, Promise<WorkoutXDemoPreview | null>>();

function cacheKey(ctx: WorkoutXPreviewContext): string {
  return [
    ctx.exerciseName ?? '',
    ctx.equipment ?? '',
    ctx.primaryMuscle ?? '',
    ctx.movementPattern ?? '',
  ].join('|').toLowerCase();
}

function absoluteWorkoutXGifUrl(rawUrl: unknown, baseUrl: string): string | null {
  const url = String(rawUrl ?? '').trim();
  if (!url) return null;
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  if (url.startsWith('/')) return `${baseUrl}${url}`;
  return `${baseUrl}/${url.replace(/^\/+/, '')}`;
}

export function normalizeWorkoutXDemoPreview(rawDemo: unknown, baseUrl: string): WorkoutXDemoPreview | null {
  if (!rawDemo || typeof rawDemo !== 'object') return null;
  const demo = rawDemo as Record<string, unknown>;
  const gifUrl = absoluteWorkoutXGifUrl(
    demo.gif_path
      ?? demo.gif_url
      ?? demo.gifUrl
      ?? demo.gif
      ?? demo.preview_url
      ?? demo.thumbnail_url
      ?? demo.image_url
      ?? demo.image
      ?? demo.source_url,
    baseUrl,
  );
  if (!gifUrl) return null;
  return {
    id: typeof demo.id === 'string' ? demo.id : null,
    label: typeof demo.name === 'string' ? demo.name : null,
    gifUrl,
  };
}

export async function loadWorkoutXDemoPreview(ctx: WorkoutXPreviewContext): Promise<WorkoutXDemoPreview | null> {
  const authToken = String(ctx.authToken ?? '').trim();
  const exerciseName = String(ctx.exerciseName ?? '').trim();
  if (!authToken || !exerciseName) return null;

  const key = cacheKey({ ...ctx, exerciseName });
  const cached = workoutxPreviewCache.get(key);
  if (cached && Date.now() - cached.savedAt < WORKOUTX_PREVIEW_CACHE_TTL_MS) {
    return cached.demo;
  }

  const inflight = workoutxPreviewInflight.get(key);
  if (inflight) return inflight;

  const request = (async () => {
    try {
      const { getApiBaseUrl } = await import('../services/api');
      const baseUrl = getApiBaseUrl();
      const res = await fetch(`${baseUrl}/ai/exercise-video`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          exercise_name: exerciseName,
          equipment: ctx.equipment ?? undefined,
          primary_muscle: ctx.primaryMuscle ?? undefined,
          movement_pattern: ctx.movementPattern ?? undefined,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const demo = normalizeWorkoutXDemoPreview(data?.workoutx_demo, baseUrl);
      workoutxPreviewCache.set(key, { savedAt: Date.now(), demo });
      return demo;
    } catch {
      workoutxPreviewCache.set(key, { savedAt: Date.now(), demo: null });
      return null;
    } finally {
      workoutxPreviewInflight.delete(key);
    }
  })();

  workoutxPreviewInflight.set(key, request);
  return request;
}
