/**
 * Activity venue (indoor / outdoor) — single source of truth.
 *
 * Most activities are venue-AMBIGUOUS: you can run on a treadmill or a trail,
 * ride a trainer or a road, play indoor or beach volleyball. Rather than
 * duplicating the activity catalog ("Indoor Run" vs "Outdoor Run" as separate
 * types — which fragments history/stats), venue is a single attribute on the
 * activity. This helper decides:
 *   - which subtypes should show an indoor/outdoor choice (`isVenueAmbiguous`),
 *   - a sensible default so users rarely have to touch it (`defaultVenueForActivity`),
 *   - whether a venue should drive GPS tracking (`venueImpliesGps`).
 *
 * Pure + dependency-free so it's shared by the live start picker, the
 * after-the-fact log modal, the GPS-start decision, and tests.
 */
export type ActivityVenue = 'indoor' | 'outdoor';

function normalize(subtype: string | null | undefined): string {
  return String(subtype ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

// Aliases so "bike"/"cycling" map to the same venue rules as "ride", etc.
const SUBTYPE_ALIASES: Record<string, string> = {
  bike: 'ride', cycling: 'ride', cycle: 'ride',
  running: 'run', jog: 'run', jogging: 'run',
  walking: 'walk', hiking: 'hike',
  rowing: 'row',
  beach_volley_ball: 'beach_volleyball',
  volley_ball: 'volleyball',
};

function canonical(subtype: string | null | undefined): string {
  const s = normalize(subtype);
  return SUBTYPE_ALIASES[s] ?? s;
}

// Inherently single-venue activities — no toggle, just a fixed default.
const FIXED_OUTDOOR = new Set([
  'hike', 'golf', 'surfing', 'surf', 'skiing', 'ski', 'snowboard', 'beach_volleyball',
  'yard_work', 'gardening', 'chopping_wood', 'shoveling',
]);
const FIXED_INDOOR = new Set([
  'spin', 'stationary_bike', 'treadmill', 'stair', 'elliptical', 'skierg', 'ski_erg',
  'pilates', 'stretching', 'hiit', 'crossfit', 'cleaning',
]);

// Genuinely both — show the choice. The value is the default selection.
const AMBIGUOUS_DEFAULTS: Record<string, ActivityVenue> = {
  run: 'outdoor',
  walk: 'outdoor',
  ride: 'outdoor',
  soccer: 'outdoor',
  tennis: 'outdoor',
  pickleball: 'outdoor',
  basketball: 'indoor',
  volleyball: 'indoor',
  swim: 'indoor',   // pool is the common case; user switches to outdoor for open water
  row: 'indoor',    // erg is the common case; switch to outdoor for on-water
  climbing: 'indoor',
  yoga: 'indoor',
  moving: 'indoor',
  construction: 'outdoor',
  playing: 'outdoor',
};

/** True when the user should be offered an indoor/outdoor choice for this
 *  activity (it can genuinely be either). */
export function isVenueAmbiguous(_category: string | null | undefined, subtype: string | null | undefined): boolean {
  return canonical(subtype) in AMBIGUOUS_DEFAULTS;
}

/** The pre-selected venue for an activity. For ambiguous subtypes it returns
 *  the most-common venue (still user-overridable); for fixed ones it returns
 *  their only venue; otherwise falls back to 'outdoor'. */
export function defaultVenueForActivity(_category: string | null | undefined, subtype: string | null | undefined): ActivityVenue {
  const s = canonical(subtype);
  if (FIXED_INDOOR.has(s)) return 'indoor';
  if (FIXED_OUTDOOR.has(s)) return 'outdoor';
  if (s in AMBIGUOUS_DEFAULTS) return AMBIGUOUS_DEFAULTS[s];
  return 'outdoor';
}

/** Whether GPS tracking is meaningful — only outdoors, and only for
 *  distance-on-the-move activities (running/walking/riding/hiking). Indoor
 *  always returns false so a treadmill run or trainer ride doesn't try to
 *  GPS-track. */
export function venueImpliesGps(
  venue: ActivityVenue | null | undefined,
  _category: string | null | undefined,
  subtype: string | null | undefined,
): boolean {
  if (venue === 'indoor') return false;
  const s = canonical(subtype);
  return ['run', 'walk', 'ride', 'hike'].includes(s);
}
