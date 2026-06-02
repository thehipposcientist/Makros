import type { ActivityCategory, CardioStyle } from '../types';
import type { ActivityVenue } from './activityVenue';

export interface LiveActivityQuickStartOption {
  category: ActivityCategory;
  subtype: string;
  label: string;
  icon: string;
  cardioStyle?: CardioStyle;
  /** Indoor/outdoor for venue-ambiguous activities. The subtype stays the
   *  same (one activity type); venue is the attribute. The label encodes it
   *  too ("Outdoor Run" / "Indoor Run") so the existing label-based GPS
   *  decision (activityFromFocus) and history display pick it up for free. */
  venue?: ActivityVenue;
}

export interface LiveActivityInitialActivity {
  category?: ActivityCategory | string | null;
  subtype?: string | null;
  label?: string | null;
  venue?: ActivityVenue | null;
  /** When the LiveActivityTracker is opened in response to a watch
   *  `start_custom_workout` command, the watch has already minted a
   *  sessionId (prefix `watch-`) and pushed an active state to itself.
   *  Carrying that id through here lets the phone-side push re-use it
   *  so both devices end the session under the same identity instead
   *  of accumulating duplicate sessionIds. */
  sessionId?: string | null;
}

export const LIVE_ACTIVITY_QUICK_START: LiveActivityQuickStartOption[] = [
  { category: 'strength', subtype: 'lift',         label: 'Strength',  icon: 'barbell-outline' },
  { category: 'strength', subtype: 'push',         label: 'Push',      icon: 'barbell-outline' },
  { category: 'strength', subtype: 'pull',         label: 'Pull',      icon: 'barbell-outline' },
  { category: 'strength', subtype: 'legs',         label: 'Legs',      icon: 'barbell-outline' },
  { category: 'strength', subtype: 'upper',        label: 'Upper',     icon: 'barbell-outline' },
  { category: 'strength', subtype: 'lower',        label: 'Lower',     icon: 'barbell-outline' },
  { category: 'strength', subtype: 'full_body',    label: 'Full Body', icon: 'barbell-outline' },
  { category: 'strength', subtype: 'powerlifting', label: 'Powerlifting', icon: 'barbell-outline' },
  { category: 'strength', subtype: 'crossfit',     label: 'CrossFit',  icon: 'flame-outline' },
  // Venue-ambiguous activities are offered as indoor/outdoor pairs (one
  // subtype + venue). The label carries the venue so the existing label-based
  // GPS decision (activityFromFocus) starts GPS for outdoor distance cardio
  // and stays quiet for indoor variants.
  { category: 'cardio', subtype: 'run',    label: 'Outdoor Run', icon: 'walk-outline', cardioStyle: 'steady', venue: 'outdoor' },
  { category: 'cardio', subtype: 'run',    label: 'Indoor Run',  icon: 'speedometer-outline', cardioStyle: 'steady', venue: 'indoor' },
  { category: 'cardio', subtype: 'walk',   label: 'Outdoor Walk', icon: 'footsteps-outline', cardioStyle: 'easy', venue: 'outdoor' },
  { category: 'cardio', subtype: 'walk',   label: 'Indoor Walk',  icon: 'walk-outline', cardioStyle: 'easy', venue: 'indoor' },
  { category: 'cardio', subtype: 'hike',   label: 'Hike',   icon: 'trail-sign-outline', cardioStyle: 'steady', venue: 'outdoor' },
  { category: 'cardio', subtype: 'ride',   label: 'Outdoor Ride', icon: 'bicycle-outline', cardioStyle: 'steady', venue: 'outdoor' },
  { category: 'cardio', subtype: 'ride',   label: 'Indoor Ride',  icon: 'fitness-outline', cardioStyle: 'steady', venue: 'indoor' },
  { category: 'cardio', subtype: 'spin',   label: 'Spin',   icon: 'fitness-outline', cardioStyle: 'intervals', venue: 'indoor' },
  { category: 'cardio', subtype: 'swim',   label: 'Pool Swim',  icon: 'water-outline', cardioStyle: 'steady', venue: 'indoor' },
  { category: 'cardio', subtype: 'swim',   label: 'Open Water Swim', icon: 'water-outline', cardioStyle: 'steady', venue: 'outdoor' },
  { category: 'cardio', subtype: 'row',    label: 'Indoor Row',  icon: 'boat-outline', cardioStyle: 'steady', venue: 'indoor' },
  { category: 'cardio', subtype: 'row',    label: 'Outdoor Row', icon: 'boat-outline', cardioStyle: 'steady', venue: 'outdoor' },
  { category: 'cardio', subtype: 'stair',  label: 'Stair',  icon: 'trending-up-outline', cardioStyle: 'steady', venue: 'indoor' },
  { category: 'cardio', subtype: 'hiit', label: 'HIIT', icon: 'flame-outline', cardioStyle: 'intervals', venue: 'indoor' },
  { category: 'sport',  subtype: 'soccer', label: 'Outdoor Soccer', icon: 'football-outline', cardioStyle: 'intervals', venue: 'outdoor' },
  { category: 'sport',  subtype: 'soccer', label: 'Indoor Soccer', icon: 'football-outline', cardioStyle: 'intervals', venue: 'indoor' },
  { category: 'sport',  subtype: 'basketball', label: 'Indoor Basketball', icon: 'basketball-outline', cardioStyle: 'intervals', venue: 'indoor' },
  { category: 'sport',  subtype: 'basketball', label: 'Outdoor Basketball', icon: 'basketball-outline', cardioStyle: 'intervals', venue: 'outdoor' },
  { category: 'sport',  subtype: 'tennis', label: 'Outdoor Tennis', icon: 'tennisball-outline', cardioStyle: 'intervals', venue: 'outdoor' },
  { category: 'sport',  subtype: 'tennis', label: 'Indoor Tennis', icon: 'tennisball-outline', cardioStyle: 'intervals', venue: 'indoor' },
  { category: 'sport',  subtype: 'pickleball', label: 'Outdoor Pickleball', icon: 'tennisball-outline', cardioStyle: 'intervals', venue: 'outdoor' },
  { category: 'sport',  subtype: 'pickleball', label: 'Indoor Pickleball', icon: 'tennisball-outline', cardioStyle: 'intervals', venue: 'indoor' },
  { category: 'sport',  subtype: 'volleyball', label: 'Indoor Volleyball', icon: 'basketball-outline', cardioStyle: 'intervals', venue: 'indoor' },
  { category: 'sport',  subtype: 'volleyball', label: 'Outdoor Volleyball', icon: 'basketball-outline', cardioStyle: 'intervals', venue: 'outdoor' },
  { category: 'sport',  subtype: 'beach_volleyball', label: 'Beach Volleyball', icon: 'sunny-outline', cardioStyle: 'intervals', venue: 'outdoor' },
  { category: 'sport',  subtype: 'golf',  label: 'Golf',   icon: 'golf-outline', venue: 'outdoor' },
  { category: 'sport',  subtype: 'martial_arts', label: 'Martial Arts', icon: 'shield-outline', cardioStyle: 'intervals', venue: 'indoor' },
  { category: 'mobility', subtype: 'yoga', label: 'Indoor Yoga',  icon: 'body-outline', venue: 'indoor' },
  { category: 'mobility', subtype: 'yoga', label: 'Outdoor Yoga', icon: 'sunny-outline', venue: 'outdoor' },
  { category: 'mobility', subtype: 'pilates', label: 'Pilates', icon: 'body-outline' },
  { category: 'mobility', subtype: 'stretching', label: 'Stretch', icon: 'resize-outline' },
];

