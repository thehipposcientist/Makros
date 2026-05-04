import type { ActivityCategory, CardioStyle } from '../types';

export interface LiveActivityQuickStartOption {
  category: ActivityCategory;
  subtype: string;
  label: string;
  icon: string;
  cardioStyle?: CardioStyle;
}

export interface LiveActivityInitialActivity {
  category?: ActivityCategory | string | null;
  subtype?: string | null;
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
  { category: 'cardio', subtype: 'run',    label: 'Run',    icon: 'walk-outline', cardioStyle: 'steady' },
  { category: 'cardio', subtype: 'walk',   label: 'Walk',   icon: 'footsteps-outline', cardioStyle: 'easy' },
  { category: 'cardio', subtype: 'hike',   label: 'Hike',   icon: 'trail-sign-outline', cardioStyle: 'steady' },
  { category: 'cardio', subtype: 'ride',   label: 'Ride',   icon: 'bicycle-outline', cardioStyle: 'steady' },
  { category: 'cardio', subtype: 'swim',   label: 'Swim',   icon: 'water-outline', cardioStyle: 'steady' },
  { category: 'cardio', subtype: 'row',    label: 'Row',    icon: 'boat-outline', cardioStyle: 'steady' },
  { category: 'cardio', subtype: 'spin',   label: 'Spin',   icon: 'fitness-outline', cardioStyle: 'intervals' },
  { category: 'cardio', subtype: 'stair',  label: 'Stair',  icon: 'trending-up-outline', cardioStyle: 'steady' },
  { category: 'cardio', subtype: 'bootcamp', label: 'HIIT', icon: 'flame-outline', cardioStyle: 'intervals' },
  { category: 'sport',  subtype: 'basketball', label: 'Basketball', icon: 'basketball-outline' },
  { category: 'sport',  subtype: 'tennis', label: 'Tennis', icon: 'tennisball-outline' },
  { category: 'sport',  subtype: 'pickleball', label: 'Pickleball', icon: 'tennisball-outline' },
  { category: 'sport',  subtype: 'golf',  label: 'Golf',   icon: 'golf-outline' },
  { category: 'mobility', subtype: 'yoga', label: 'Yoga',  icon: 'body-outline' },
  { category: 'mobility', subtype: 'stretching', label: 'Stretch', icon: 'resize-outline' },
];

const SUBTYPE_ALIASES: Record<string, string> = {
  bike: 'ride',
  cycling: 'ride',
  cycle: 'ride',
  running: 'run',
  walking: 'walk',
  hiking: 'hike',
  stairs: 'stair',
  stair_climber: 'stair',
  hiit: 'bootcamp',
  yoga_flow: 'yoga',
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
  return `${option.category}:${option.subtype}`;
}

export function resolveLiveActivityQuickStart(
  input: LiveActivityInitialActivity | null | undefined,
): LiveActivityQuickStartOption | null {
  if (!input) return null;
  const category = normalizeToken(input.category ?? null);
  const subtype = normalizeSubtype(input.subtype);
  if (!subtype) return null;

  const exact = LIVE_ACTIVITY_QUICK_START.find(option =>
    option.subtype === subtype && (!category || option.category === category)
  );
  if (exact) return exact;

  return LIVE_ACTIVITY_QUICK_START.find(option =>
    normalizeToken(option.label) === subtype && (!category || option.category === category)
  ) ?? null;
}
