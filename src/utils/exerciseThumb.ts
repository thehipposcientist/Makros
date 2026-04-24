// Single source of truth for exercise thumbnails app-wide.
//
// Every exercise uses a YouTube thumbnail — no stick-figure / wger
// static images (they look amateurish next to real video thumbnails).
// Exercises without a curated video_id show a branded placeholder
// until the server's background YouTube resolver populates one.

interface ExerciseLike {
  video_id?: string | null;
  slug?: string | null;
  name?: string | null;
}

// Optional client-side fallback lookup. Populated by HomeScreen once
// the exercise library loads so stale WorkoutPlan snapshots (generated
// before video_id existed on the planner output) can still resolve a
// thumbnail by matching name/slug. Keeps us from needing a forced
// plan regen to unlock previews.
const _libraryIndex: { byName: Map<string, string>; bySlug: Map<string, string> } = {
  byName: new Map(), bySlug: new Map(),
};

function _normName(s: string): string {
  return s.toLowerCase().trim().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
}

export function primeThumbnailIndex(items: Array<{ name?: string; slug?: string | null; video_id?: string | null }>) {
  _libraryIndex.byName.clear();
  _libraryIndex.bySlug.clear();
  for (const it of items) {
    if (!it?.video_id) continue;
    if (it.slug) _libraryIndex.bySlug.set(it.slug.toLowerCase().trim(), it.video_id);
    if (it.name) _libraryIndex.byName.set(_normName(it.name), it.video_id);
  }
}

function resolveVideoId(ex: ExerciseLike | null | undefined): string | null {
  if (!ex) return null;
  if (ex.video_id) return ex.video_id;

  const slug = (ex.slug || '').toLowerCase().trim();
  if (slug && _libraryIndex.bySlug.has(slug)) return _libraryIndex.bySlug.get(slug)!;

  const name = (ex.name || '').trim();
  if (!name) return null;
  const norm = _normName(name);
  if (_libraryIndex.byName.has(norm)) return _libraryIndex.byName.get(norm)!;

  // Fuzzy fallback — stripped plan names ("Alternating Dumbbell Hammer
  // Curl") should still resolve to a library entry ("Hammer Curl") when
  // no exact match exists. We look for a library name that is a suffix
  // or substring of the plan name (never the reverse — that would let
  // "Row" match "Bent-Over Row" incorrectly).
  const tokens = norm.split(' ');
  // Try longest-suffix first (4 tokens, then 3, then 2) so
  // "incline dumbbell bench press" prefers "dumbbell bench press"
  // over "bench press".
  for (let take = Math.min(4, tokens.length - 1); take >= 2; take--) {
    const suffix = tokens.slice(tokens.length - take).join(' ');
    if (_libraryIndex.byName.has(suffix)) return _libraryIndex.byName.get(suffix)!;
  }
  return null;
}

/** Small YouTube thumbnail URL (320×180). Used for exercise rows and
 *  list cells. Returns null when the exercise has no video_id. */
export function exerciseThumbSmall(ex: ExerciseLike | null | undefined): string | null {
  const id = resolveVideoId(ex);
  if (!id) return null;
  return `https://img.youtube.com/vi/${id}/mqdefault.jpg`;
}

/** Medium thumbnail (480×360). Used for the library detail card. */
export function exerciseThumbMedium(ex: ExerciseLike | null | undefined): string | null {
  const id = resolveVideoId(ex);
  if (!id) return null;
  return `https://img.youtube.com/vi/${id}/hqdefault.jpg`;
}