const SUBTYPE_ALIASES: Record<string, string> = {
  bike: 'ride',
  cycling: 'ride',
  cycle: 'ride',
  running: 'run',
  walking: 'walk',
  hiking: 'hike',
  volley_ball: 'volleyball',
  beach_volley_ball: 'beach_volleyball',
  beach_volleyball: 'beach_volleyball',
  martial: 'martial_arts',
  martial_art: 'martial_arts',
  martial_arts: 'martial_arts',
  mma: 'martial_arts',
  stairs: 'stair',
  stair_climber: 'stair',
  hiit: 'hiit',
  bootcamp: 'hiit',
  boot_camp: 'hiit',
  yoga_flow: 'yoga',
  pilate: 'pilates',
  stretch: 'stretching',
  strength: 'lift',
  lifting: 'lift',
};

function normalizeToken(value: string | null | undefined): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

function normalizeSubtype(value: string | null | undefined): string {
  const normalized = normalizeToken(value);
  return SUBTYPE_ALIASES[normalized] ?? normalized;
}

export function liveActivityQuickStartKey(option: LiveActivityQuickStartOption): string {
  // Venue suffix only when present, so split tiles (Outdoor/Indoor Run) get
  // distinct keys while single-venue tiles keep their stable `category:subtype`.
  return option.venue
    ? `${option.category}:${option.subtype}:${option.venue}`
    : `${option.category}:${option.subtype}`;
}

export function resolveLiveActivityQuickStart(
  input: LiveActivityInitialActivity | null | undefined,
): LiveActivityQuickStartOption | null {
  if (!input) return null;
  const category = normalizeToken(input.category ?? null);
  const subtype = normalizeSubtype(input.subtype);
  const label = normalizeToken(input.label ?? null);
  const venue = input.venue === 'indoor' || input.venue === 'outdoor' ? input.venue : null;
  if (!subtype && !label) return null;

  if (label) {
    const byLabel = LIVE_ACTIVITY_QUICK_START.find(option =>
      normalizeToken(option.label) === label && (!category || option.category === category)
    );
    if (byLabel) return byLabel;
  }

  if (!subtype) return null;

  if (venue) {
    const byVenue = LIVE_ACTIVITY_QUICK_START.find(option =>
      option.subtype === subtype && option.venue === venue && (!category || option.category === category)
    );
    if (byVenue) return byVenue;
  }

  const exact = LIVE_ACTIVITY_QUICK_START.find(option =>
    option.subtype === subtype && (!category || option.category === category)
  );
  if (exact) return exact;

  return LIVE_ACTIVITY_QUICK_START.find(option =>
    normalizeToken(option.label) === subtype && (!category || option.category === category)
  ) ?? null;
}
