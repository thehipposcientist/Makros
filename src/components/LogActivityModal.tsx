import { useState, useCallback, useEffect, useMemo } from 'react';
import type { ReactNode } from 'react';
import {
  View, Text, Modal, TouchableOpacity, TextInput, ScrollView, ImageBackground,
  KeyboardAvoidingView,
  StyleSheet, Alert, UIManager, Platform,
} from 'react-native';
import type { ImageSourcePropType } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getContrastingTextColor, getTheme } from '../constants/theme';
import { configureExpandAnimation } from '../utils/layoutAnim';
import {
  AppThemeName, WorkoutSession,
  ActivityCategory, ActivityIntensity, ActivitySource, CardioStyle,
} from '../types';
import { parseWorkoutPhoto } from '../services/api';
import PressableScale from './PressableScale';
import NumberWheelPicker from './NumberWheelPicker';
import BottomSheetDismissHandle from './BottomSheetDismissHandle';
import { estimateRouteElevationGainFt } from '../utils/cardioGpsTracker';
import { estimateActivityCaloriesDetailed } from '../utils/activityEnergy';
import { isVenueAmbiguous, defaultVenueForActivity } from '../utils/activityVenue';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

// ─── Category definitions ────────────────────────────────────────────────────

const CATEGORIES: { key: ActivityCategory; label: string; icon: string; desc: string; image: ImageSourcePropType }[] = [
  {
    key: 'strength',
    label: 'Strength',
    icon: 'barbell-outline',
    desc: 'Weights, resistance',
    image: require('../../assets/images/card-backgrounds/workout-card-free-weights-day-male.jpg'),
  },
  {
    key: 'cardio',
    label: 'Cardio',
    icon: 'bicycle-outline',
    desc: 'Running, cycling, swim',
    image: require('../../assets/images/card-backgrounds/workout-card-cycling-day.jpg'),
  },
  {
    key: 'mobility',
    label: 'Mobility',
    icon: 'body-outline',
    desc: 'Yoga, stretching',
    image: require('../../assets/images/card-backgrounds/workout-card-recovery-day-female.jpg'),
  },
  {
    key: 'sport',
    label: 'Sport',
    icon: 'basketball-outline',
    desc: 'Basketball, soccer, etc',
    image: require('../../assets/images/card-backgrounds/workout-card-soccer-day.jpg'),
  },
  {
    key: 'active',
    label: 'Active',
    icon: 'hammer-outline',
    desc: 'Yard work, labor, play',
    image: require('../../assets/images/card-backgrounds/workout-card-yard-work-day.jpg'),
  },
  {
    key: 'recovery',
    label: 'Recovery',
    icon: 'bed-outline',
    desc: 'Sauna, ice bath, rest',
    image: require('../../assets/images/card-backgrounds/workout-card-sauna-day.jpg'),
  },
];

type SubtypeDef = { key: string; label: string; icon: string; cardioStyle?: CardioStyle; desc?: string; image?: ImageSourcePropType };

const SUBTYPES: Record<ActivityCategory, SubtypeDef[]> = {
  strength: [
    {
      key: 'push',
      label: 'Push',
      icon: 'arrow-up-outline',
      desc: 'Chest, shoulders',
      image: require('../../assets/images/card-backgrounds/workout-card-push-day-male.jpg'),
    },
    {
      key: 'pull',
      label: 'Pull',
      icon: 'arrow-down-outline',
      desc: 'Back, biceps',
      image: require('../../assets/images/card-backgrounds/workout-card-pull-day-male.jpg'),
    },
    {
      key: 'legs',
      label: 'Legs',
      icon: 'footsteps-outline',
      desc: 'Squat focus',
      image: require('../../assets/images/card-backgrounds/workout-card-legs-day-male.jpg'),
    },
    {
      key: 'upper_body',
      label: 'Upper Body',
      icon: 'body-outline',
      desc: 'Torso work',
      image: require('../../assets/images/card-backgrounds/workout-card-free-weights-day-male.jpg'),
    },
    {
      key: 'lower_body',
      label: 'Lower Body',
      icon: 'fitness-outline',
      desc: 'Hips, legs',
      image: require('../../assets/images/card-backgrounds/workout-card-hinge-day-female.jpg'),
    },
    {
      key: 'full_body',
      label: 'Full Body',
      icon: 'expand-outline',
      desc: 'Total session',
      image: require('../../assets/images/card-backgrounds/workout-card-generic-gym-day-neutral.jpg'),
    },
  ],
  cardio: [
    {
      key: 'walk',
      label: 'Walk',
      icon: 'walk-outline',
      desc: 'Easy miles',
      image: require('../../assets/images/card-backgrounds/workout-card-walking-day.jpg'),
    },
    {
      key: 'run',
      label: 'Run',
      icon: 'footsteps-outline',
      desc: 'Road or trail',
      image: require('../../assets/images/card-backgrounds/workout-card-running-day-male.jpg'),
    },
    {
      key: 'ride',
      label: 'Ride',
      icon: 'bicycle-outline',
      desc: 'Bike session',
      image: require('../../assets/images/card-backgrounds/workout-card-cycling-day.jpg'),
    },
    {
      key: 'spin',
      label: 'Spin Class',
      icon: 'fitness-outline',
      desc: 'Indoor ride',
      image: require('../../assets/images/card-backgrounds/workout-card-spin-class-day.jpg'),
    },
    {
      key: 'hike',
      label: 'Hike',
      icon: 'trail-sign-outline',
      desc: 'Trail effort',
      image: require('../../assets/images/card-backgrounds/workout-card-hiking-mountains-day.jpg'),
    },
    {
      key: 'swim',
      label: 'Swim',
      icon: 'water-outline',
      desc: 'Pool or open water',
      image: require('../../assets/images/card-backgrounds/workout-card-swimming-day-neutral.jpg'),
    },
    {
      key: 'row',
      label: 'Row',
      icon: 'boat-outline',
      desc: 'Erg or water',
      image: require('../../assets/images/card-backgrounds/workout-card-pull-day-rowing.jpg'),
    },
    {
      key: 'stair',
      label: 'Stair',
      icon: 'trending-up-outline',
      desc: 'Climber work',
      image: require('../../assets/images/card-backgrounds/workout-card-stair-day.jpg'),
    },
    {
      key: 'elliptical',
      label: 'Elliptical',
      icon: 'sync-outline',
      desc: 'Low impact',
      image: require('../../assets/images/card-backgrounds/workout-card-elliptical-day.jpg'),
    },
    {
      key: 'hiit',
      label: 'HIIT',
      icon: 'flame-outline',
      cardioStyle: 'intervals',
      desc: 'Intervals',
      image: require('../../assets/images/card-backgrounds/workout-card-hiit-day-female.jpg'),
    },
    {
      key: 'bootcamp',
      label: 'Bootcamp',
      icon: 'flash-outline',
      cardioStyle: 'intervals',
      desc: 'Class circuit',
      image: require('../../assets/images/card-backgrounds/workout-card-hiit-day-male.jpg'),
    },
    {
      key: 'other',
      label: 'Other',
      icon: 'ellipsis-horizontal-outline',
      desc: 'Cardio work',
      image: require('../../assets/images/card-backgrounds/workout-card-treadmill-day-neutral.jpg'),
    },
  ],
  mobility: [
    {
      key: 'yoga',
      label: 'Yoga',
      icon: 'body-outline',
      desc: 'Flow or holds',
      image: require('../../assets/images/card-backgrounds/workout-card-yoga-day.jpg'),
    },
    {
      key: 'stretching',
      label: 'Stretching',
      icon: 'resize-outline',
      desc: 'Flexibility',
      image: require('../../assets/images/card-backgrounds/workout-card-stretching-day.jpg'),
    },
    {
      key: 'foam_roll',
      label: 'Foam Roll',
      icon: 'ellipse-outline',
      desc: 'Soft tissue',
      image: require('../../assets/images/card-backgrounds/workout-card-foam-roll-day.jpg'),
    },
    {
      key: 'pilates',
      label: 'Pilates',
      icon: 'flower-outline',
      desc: 'Core control',
      image: require('../../assets/images/card-backgrounds/workout-card-pilates-day.jpg'),
    },
  ],
  sport: [
    {
      key: 'basketball',
      label: 'Basketball',
      icon: 'basketball-outline',
      desc: 'Court play',
      image: require('../../assets/images/card-backgrounds/workout-card-basketball-day.jpg'),
    },
    {
      key: 'soccer',
      label: 'Soccer',
      icon: 'football-outline',
      desc: 'Pitch work',
      image: require('../../assets/images/card-backgrounds/workout-card-soccer-day.jpg'),
    },
    {
      key: 'tennis',
      label: 'Tennis',
      icon: 'tennisball-outline',
      desc: 'Court match',
      image: require('../../assets/images/card-backgrounds/workout-card-tennis-day.jpg'),
    },
    {
      key: 'pickleball',
      label: 'Pickleball',
      icon: 'tennisball-outline',
      desc: 'Paddle play',
      image: require('../../assets/images/card-backgrounds/workout-card-pickleball-day.jpg'),
    },
    {
      key: 'volleyball',
      label: 'Volleyball',
      icon: 'basketball-outline',
      cardioStyle: 'intervals',
      desc: 'Court rounds',
      image: require('../../assets/images/card-backgrounds/workout-card-volleyball-day.jpg'),
    },
    {
      key: 'beach_volleyball',
      label: 'Beach Volleyball',
      icon: 'sunny-outline',
      cardioStyle: 'intervals',
      desc: 'Sand play',
      image: require('../../assets/images/card-backgrounds/workout-card-beach-volleyball-day.jpg'),
    },
    {
      key: 'golf',
      label: 'Golf',
      icon: 'golf-outline',
      desc: 'Course walk',
      image: require('../../assets/images/card-backgrounds/workout-card-golf-day.jpg'),
    },
    {
      key: 'climbing',
      label: 'Climbing',
      icon: 'trending-up-outline',
      desc: 'Wall or rock',
      image: require('../../assets/images/card-backgrounds/workout-card-climbing-day.jpg'),
    },
    {
      key: 'boxing',
      label: 'Boxing',
      icon: 'hand-right-outline',
      desc: 'Glove work',
      image: require('../../assets/images/card-backgrounds/workout-card-boxing-day.jpg'),
    },
    {
      key: 'kickboxing',
      label: 'Kickboxing',
      icon: 'hand-left-outline',
      desc: 'Striking work',
      image: require('../../assets/images/card-backgrounds/workout-card-kickboxing-day.jpg'),
    },
    {
      key: 'martial_arts',
      label: 'Martial Arts',
      icon: 'shield-outline',
      desc: 'Skill rounds',
      image: require('../../assets/images/card-backgrounds/workout-card-martial-arts-day.jpg'),
    },
    {
      key: 'surfing',
      label: 'Surfing',
      icon: 'water-outline',
      desc: 'Wave session',
      image: require('../../assets/images/card-backgrounds/workout-card-surfing-day.jpg'),
    },
    {
      key: 'skiing',
      label: 'Skiing',
      icon: 'snow-outline',
      desc: 'Snow sport',
      image: require('../../assets/images/card-backgrounds/workout-card-skiing-day.jpg'),
    },
    {
      key: 'other',
      label: 'Other',
      icon: 'ellipsis-horizontal-outline',
      desc: 'Sport play',
      image: require('../../assets/images/card-backgrounds/workout-card-football-day-male.jpg'),
    },
  ],
  active: [
    {
      key: 'yard_work',
      label: 'Yard Work',
      icon: 'leaf-outline',
      desc: 'Outdoor chores',
      image: require('../../assets/images/card-backgrounds/workout-card-yard-work-day.jpg'),
    },
    {
      key: 'chopping_wood',
      label: 'Chopping Wood',
      icon: 'hammer-outline',
      desc: 'Axe work',
      image: require('../../assets/images/card-backgrounds/workout-card-chopping-wood-day.jpg'),
    },
    {
      key: 'moving',
      label: 'Moving / Lifting',
      icon: 'cube-outline',
      desc: 'Boxes, furniture',
      image: require('../../assets/images/card-backgrounds/workout-card-moving-day.jpg'),
    },
    {
      key: 'gardening',
      label: 'Gardening',
      icon: 'flower-outline',
      desc: 'Plant care',
      image: require('../../assets/images/card-backgrounds/workout-card-gardening-day.jpg'),
    },
    {
      key: 'cleaning',
      label: 'House Cleaning',
      icon: 'home-outline',
      desc: 'Home chores',
      image: require('../../assets/images/card-backgrounds/workout-card-cleaning-day.jpg'),
    },
    {
      key: 'construction',
      label: 'Construction',
      icon: 'construct-outline',
      desc: 'Job site labor',
      image: require('../../assets/images/card-backgrounds/workout-card-construction-day.jpg'),
    },
    {
      key: 'shoveling',
      label: 'Shoveling',
      icon: 'snow-outline',
      desc: 'Snow or soil',
      image: require('../../assets/images/card-backgrounds/workout-card-shoveling-day.jpg'),
    },
    {
      key: 'playing',
      label: 'Playing w/ Kids',
      icon: 'happy-outline',
      desc: 'Family play',
      image: require('../../assets/images/card-backgrounds/workout-card-playing-day.jpg'),
    },
    {
      key: 'dancing',
      label: 'Dancing',
      icon: 'musical-notes-outline',
      desc: 'Dance session',
      image: require('../../assets/images/card-backgrounds/workout-card-dancing-day.jpg'),
    },
    {
      key: 'other',
      label: 'Other',
      icon: 'ellipsis-horizontal-outline',
      desc: 'Active day',
      image: require('../../assets/images/card-backgrounds/workout-card-yard-work-day.jpg'),
    },
  ],
  recovery: [
    {
      key: 'finnish_sauna',
      label: 'Finnish Sauna',
      icon: 'flame-outline',
      desc: 'Dry heat',
      image: require('../../assets/images/card-backgrounds/workout-card-sauna-day.jpg'),
    },
    {
      key: 'infrared_sauna',
      label: 'Infrared Sauna',
      icon: 'sunny-outline',
      desc: 'Radiant heat',
      image: require('../../assets/images/card-backgrounds/workout-card-infrared-sauna-day.jpg'),
    },
    {
      key: 'cold_plunge',
      label: 'Cold Plunge',
      icon: 'snow-outline',
      desc: 'Water exposure',
      image: require('../../assets/images/card-backgrounds/workout-card-cold-plunge-day.jpg'),
    },
    {
      key: 'contrast',
      label: 'Contrast',
      icon: 'swap-vertical-outline',
      desc: 'Hot / cold rounds',
      image: require('../../assets/images/card-backgrounds/workout-card-contrast-day.jpg'),
    },
    {
      key: 'breathwork',
      label: 'Breathwork',
      icon: 'cloud-outline',
      desc: 'Downshift',
      image: require('../../assets/images/card-backgrounds/workout-card-breathwork-day.jpg'),
    },
    {
      key: 'stretching',
      label: 'Stretching',
      icon: 'resize-outline',
      desc: 'Easy tissue work',
      image: require('../../assets/images/card-backgrounds/workout-card-recovery-day-female.jpg'),
    },
    {
      key: 'walk',
      label: 'Walk',
      icon: 'walk-outline',
      desc: 'Low intensity',
      image: require('../../assets/images/card-backgrounds/workout-card-walking-day.jpg'),
    },
    {
      key: 'sleep',
      label: 'Sleep',
      icon: 'moon-outline',
      desc: 'Rest block',
      image: require('../../assets/images/card-backgrounds/workout-card-meditation-day.jpg'),
    },
    {
      key: 'meditation',
      label: 'Meditation',
      icon: 'leaf-outline',
      desc: 'Quiet recovery',
      image: require('../../assets/images/card-backgrounds/workout-card-meditation-day.jpg'),
    },
    {
      key: 'general',
      label: 'General',
      icon: 'heart-outline',
      desc: 'Other recovery',
      image: require('../../assets/images/card-backgrounds/workout-card-recovery-day-female.jpg'),
    },
  ],
};

// `colorKey` maps to a theme token at render time so the chips track the
// active theme (success/warning/error) instead of hardcoded hex.
const INTENSITIES: { key: ActivityIntensity; label: string; icon: string; colorKey: 'success' | 'warning' | 'error' }[] = [
  { key: 'easy',     label: 'Easy',     icon: 'leaf-outline',  colorKey: 'success' },
  { key: 'moderate', label: 'Moderate', icon: 'flash-outline', colorKey: 'warning' },
  { key: 'hard',     label: 'Hard',     icon: 'flame-outline', colorKey: 'error' },
];

const CARDIO_STYLES: { key: CardioStyle; label: string }[] = [
  { key: 'recovery',  label: 'Recovery' },
  { key: 'steady',    label: 'Steady State' },
  { key: 'intervals', label: 'Intervals' },
  { key: 'class',     label: 'Class / Guided' },
];

const ACTIVITY_DATE_LOOKBACK_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function activityDateFromOffset(offset: number, today = new Date()): Date {
  const date = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 12);
  date.setDate(date.getDate() + offset);
  return date;
}

function activityMonthStart(date = new Date()): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1, 12);
}

function clampActivityDateOffset(offset: number): number {
  return Math.max(-ACTIVITY_DATE_LOOKBACK_DAYS, Math.min(0, offset));
}

function calendarDayOffsetFromToday(date: Date, today = new Date()): number {
  const target = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  const base = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((target - base) / MS_PER_DAY);
}

function parseActivityDate(value?: string | null): Date | null {
  if (!value) return null;
  if (value.includes('T')) {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (match) {
    return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12);
  }
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

// ─── Legacy focus mapping ────────────────────────────────────────────────────

const LEGACY_FOCUS: Record<string, Record<string, string>> = {
  strength: { push: 'Push', pull: 'Pull', legs: 'Legs', upper_body: 'Upper Body', lower_body: 'Lower Body', full_body: 'Full Body' },
  cardio:   { walk: 'Walking', run: 'Running', ride: 'Cycling', spin: 'Spin Class', hike: 'Hiking', swim: 'Swimming', row: 'Rowing', stair: 'Cardio', elliptical: 'Cardio', hiit: 'HIIT', bootcamp: 'HIIT', other: 'Cardio' },
  mobility: { yoga: 'Yoga', stretching: 'Stretching', foam_roll: 'Foam Rolling', pilates: 'Pilates' },
  // Sport focus labels intentionally preserve the sport name (not a generic
  // "Cardio") so gear auto-accumulation can match by keyword — e.g. logging
  // a Climbing session bumps climbing_shoe sessions, Boxing bumps boxing_gloves.
  sport:    { basketball: 'Basketball', soccer: 'Soccer', tennis: 'Tennis', pickleball: 'Pickleball', volleyball: 'Volleyball', beach_volleyball: 'Beach Volleyball', golf: 'Golf', climbing: 'Climbing', boxing: 'Boxing', kickboxing: 'Kickboxing', martial_arts: 'Martial Arts', surfing: 'Surfing', skiing: 'Skiing', other: 'Sport' },
  active:   { yard_work: 'Full Body', chopping_wood: 'Full Body', moving: 'Full Body', gardening: 'Cardio', cleaning: 'Cardio', construction: 'Full Body', shoveling: 'Full Body', playing: 'Cardio', dancing: 'Cardio', other: 'Cardio' },
  recovery: {
    finnish_sauna: 'Recovery', infrared_sauna: 'Recovery', cold_plunge: 'Recovery',
    contrast: 'Recovery', breathwork: 'Recovery', stretching: 'Recovery',
    walk: 'Recovery', sleep: 'Recovery', meditation: 'Recovery', general: 'Recovery',
    // Legacy keys — preserved so historical sessions still map.
    sauna: 'Recovery', ice_bath: 'Recovery',
  },
};

function getLegacyFocus(category: ActivityCategory, subtype: string, custom?: string): string {
  if (custom?.trim()) return custom.trim();
  return LEGACY_FOCUS[category]?.[subtype] ?? 'General';
}

function numericField(value: string): number | null {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

// ─── Component ───────────────────────────────────────────────────────────────

/** Optional seed values. Used by the Apple Health detected-workouts
 *  flow to pre-fill the modal from HK metadata so the user only has
 *  to confirm the classification + adjust intensity. `externalId`,
 *  when supplied, is used as the session id so the same HK workout
 *  can't be imported twice (matches the `hk_<startMs>` format that
 *  `workoutAutoImport.detectUnloggedWorkouts` filters on). */
export interface LogActivityPrefill {
  externalId?: string;
  dateISO?: string;
  durationMin?: number;
  category?: ActivityCategory;
  subtype?: string;
  cardioStyle?: CardioStyle;
  /** Indoor/outdoor chosen at the start of a live session, carried through so
   *  the save form pre-selects the right venue instead of the subtype default. */
  indoorOutdoor?: 'indoor' | 'outdoor';
  distanceMiles?: number | null;
  caloriesBurned?: number | null;
  avgHeartRate?: number | null;
  elevationGainFt?: number | null;
  startedAtISO?: string;
  endedAtISO?: string;
  source?: ActivitySource;
  /** GPS route trail captured live during the session — passed
   *  through to manualActivity.routeCoords on save so the post-workout
   *  map and HKWorkoutRouteBuilder write both fire. Indoor cardio +
   *  lifting omit. */
  routeCoords?: Array<{ lat: number; lon: number; t_ms: number; acc_m?: number | null; alt_m?: number | null; v_acc_m?: number | null }>;
}

interface Props {
  visible: boolean;
  onClose: () => void;
  onSave: (session: WorkoutSession) => Promise<void>;
  themeName?: AppThemeName;
  /** Pre-populate the form from external data (Apple Health import,
   *  finishing a live-tracker session, etc). When present the user
   *  lands directly on the classification step. */
  prefill?: LogActivityPrefill | null;
  authToken?: string | null;
  appleHealthImportSlot?: ReactNode;
  bodyweightLbs?: number | null;
  /** Previously-logged custom activities the user has saved before. The
   *  modal surfaces them as additional Step-2 cards (filtered to the
   *  currently-selected category) so picking the same custom activity
   *  again is one tap, not a re-type. Pass an empty list / omit to disable. */
  recentCustomSubtypes?: Array<{ category: string; subtype: string }>;
}

/** A temperature/humidity detail field rendered as an iOS-style scroll wheel
 *  instead of a keyboard input. Because a wheel always has a selected value,
 *  it seeds a sensible default into the (string) form state the first time it
 *  appears empty so the displayed value is the value that gets saved. */
function DetailWheelField({
  label, value, setValue, min, max, step = 1, fallback, tc, testID, formatLabel,
}: {
  label: string;
  value: string;
  setValue: (v: string) => void;
  min: number;
  max: number;
  step?: number;
  fallback: number;
  tc: ReturnType<typeof getTheme>['colors'];
  testID?: string;
  formatLabel?: (v: number) => string;
}) {
  const values = useMemo(() => {
    const out: number[] = [];
    for (let v = min; v <= max; v += step) out.push(Math.round(v * 100) / 100);
    return out;
  }, [min, max, step]);
  const parsed = Number(value);
  const hasValue = value.trim() !== '' && Number.isFinite(parsed);
  useEffect(() => {
    if (!hasValue) setValue(String(fallback));
    // Seed once on mount; subtype switches unmount/remount this field.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const current = hasValue
    ? values.reduce((best, v) => (Math.abs(v - parsed) < Math.abs(best - parsed) ? v : best), values[0] ?? fallback)
    : fallback;
  return (
    <View style={s.detailInputWrap}>
      <Text style={[s.detailInputLabel, { color: tc.textMuted }]}>{label}</Text>
      <View style={[s.detailWheelFrame, { backgroundColor: tc.background, borderColor: tc.border }]}>
        <NumberWheelPicker
          testID={testID}
          values={values}
          value={current}
          onChange={(v) => setValue(String(v))}
          itemHeight={32}
          visibleCount={3}
          selectedColor={tc.textPrimary}
          mutedColor={tc.textMuted}
          dividerColor={tc.primary + '55'}
          formatLabel={formatLabel ? (v) => formatLabel(v as number) : undefined}
        />
      </View>
    </View>
  );
}

export default function LogActivityModal({ visible, onClose, onSave, themeName, prefill, authToken, appleHealthImportSlot, bodyweightLbs, recentCustomSubtypes }: Props) {
  const tc = getTheme(themeName).colors;

  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [category, setCategory] = useState<ActivityCategory | null>(null);
  const [subtype, setSubtype] = useState('');
  const [customSubtype, setCustomSubtype] = useState('');
  const [customTypeOpen, setCustomTypeOpen] = useState(false);
  const [intensity, setIntensity] = useState<ActivityIntensity>('moderate');
  const [cardioStyle, setCardioStyle] = useState<CardioStyle | undefined>(undefined);
  const [durationMin, setDurationMin] = useState(45);
  const [dateOffset, setDateOffset] = useState(0);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [editPrefillValues, setEditPrefillValues] = useState(false);
  const [distance, setDistance] = useState('');
  const [calories, setCalories] = useState('');
  const [heartRate, setHeartRate] = useState('');
  const [sourceOverride, setSourceOverride] = useState<ActivitySource | undefined>(undefined);
  const [photoImporting, setPhotoImporting] = useState(false);
  const [showAppleHealthImport, setShowAppleHealthImport] = useState(false);
  const [dateCalendarOpen, setDateCalendarOpen] = useState(false);
  const [datePickerMonth, setDatePickerMonth] = useState(() => activityMonthStart());

  // ── Per-subtype detail fields ─────────────────────────────
  // All text-typed so the keyboard stays consistent; parsed
  // numerically only at save time. Empty string = "user didn't
  // fill this in" → field is omitted from the saved details.
  const [tempF, setTempF] = useState('');
  const [humidityPct, setHumidityPct] = useState('');
  const [waterImmersion, setWaterImmersion] = useState<'waist' | 'chest' | 'neck' | 'full' | ''>('');
  const [breathworkProtocol, setBreathworkProtocol] = useState<'box' | '4-7-8' | 'wim_hof' | 'physiological_sigh' | 'other' | ''>('');
  const [rounds, setRounds] = useState('');
  const [sessionRpe, setSessionRpe] = useState('');
  const [poolLengthMeters, setPoolLengthMeters] = useState('');
  const [swimStroke, setSwimStroke] = useState<'freestyle' | 'backstroke' | 'breaststroke' | 'butterfly' | 'mixed' | ''>('');
  const [laps, setLaps] = useState('');
  const [terrain, setTerrain] = useState<'road' | 'trail' | 'treadmill' | 'track' | 'indoor' | ''>('');
  const [elevationGainFt, setElevationGainFt] = useState('');
  const [avgWatts, setAvgWatts] = useState('');
  const [indoorOutdoor, setIndoorOutdoor] = useState<'indoor' | 'outdoor' | ''>('');
  const [climbingGrade, setClimbingGrade] = useState('');
  const [climbingStyle, setClimbingStyle] = useState<'boulder' | 'sport' | 'top_rope' | 'trad' | 'gym' | ''>('');
  const [skiVerticalFt, setSkiVerticalFt] = useState('');
  const [skiRuns, setSkiRuns] = useState('');
  const [yogaStyle, setYogaStyle] = useState<'vinyasa' | 'hatha' | 'yin' | 'hot' | 'restorative' | 'power' | 'other' | ''>('');

  const reset = useCallback(() => {
    setStep(1);
    setCategory(null);
    setSubtype('');
    setCustomSubtype('');
    setCustomTypeOpen(false);
    setIntensity('moderate');
    setCardioStyle(undefined);
    setDurationMin(45);
    setDateOffset(0);
    setNotes('');
    setSaving(false);
    setEditPrefillValues(false);
    setDistance('');
    setCalories('');
    setHeartRate('');
    setSourceOverride(undefined);
    setPhotoImporting(false);
    setShowAppleHealthImport(false);
    setDateCalendarOpen(false);
    setDatePickerMonth(activityMonthStart());
    setTempF('');
    setHumidityPct('');
    setWaterImmersion('');
    setBreathworkProtocol('');
    setRounds('');
    setSessionRpe('');
    setPoolLengthMeters('');
    setSwimStroke('');
    setLaps('');
    setTerrain('');
    setElevationGainFt('');
    setAvgWatts('');
    setIndoorOutdoor('');
    setClimbingGrade('');
    setClimbingStyle('');
    setSkiVerticalFt('');
    setSkiRuns('');
    setYogaStyle('');
  }, []);

  const clearStructuredDetailFields = useCallback(() => {
    setTempF('');
    setHumidityPct('');
    setWaterImmersion('');
    setBreathworkProtocol('');
    setRounds('');
    setSessionRpe('');
    setPoolLengthMeters('');
    setSwimStroke('');
    setLaps('');
    setTerrain('');
    setElevationGainFt('');
    setAvgWatts('');
    setIndoorOutdoor('');
    setClimbingGrade('');
    setClimbingStyle('');
    setSkiVerticalFt('');
    setSkiRuns('');
    setYogaStyle('');
  }, []);

  const clearManualMetricFields = useCallback(() => {
    setDistance('');
    setCalories('');
    setHeartRate('');
  }, []);

  // Seed state from prefill when the modal opens. Only runs on
  // visibility transition so it doesn't clobber user edits mid-flow.
  useEffect(() => {
    if (!visible) return;
    if (!prefill) return;
    setShowAppleHealthImport(false);
    if (prefill.category) {
      setCategory(prefill.category);
      setStep(3); // skip pickers — the import already supplied classification
      setCustomTypeOpen(false);
    }
    if (prefill.subtype) setSubtype(prefill.subtype);
    if (prefill.cardioStyle) setCardioStyle(prefill.cardioStyle);
    // Venue chosen at session start wins over the subtype default.
    if (prefill.indoorOutdoor) setIndoorOutdoor(prefill.indoorOutdoor);
    else if (prefill.subtype && isVenueAmbiguous(prefill.category ?? '', prefill.subtype)) {
      setIndoorOutdoor(defaultVenueForActivity(prefill.category ?? '', prefill.subtype));
    }
    if (typeof prefill.durationMin === 'number' && prefill.durationMin > 0) {
      setDurationMin(Math.round(prefill.durationMin));
    }
    if (prefill.dateISO) {
      const then = parseActivityDate(prefill.dateISO);
      if (then) {
        const offset = clampActivityDateOffset(calendarDayOffsetFromToday(then));
        setDateOffset(offset);
        setDatePickerMonth(activityMonthStart(activityDateFromOffset(offset)));
      }
    }
    if (prefill.distanceMiles != null) setDistance(String(prefill.distanceMiles));
    if (prefill.caloriesBurned != null) setCalories(String(Math.round(prefill.caloriesBurned)));
    if (prefill.avgHeartRate != null) setHeartRate(String(Math.round(prefill.avgHeartRate)));
    const explicitElevationGainFt = typeof prefill.elevationGainFt === 'number' && Number.isFinite(prefill.elevationGainFt)
      ? Math.round(prefill.elevationGainFt)
      : null;
    const inferredElevationGainFt = explicitElevationGainFt ?? estimateRouteElevationGainFt(prefill.routeCoords);
    if (inferredElevationGainFt != null) setElevationGainFt(String(inferredElevationGainFt));
    if (prefill.source) setSourceOverride(prefill.source);
    // Intensity inference — HK doesn't label intensity, but we can
    // derive it. Prefer HR zones when we have HR + a decent signal;
    // otherwise fall back to cardio_style (intervals=hard, steady=
    // moderate, easy=easy). No more asking the user to pick something
    // we can infer from the imported data.
    let inferredIntensity: ActivityIntensity | null = null;
    const bpm = prefill.avgHeartRate;
    if (typeof bpm === 'number' && bpm > 0) {
      // Age-free heuristic: 140+ bpm sustained = hard, 110-140 =
      // moderate, <110 = easy. Works without needing the user age
      // field; a 40-year-old's 150 bpm still reads as "hard effort."
      if (bpm >= 140) inferredIntensity = 'hard';
      else if (bpm >= 110) inferredIntensity = 'moderate';
      else inferredIntensity = 'easy';
    } else if (prefill.cardioStyle === 'intervals') {
      inferredIntensity = 'hard';
    } else if (prefill.cardioStyle === 'easy') {
      inferredIntensity = 'easy';
    } else if (prefill.cardioStyle === 'steady') {
      inferredIntensity = 'moderate';
    }
    if (inferredIntensity) setIntensity(inferredIntensity);
    // NOTE: keep imported values collapsed at first. The read-only
    // summary card already shows distance / calories / HR clearly,
    // and "Edit values" exposes the full pickers on demand.
  }, [visible, prefill]);

  const selectCategory = (cat: ActivityCategory) => {
    configureExpandAnimation(300);
    setCategory(cat);
    setSubtype('');
    setCustomSubtype('');
    setCustomTypeOpen(false);
    clearStructuredDetailFields();
    clearManualMetricFields();
    setShowAppleHealthImport(false);
    if (cat === 'recovery') setIntensity('easy');
    else setIntensity('moderate');
    setCardioStyle(undefined);
    setStep(2);
  };

  const goBack = () => {
    configureExpandAnimation(300);
    if (step === 3) {
      setStep(2);
      return;
    }
    setStep(1);
  };

  const getDateForOffset = (offset: number) => {
    return activityDateFromOffset(offset);
  };

  const formatDate = (offset: number) => {
    const d = getDateForOffset(offset);
    const includeYear = d.getFullYear() !== new Date().getFullYear();
    return d.toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      ...(includeYear ? { year: 'numeric' as const } : {}),
    });
  };

  const dateScrollOffsets = useMemo(
    () => Array.from({ length: ACTIVITY_DATE_LOOKBACK_DAYS + 1 }, (_, index) => -index),
    [],
  );

  const dateCalendar = useMemo(() => {
    const today = new Date();
    const minDate = activityDateFromOffset(-ACTIVITY_DATE_LOOKBACK_DAYS, today);
    const currentMonth = activityMonthStart(today);
    const minMonth = activityMonthStart(minDate);
    const monthStart = activityMonthStart(datePickerMonth);
    const gridStart = new Date(monthStart);
    gridStart.setDate(monthStart.getDate() - monthStart.getDay());
    const cells = Array.from({ length: 42 }, (_, index) => {
      const date = new Date(gridStart);
      date.setDate(gridStart.getDate() + index);
      const offset = clampActivityDateOffset(calendarDayOffsetFromToday(date, today));
      const rawOffset = calendarDayOffsetFromToday(date, today);
      const dateKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      return {
        date,
        dateKey,
        offset,
        disabled: rawOffset > 0 || rawOffset < -ACTIVITY_DATE_LOOKBACK_DAYS,
        inMonth: date.getMonth() === monthStart.getMonth(),
      };
    });
    return {
      cells,
      monthLabel: monthStart.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
      canGoPrev: monthStart.getTime() > minMonth.getTime(),
      canGoNext: monthStart.getTime() < currentMonth.getTime(),
    };
  }, [datePickerMonth]);

  const effectiveSubtype = subtype || customSubtype.trim();
  const effectiveSubtypeDef = category && subtype
    ? SUBTYPES[category]?.find(s => s.key === subtype)
    : undefined;
  const selectedCategoryDef = category ? CATEGORIES.find(c => c.key === category) : undefined;
  const hasCustomSubtype = customSubtype.trim().length > 0;
  const customTypeActive = customTypeOpen || hasCustomSubtype;
  const supportsCardioStyle = category === 'cardio' || !!effectiveSubtypeDef?.cardioStyle;
  const supportsSessionRpe = category === 'strength' || category === 'cardio' || category === 'sport' || category === 'active';
  const showPrefillEffortDetails = !!prefill && !editPrefillValues && category !== 'recovery' && prefill.avgHeartRate == null;
  const effectiveLabel = (() => {
    if (customSubtype.trim()) return customSubtype.trim();
    if (!category || !subtype) return '';
    return effectiveSubtypeDef?.label ?? subtype;
  })();
  const estimatedCalories = useMemo(() => estimateActivityCaloriesDetailed({
    category,
    subtype: effectiveSubtype,
    durationMinutes: durationMin,
    bodyweightLbs,
    distanceMiles: numericField(distance),
    elevationGainFt: numericField(elevationGainFt),
    intensity,
    cardioStyle: supportsCardioStyle ? cardioStyle : undefined,
  }), [
    bodyweightLbs,
    cardioStyle,
    category,
    distance,
    durationMin,
    effectiveSubtype,
    elevationGainFt,
    intensity,
    supportsCardioStyle,
  ]);
  const shouldSuggestCalories = !!estimatedCalories && !calories.trim();

  const selectSubtype = (opt: SubtypeDef) => {
    clearStructuredDetailFields();
    setSubtype(opt.key);
    setCustomSubtype('');
    setCustomTypeOpen(false);
    if (opt.cardioStyle) {
      setCardioStyle(opt.cardioStyle);
    } else if (category !== 'cardio') {
      setCardioStyle(undefined);
    }
    // Pre-select a sensible venue for venue-ambiguous activities so the user
    // rarely has to touch it (they can still flip it). One activity type +
    // venue attribute — not duplicate indoor/outdoor activities.
    if (isVenueAmbiguous(category, opt.key)) {
      setIndoorOutdoor(defaultVenueForActivity(category, opt.key));
    }
    configureExpandAnimation(240);
    setStep(3);
  };

  const selectCustomType = () => {
    clearStructuredDetailFields();
    setSubtype('');
    setCustomTypeOpen(true);
    if (category !== 'cardio') {
      setCardioStyle(undefined);
    }
    configureExpandAnimation(220);
  };

  const handleImportPhoto = async () => {
    if (!authToken) return;
    setPhotoImporting(true);
    try {
      const ImagePicker = await import('expo-image-picker');
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        Alert.alert('Photo access needed', 'Allow photo access to import a workout screenshot.');
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsEditing: false,
        base64: true,
        quality: 0.85,
      });
      if (result.canceled) return;
      const asset = result.assets?.[0];
      if (!asset?.base64) {
        Alert.alert('Could not read photo', 'Choose a different screenshot and try again.');
        return;
      }
      const parsed = await parseWorkoutPhoto(authToken, asset.base64, (asset as any).mimeType || 'image/jpeg');
      const session = parsed.sessions?.[0];
      if (!session) {
        Alert.alert('No workout found', 'I could not find a completed workout in that image.');
        return;
      }

      clearStructuredDetailFields();
      clearManualMetricFields();
      const focus = String(session.focus || 'Imported workout');
      const n = focus.toLowerCase();
      const isSpin = /\b(peloton|spin)\b/.test(n);
      const isRide = isSpin || /\b(ride|cycling|bike)\b/.test(n);
      const isWalk = /\b(walk|walking)\b/.test(n);
      const isHike = /\b(hike|hiking|trail)\b/.test(n);
      const isRun = /\b(run|running|jog|jogging|5k|10k|marathon)\b/.test(n);
      const isTreadmill = /\btreadmill\b/.test(n);
      const isRow = /\b(row|rowing|erg)\b/.test(n);
      const isSwim = /\b(swim|swimming|pool)\b/.test(n);
      const isElliptical = /\b(elliptical)\b/.test(n);
      const isStair = /\b(stair|stairs|stepmill)\b/.test(n);
      const isCardio = isRide || isRun || isTreadmill || isWalk || isHike || isRow || isSwim || isElliptical || isStair || /\b(cardio)\b/.test(n);
      const nextCategory: ActivityCategory = isCardio ? 'cardio' : 'strength';
      const nextSubtype = isSpin ? 'spin'
        : isRide ? 'ride'
        : isWalk ? 'walk'
        : isHike ? 'hike'
        : isRun || isTreadmill ? 'run'
        : isRow ? 'row'
        : isSwim ? 'swim'
        : isElliptical ? 'elliptical'
        : isStair ? 'stair'
        : isCardio ? 'other'
        : 'full_body';
      const nextSource: ActivitySource = String(session.source || '').toLowerCase() === 'peloton' || n.includes('peloton')
        ? 'peloton'
        : 'manual';

      setCategory(nextCategory);
      setSubtype(nextSubtype);
      setCustomSubtype('');
      setCustomTypeOpen(false);
      setCardioStyle(nextCategory === 'cardio' ? (isSpin ? 'class' : isWalk ? 'easy' : 'steady') : undefined);
      setDurationMin(Math.max(5, Math.round((Number(session.durationSeconds) || 3600) / 60)));
      if (session.date) {
        const imported = parseActivityDate(String(session.date));
        if (imported) {
          const offset = clampActivityDateOffset(calendarDayOffsetFromToday(imported));
          setDateOffset(offset);
          setDatePickerMonth(activityMonthStart(activityDateFromOffset(offset)));
        }
      }
      if (session.distanceMiles != null) setDistance(String(Math.round(Number(session.distanceMiles) * 100) / 100));
      if (session.caloriesBurned != null) setCalories(String(Math.round(Number(session.caloriesBurned))));
      if (session.avgHeartRate != null) setHeartRate(String(Math.round(Number(session.avgHeartRate))));
      setNotes(`Imported for review: ${focus}`);
      setSourceOverride(nextSource);
      setEditPrefillValues(false);
      setShowAppleHealthImport(false);
      setStep(3);
    } catch (e: any) {
      Alert.alert('Import failed', String(e?.message ?? 'Could not import that screenshot.'));
    } finally {
      setPhotoImporting(false);
    }
  };

  const handleSave = async () => {
    if (!category) {
      Alert.alert('Select a category', 'Pick what type of activity this was.');
      return;
    }
    if (!effectiveSubtype) {
      Alert.alert('Select a type', 'Pick a more specific activity type.');
      return;
    }
    setSaving(true);
    try {
      const date = getDateForOffset(dateOffset);
      const endDateCandidate = prefill?.endedAtISO ? new Date(prefill.endedAtISO) : date;
      const endDate = Number.isFinite(endDateCandidate.getTime()) ? endDateCandidate : date;
      const startDateCandidate = prefill?.startedAtISO
        ? new Date(prefill.startedAtISO)
        : new Date(endDate.getTime() - Math.max(1, durationMin) * 60_000);
      const startDate = Number.isFinite(startDateCandidate.getTime())
        ? startDateCandidate
        : new Date(endDate.getTime() - Math.max(1, durationMin) * 60_000);
      const startedAtISO = startDate.toISOString();
      const endedAtISO = endDate.toISOString();
      const legacyFocus = getLegacyFocus(category, subtype, customSubtype);

      // Only persist fields that belong to the active selection. This keeps
      // changing from sauna -> breathwork from leaking stale sauna details.
      const numIf = (s: string): number | undefined => {
        const n = parseFloat(s);
        return Number.isFinite(n) ? n : undefined;
      };
      const intIf = (s: string): number | undefined => {
        const n = parseInt(s, 10);
        return Number.isFinite(n) ? n : undefined;
      };
      const details: Record<string, unknown> = {};
      const setIf = (k: string, v: unknown) => { if (v !== undefined && v !== '') details[k] = v; };
      if (category === 'recovery') {
        if (subtype === 'finnish_sauna') {
          setIf('temperatureF', numIf(tempF));
          setIf('humidityPct', numIf(humidityPct));
        } else if (subtype === 'infrared_sauna') {
          setIf('temperatureF', numIf(tempF));
        } else if (subtype === 'cold_plunge') {
          setIf('temperatureF', numIf(tempF));
          setIf('waterImmersion', waterImmersion || undefined);
        } else if (subtype === 'contrast') {
          setIf('temperatureF', numIf(tempF));
          setIf('rounds', intIf(rounds));
        } else if (subtype === 'breathwork') {
          setIf('breathworkProtocol', breathworkProtocol || undefined);
          setIf('rounds', intIf(rounds));
        }
      }
      if (supportsSessionRpe) setIf('sessionRpe', numIf(sessionRpe));
      if (category === 'cardio') {
        if (subtype === 'swim') {
          setIf('poolLengthMeters', numIf(poolLengthMeters));
          setIf('swimStroke', swimStroke || undefined);
          setIf('laps', intIf(laps));
        }
        if (subtype === 'ride' || subtype === 'spin') {
          setIf('indoorOutdoor', indoorOutdoor || undefined);
          setIf('avgWatts', numIf(avgWatts));
          setIf('elevationGainFt', numIf(elevationGainFt));
        }
        if (subtype === 'run' || subtype === 'hike' || subtype === 'walk') {
          setIf('terrain', terrain || undefined);
          setIf('elevationGainFt', numIf(elevationGainFt));
        }
      }
      if (category === 'sport') {
        if (subtype === 'climbing') {
          setIf('climbingGrade', climbingGrade.trim() || undefined);
          setIf('climbingStyle', climbingStyle || undefined);
        }
        if (subtype === 'skiing') {
          setIf('skiVerticalFt', numIf(skiVerticalFt));
          setIf('skiRuns', intIf(skiRuns));
        }
      }
      if (category === 'mobility' && subtype === 'yoga') setIf('yogaStyle', yogaStyle || undefined);
      // Venue (indoor/outdoor) for any venue-ambiguous activity — team sports,
      // swim, ride, etc. run/hike/walk also carry it via `terrain`; emitting
      // indoorOutdoor too is harmless (backend treats indoor as the
      // tie-breaker) and is what feeds the GPS + sun-exposure logic.
      if (isVenueAmbiguous(category, subtype)) setIf('indoorOutdoor', indoorOutdoor || undefined);
      const shouldSaveDistance = category === 'cardio' || (category === 'recovery' && subtype === 'walk');
      const shouldSaveEffortMetrics = category !== 'recovery' || subtype === 'walk';
      const caloriesBurnedValue = shouldSaveEffortMetrics
        ? (calories.trim() ? numericField(calories) ?? undefined : estimatedCalories?.calories)
        : undefined;
      if (shouldSaveEffortMetrics && !calories.trim() && estimatedCalories) {
        setIf('caloriesEstimated', true);
        setIf('calorieEstimateSource', estimatedCalories.source);
        setIf('calorieEstimateConfidence', estimatedCalories.confidence);
        setIf('calorieEstimateMet', estimatedCalories.met);
      }

      const session: WorkoutSession = {
        // Keep the HK externalId (or whatever the caller passed) as
        // the session id so a re-import of the same workout dedupes
        // via `alreadyImportedIds` in detectUnloggedWorkouts.
        id: prefill?.externalId
          ?? `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        date: startedAtISO,
        focus: legacyFocus,
        durationSeconds: durationMin * 60,
        startedAt: startedAtISO,
        endedAt: endedAtISO,
        exercises: [],
        completed: true,
        manualActivity: {
          category,
          subtype: effectiveSubtype,
          intensity,
          ...(supportsCardioStyle && cardioStyle ? { cardioStyle } : {}),
          ...(notes.trim() ? { notes: notes.trim() } : {}),
          ...(shouldSaveDistance && distance ? { distanceMiles: parseFloat(distance) } : {}),
          ...(caloriesBurnedValue != null ? { caloriesBurned: caloriesBurnedValue } : {}),
          ...(shouldSaveEffortMetrics && heartRate ? { avgHeartRate: parseInt(heartRate, 10) } : {}),
          ...(Object.keys(details).length > 0 ? { details: details as any } : {}),
          // Tag the source so the UI + analytics can distinguish
          // imported HK workouts, live-tracker sessions, and plain
          // manual-retro entries.
          ...(sourceOverride ? { source: sourceOverride } : {}),
          ...(prefill?.externalId?.startsWith('hk_') ? { source: 'apple_health' as any } : {}),
          ...(prefill?.externalId?.startsWith('live_') ? { source: 'live_tracker' as any } : {}),
          // Live GPS trail captured by LiveActivityTracker — pass
          // through so saveWorkoutSession routes it to HKWorkoutRouteBuilder
          // (Apple Fitness route map) and the backend route_coords
          // column (post-workout summary map).
          ...(prefill?.routeCoords && prefill.routeCoords.length > 0
            ? { routeCoords: prefill.routeCoords } : {}),
        },
      };
      await onSave(session);
      reset();
      onClose();
    } catch {
      Alert.alert('Error', 'Could not save the activity. Try again.');
    } finally {
      setSaving(false);
    }
  };

  const detailInput = (
    label: string,
    value: string,
    onChangeText: (text: string) => void,
    options?: { placeholder?: string; keyboardType?: 'default' | 'number-pad' | 'decimal-pad'; testID?: string; autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters' },
  ) => (
    <View style={s.detailInputWrap}>
      <Text style={[s.detailInputLabel, { color: tc.textMuted }]}>{label}</Text>
      <TextInput
        testID={options?.testID}
        style={[s.detailInput, { backgroundColor: tc.background, borderColor: tc.border, color: tc.textPrimary }]}
        value={value}
        onChangeText={onChangeText}
        keyboardType={options?.keyboardType ?? 'default'}
        placeholder={options?.placeholder ?? '--'}
        placeholderTextColor={tc.textMuted}
        autoCapitalize={options?.autoCapitalize}
      />
    </View>
  );

  const detailChoiceGroup = (
    label: string,
    value: string,
    onChangeValue: (next: any) => void,
    options: readonly string[],
    labelFor: (value: string) => string = prettyDetailOption,
    testPrefix?: string,
  ) => (
    <View style={s.detailChoiceWrap}>
      <Text style={[s.detailInputLabel, { color: tc.textMuted }]}>{label}</Text>
      <View style={s.chipRow}>
        {options.map(opt => {
          const active = value === opt;
          return (
            <TouchableOpacity
              key={opt}
              testID={testPrefix ? `${testPrefix}-${opt}` : undefined}
              style={[s.chip, { borderColor: active ? tc.primary : tc.border, backgroundColor: active ? tc.primary + '18' : tc.surfaceRaised }]}
              onPress={() => onChangeValue(active ? '' : opt)}>
              <Text style={{ fontSize: 12, fontWeight: '700', color: active ? tc.primary : tc.textSecondary }}>
                {labelFor(opt)}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );

  const renderTailoredDetailFields = () => {
    if (!category || !effectiveSubtype) return null;
    const hasRecoveryDetails = category === 'recovery' && (
      subtype === 'finnish_sauna'
      || subtype === 'infrared_sauna'
      || subtype === 'cold_plunge'
      || subtype === 'contrast'
      || subtype === 'breathwork'
      || subtype === 'walk'
    );
    const hasGeneralEffort = category !== 'recovery';
    if (!hasRecoveryDetails && !hasGeneralEffort) return null;

    return (
      <View style={[s.detailCard, { backgroundColor: tc.surfaceRaised, borderColor: tc.border }]}>
        <View style={s.detailHeader}>
          <View style={[s.detailIcon, { backgroundColor: tc.primary + '18' }]}>
            <Ionicons name={(effectiveSubtypeDef?.icon ?? 'options-outline') as any} size={15} color={tc.primary} />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={[s.detailTitle, { color: tc.textPrimary }]}>{effectiveLabel} details</Text>
          </View>
        </View>

        <View style={s.detailInputGrid}>
          {category === 'recovery' && subtype === 'finnish_sauna' && (
            <>
              <DetailWheelField label="Temp (F)" value={tempF} setValue={setTempF} min={120} max={230} step={5} fallback={180} tc={tc} testID="activity-temp-input" formatLabel={(v) => `${v}°`} />
              <DetailWheelField label="Humidity %" value={humidityPct} setValue={setHumidityPct} min={0} max={100} step={5} fallback={10} tc={tc} testID="activity-humidity-input" />
            </>
          )}
          {category === 'recovery' && subtype === 'infrared_sauna' && (
            <DetailWheelField label="Temp (F)" value={tempF} setValue={setTempF} min={90} max={170} step={5} fallback={140} tc={tc} testID="activity-temp-input" formatLabel={(v) => `${v}°`} />
          )}
          {category === 'recovery' && (subtype === 'cold_plunge' || subtype === 'contrast') && (
            <DetailWheelField label="Water temp (F)" value={tempF} setValue={setTempF} min={30} max={70} step={1} fallback={50} tc={tc} testID="activity-temp-input" formatLabel={(v) => `${v}°`} />
          )}
          {category === 'recovery' && (subtype === 'contrast' || subtype === 'breathwork') && (
            detailInput('Rounds', rounds, setRounds, { keyboardType: 'number-pad', placeholder: '3', testID: 'activity-rounds-input' })
          )}
          {category === 'recovery' && subtype === 'walk' && (
            detailInput('Distance (mi)', distance, setDistance, { keyboardType: 'decimal-pad', placeholder: '2.0', testID: 'activity-distance-input' })
          )}

          {category === 'cardio' && (
            detailInput('Distance (mi)', distance, setDistance, { keyboardType: 'decimal-pad', placeholder: '--', testID: 'activity-distance-input' })
          )}
          {category !== 'recovery' && (
            <>
              {detailInput('Calories', calories, setCalories, { keyboardType: 'number-pad', placeholder: '--', testID: 'activity-calories-input' })}
              {detailInput('Avg HR', heartRate, setHeartRate, { keyboardType: 'number-pad', placeholder: '--', testID: 'activity-heart-rate-input' })}
            </>
          )}
          {supportsSessionRpe && (
            detailInput('Session RPE', sessionRpe, setSessionRpe, { keyboardType: 'decimal-pad', placeholder: '1-10', testID: 'activity-rpe-input' })
          )}
          {category === 'cardio' && subtype === 'swim' && (
            <>
              {detailInput('Pool length (m)', poolLengthMeters, setPoolLengthMeters, { keyboardType: 'number-pad', placeholder: '25' })}
              {detailInput('Laps', laps, setLaps, { keyboardType: 'number-pad', placeholder: '--' })}
            </>
          )}
          {category === 'cardio' && (subtype === 'ride' || subtype === 'spin') && (
            <>
              {detailInput('Avg watts', avgWatts, setAvgWatts, { keyboardType: 'number-pad', placeholder: '--' })}
              {detailInput('Elevation (ft)', elevationGainFt, setElevationGainFt, { keyboardType: 'number-pad', placeholder: '--' })}
            </>
          )}
          {category === 'cardio' && (subtype === 'run' || subtype === 'hike' || subtype === 'walk') && (
            detailInput('Elevation (ft)', elevationGainFt, setElevationGainFt, { keyboardType: 'number-pad', placeholder: '--' })
          )}
          {category === 'sport' && subtype === 'climbing' && (
            detailInput('Hardest grade', climbingGrade, setClimbingGrade, { placeholder: 'V4 / 5.10b', autoCapitalize: 'none' })
          )}
          {category === 'sport' && subtype === 'skiing' && (
            <>
              {detailInput('Vertical (ft)', skiVerticalFt, setSkiVerticalFt, { keyboardType: 'number-pad', placeholder: '--' })}
              {detailInput('Runs', skiRuns, setSkiRuns, { keyboardType: 'number-pad', placeholder: '--' })}
            </>
          )}
        </View>

        {shouldSuggestCalories ? (
          <View
            testID="activity-calorie-estimate"
            style={[s.calorieEstimate, { backgroundColor: tc.primary + '12', borderColor: tc.primary + '38' }]}>
            <Ionicons name="speedometer-outline" size={14} color={tc.primary} />
            <Text style={[s.calorieEstimateText, { color: tc.textSecondary }]}>
              Est. burn ~{estimatedCalories?.calories} kcal ({estimatedCalories?.confidence} confidence)
            </Text>
          </View>
        ) : null}

        {category === 'recovery' && subtype === 'cold_plunge' && detailChoiceGroup(
          'Immersion',
          waterImmersion,
          setWaterImmersion,
          ['waist', 'chest', 'neck', 'full'] as const,
          prettyDetailOption,
          'activity-immersion',
        )}
        {category === 'recovery' && subtype === 'breathwork' && detailChoiceGroup(
          'Protocol',
          breathworkProtocol,
          setBreathworkProtocol,
          ['box', '4-7-8', 'wim_hof', 'physiological_sigh', 'other'] as const,
          breathworkLabel,
          'activity-breathwork',
        )}
        {category === 'cardio' && subtype === 'swim' && detailChoiceGroup(
          'Stroke',
          swimStroke,
          setSwimStroke,
          ['freestyle', 'backstroke', 'breaststroke', 'butterfly', 'mixed'] as const,
        )}
        {category === 'cardio' && (subtype === 'ride' || subtype === 'spin') && detailChoiceGroup(
          'Location',
          indoorOutdoor,
          setIndoorOutdoor,
          ['indoor', 'outdoor'] as const,
        )}
        {category === 'cardio' && (subtype === 'run' || subtype === 'hike' || subtype === 'walk') && detailChoiceGroup(
          'Terrain',
          terrain,
          setTerrain,
          ['road', 'trail', 'treadmill', 'track', 'indoor'] as const,
        )}
        {/* Indoor/outdoor for every other venue-ambiguous activity (swim,
            row, team sports). ride/spin use the Location group above;
            run/hike/walk encode venue via Terrain. */}
        {isVenueAmbiguous(category, subtype)
          && subtype !== 'ride' && subtype !== 'spin'
          && !(category === 'cardio' && (subtype === 'run' || subtype === 'hike' || subtype === 'walk'))
          && detailChoiceGroup(
            'Location',
            indoorOutdoor,
            setIndoorOutdoor,
            ['indoor', 'outdoor'] as const,
          )}
        {category === 'sport' && subtype === 'climbing' && detailChoiceGroup(
          'Style',
          climbingStyle,
          setClimbingStyle,
          ['boulder', 'sport', 'top_rope', 'trad', 'gym'] as const,
          climbingLabel,
        )}
        {category === 'mobility' && subtype === 'yoga' && detailChoiceGroup(
          'Style',
          yogaStyle,
          setYogaStyle,
          ['vinyasa', 'hatha', 'yin', 'hot', 'restorative', 'power', 'other'] as const,
        )}
      </View>
    );
  };

  const adjustDuration = (delta: number) => {
    setDurationMin(prev => Math.max(5, Math.min(300, prev + delta)));
  };

  // ─── Render ──────────────────────────────────────────────────────────────────

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={() => { reset(); onClose(); }}>
      <KeyboardAvoidingView
        style={s.overlay}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <View style={[s.sheet, { backgroundColor: tc.surface, borderTopColor: tc.border }]}>
          <BottomSheetDismissHandle
            onClose={() => { reset(); onClose(); }}
            color={tc.border}
            containerStyle={s.handleTap}
            handleStyle={s.handle}
          />

          {/* Header */}
          <View style={s.header}>
            {step === 2 || step === 3 ? (
              <TouchableOpacity onPress={goBack} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                <Ionicons name="chevron-back" size={20} color={tc.primary} />
                <Text style={{ fontSize: 16, fontWeight: '600', color: tc.primary }}>
                  {step === 3
                    ? (effectiveLabel || CATEGORIES.find(c => c.key === category)?.label || 'Back')
                    : (CATEGORIES.find(c => c.key === category)?.label ?? 'Back')}
                </Text>
              </TouchableOpacity>
            ) : (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Ionicons name="add-circle" size={22} color={tc.primary} />
                <Text style={[s.title, { color: tc.textPrimary }]}>Log Activity</Text>
              </View>
            )}
            <TouchableOpacity onPress={() => { reset(); onClose(); }} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name="close" size={22} color={tc.textMuted} />
            </TouchableOpacity>
          </View>

          <ScrollView
            contentContainerStyle={s.content}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
            automaticallyAdjustKeyboardInsets
            showsVerticalScrollIndicator={false}>

            {/* ── Step 1: Category Selection ─────────────────────────── */}
            {step === 1 && (
              <>
                <View style={s.catGrid}>
                  {CATEGORIES.map(cat => (
                    <TouchableOpacity
                      key={cat.key}
                      testID={`activity-category-${cat.key}`}
                      accessibilityLabel={`activity-category-${cat.key}`}
                      style={[s.catCard, { borderColor: tc.border }]}
                      onPress={() => selectCategory(cat.key)}
                      activeOpacity={0.7}>
                      <ImageBackground
                        source={cat.image}
                        style={s.catImage}
                        imageStyle={s.catImageStyle}
                        resizeMode="cover">
                        <View style={s.catImageOverlay} />
                        <View style={s.catContent}>
                          <View style={s.catIconBubble}>
                            <Ionicons name={cat.icon as any} size={24} color="#fff" />
                          </View>
                          <Text style={s.catLabel}>{cat.label}</Text>
                          <Text style={s.catDesc}>{cat.desc}</Text>
                        </View>
                      </ImageBackground>
                    </TouchableOpacity>
                  ))}
                </View>
                {(appleHealthImportSlot || authToken) ? (
                  <View style={s.importSection}>
                    <Text style={[s.importSectionLabel, { color: tc.textMuted }]}>IMPORT</Text>
                    <View style={s.importChoiceGrid}>
                      {appleHealthImportSlot ? (
                        <TouchableOpacity
                          testID="activity-import-apple-health"
                          accessibilityLabel="activity-import-apple-health"
                          style={[s.importChoiceCard, { backgroundColor: tc.surfaceRaised, borderColor: showAppleHealthImport ? tc.primary : tc.border }]}
                          onPress={() => {
                            configureExpandAnimation(220);
                            setShowAppleHealthImport(v => !v);
                          }}
                          activeOpacity={0.76}>
                          <View style={[s.importChoiceIcon, { backgroundColor: tc.primary + '18' }]}>
                            <Ionicons name="heart-circle-outline" size={20} color={tc.primary} />
                          </View>
                          <Text style={[s.importChoiceTitle, { color: tc.textPrimary }]}>Apple Health</Text>
                          <Text style={[s.importChoiceSub, { color: tc.textMuted }]} numberOfLines={1}>Recent workouts</Text>
                        </TouchableOpacity>
                      ) : null}
                      {authToken ? (
                        <TouchableOpacity
                          testID="activity-import-photo"
                          accessibilityLabel="activity-import-photo"
                          style={[s.importChoiceCard, { backgroundColor: tc.surfaceRaised, borderColor: tc.border, opacity: photoImporting ? 0.65 : 1 }]}
                          onPress={handleImportPhoto}
                          disabled={photoImporting}
                          activeOpacity={0.75}>
                          <View style={[s.importChoiceIcon, { backgroundColor: tc.primary + '18' }]}>
                            <Ionicons name={photoImporting ? 'hourglass-outline' : 'image-outline'} size={20} color={tc.primary} />
                          </View>
                          <Text style={[s.importChoiceTitle, { color: tc.textPrimary }]}>
                            {photoImporting ? 'Importing...' : 'Screenshot'}
                          </Text>
                          <Text style={[s.importChoiceSub, { color: tc.textMuted }]} numberOfLines={1}>Workout photo</Text>
                        </TouchableOpacity>
                      ) : null}
                    </View>
                    {showAppleHealthImport && appleHealthImportSlot ? (
                      <View style={[s.appleImportPanel, { borderColor: tc.border, backgroundColor: tc.surfaceRaised }]}>
                        {appleHealthImportSlot}
                      </View>
                    ) : null}
                  </View>
                ) : null}
              </>
            )}

            {/* ── Step 2: Type Selection ──────────────────────────────── */}
            {step === 2 && category && (
              <>
                {/* Subtype */}
                <Text style={[s.label, { color: tc.textPrimary }]}>{selectedCategoryDef?.label ?? 'Activity'} type</Text>
                <TouchableOpacity
                  testID={`activity-subtype-${category}-custom`}
                  accessibilityLabel={`activity-subtype-${category}-custom`}
                  style={[
                    s.customTypeCard,
                    {
                      backgroundColor: customTypeActive ? tc.primary + '12' : tc.surfaceRaised,
                      borderColor: customTypeActive ? tc.primary : tc.border,
                    },
                  ]}
                  onPress={selectCustomType}
                  activeOpacity={0.78}>
                  <View style={[s.customTypeIcon, { backgroundColor: tc.primary + '18' }]}>
                    <Ionicons name="create-outline" size={20} color={tc.primary} />
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={[s.customTypeTitle, { color: tc.textPrimary }]}>Custom</Text>
                    <Text style={[s.customTypeSub, { color: tc.textMuted }]} numberOfLines={1}>
                      {customSubtype.trim() || 'Name your own activity'}
                    </Text>
                  </View>
                  {hasCustomSubtype ? (
                    <View style={[s.customTypeCheck, { backgroundColor: tc.primary }]}>
                      <Ionicons name="checkmark" size={13} color={getContrastingTextColor(tc.primary)} />
                    </View>
                  ) : customTypeOpen ? (
                    <Ionicons name="chevron-down" size={18} color={tc.primary} />
                  ) : (
                    <Ionicons name="chevron-forward" size={18} color={tc.textMuted} />
                  )}
                </TouchableOpacity>

                {customTypeActive ? (
                  <View style={[s.customTypePanel, { backgroundColor: tc.surfaceRaised, borderColor: tc.border }]}>
                    <Text style={[s.detailInputLabel, { color: tc.textMuted }]}>Activity name</Text>
                    <TextInput
                      testID="activity-custom-subtype-input"
                      style={[s.customTypeInput, { backgroundColor: tc.background, borderColor: tc.border, color: tc.textPrimary }]}
                      placeholder="Basketball drills, sled pushes, etc."
                      placeholderTextColor={tc.textMuted}
                      value={customSubtype}
                      autoCapitalize="words"
                      onChangeText={t => {
                        setCustomSubtype(t);
                        if (t.trim()) {
                          setSubtype('');
                          clearStructuredDetailFields();
                        }
                      }}
                      returnKeyType="done"
                      onSubmitEditing={() => {
                        if (hasCustomSubtype) {
                          configureExpandAnimation(240);
                          setStep(3);
                        }
                      }}
                    />
                    <PressableScale
                      testID="activity-custom-subtype-continue"
                      style={{ marginTop: 10 }}
                      onPress={() => {
                        if (!hasCustomSubtype) return;
                        configureExpandAnimation(240);
                        setStep(3);
                      }}
                      disabled={!hasCustomSubtype}>
                      <View style={[
                        s.customContinueBtn,
                        { backgroundColor: hasCustomSubtype ? tc.primary : tc.textMuted },
                      ]}>
                        <Ionicons
                          name="arrow-forward-circle"
                          size={18}
                          color={getContrastingTextColor(hasCustomSubtype ? tc.primary : tc.textMuted)}
                        />
                        <Text style={[
                          s.customContinueText,
                          { color: getContrastingTextColor(hasCustomSubtype ? tc.primary : tc.textMuted) },
                        ]}>
                          Continue
                        </Text>
                      </View>
                    </PressableScale>
                  </View>
                ) : null}

                <View style={s.typeCardGrid}>
                  {SUBTYPES[category].map(opt => {
                    const active = subtype === opt.key;
                    return (
                      <TouchableOpacity
                        key={opt.key}
                        testID={`activity-subtype-${category}-${opt.key}`}
                        accessibilityLabel={`activity-subtype-${category}-${opt.key}`}
                        style={[s.typeCard, { borderColor: active ? tc.primary : tc.border }]}
                        onPress={() => selectSubtype(opt)}
                        activeOpacity={0.78}>
                        <ImageBackground
                          source={opt.image ?? selectedCategoryDef?.image ?? CATEGORIES[0].image}
                          style={s.typeImage}
                          imageStyle={s.typeImageStyle}
                          resizeMode="cover">
                          <View style={[s.typeOverlay, active ? { backgroundColor: 'rgba(0,0,0,0.32)' } : null]} />
                          <View style={s.typeCardContent}>
                            <View style={s.typeCardTop}>
                              <View style={[s.typeIconBubble, active ? { borderColor: 'rgba(255,255,255,0.62)' } : null]}>
                                <Ionicons name={opt.icon as any} size={18} color="#fff" />
                              </View>
                              {active ? (
                                <View style={[s.typeCheck, { backgroundColor: tc.primary }]}>
                                  <Ionicons name="checkmark" size={12} color={getContrastingTextColor(tc.primary)} />
                                </View>
                              ) : null}
                            </View>
                            <View>
                              <Text style={s.typeCardLabel} numberOfLines={2}>{opt.label}</Text>
                              {opt.desc ? <Text style={s.typeCardDesc} numberOfLines={1}>{opt.desc}</Text> : null}
                            </View>
                          </View>
                        </ImageBackground>
                      </TouchableOpacity>
                    );
                  })}
                  {/* Previously-logged custom activities for THIS category — one
                      tap to re-pick instead of re-typing. Generic clock icon
                      ("recently used") + the user's own subtype name. Routes
                      through the custom-subtype path so all downstream logic
                      (categorization, save, completion) stays unchanged.
                      Dedupes against the standard SUBTYPES list (by key and
                      label) so a session logged with a standard subtype never
                      surfaces here as a "custom" duplicate card. */}
                  {(() => {
                    const standardKeys = new Set(
                      SUBTYPES[category].flatMap(opt => [opt.key, opt.label])
                        .map(v => String(v ?? '').toLowerCase().trim()),
                    );
                    const seen = new Set<string>();
                    const priorForCategory = (recentCustomSubtypes ?? [])
                      .filter(r => r.category === category && r.subtype && r.subtype.trim().length > 0)
                      .map(r => r.subtype.trim())
                      .filter(name => !standardKeys.has(name.toLowerCase()))
                      .filter(name => {
                        const key = name.toLowerCase();
                        if (seen.has(key)) return false;
                        seen.add(key);
                        return true;
                      })
                      .slice(0, 6);
                    return priorForCategory.map(name => {
                      const active = !subtype && customSubtype.trim().toLowerCase() === name.toLowerCase();
                      return (
                        <TouchableOpacity
                          key={`prior-custom-${name}`}
                          testID={`activity-subtype-${category}-prior-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}
                          style={[s.typeCard, { borderColor: active ? tc.primary : tc.border }]}
                          onPress={() => {
                            setSubtype('');
                            setCustomSubtype(name);
                            configureExpandAnimation(240);
                            setStep(3);
                          }}
                          activeOpacity={0.78}>
                          <ImageBackground
                            source={selectedCategoryDef?.image ?? CATEGORIES[0].image}
                            style={s.typeImage}
                            imageStyle={s.typeImageStyle}
                            resizeMode="cover">
                            <View style={[s.typeOverlay, active ? { backgroundColor: 'rgba(0,0,0,0.32)' } : null]} />
                            <View style={s.typeCardContent}>
                              <View style={s.typeCardTop}>
                                <View style={[s.typeIconBubble, active ? { borderColor: 'rgba(255,255,255,0.62)' } : null]}>
                                  <Ionicons name="time-outline" size={18} color="#fff" />
                                </View>
                                {active ? (
                                  <View style={[s.typeCheck, { backgroundColor: tc.primary }]}>
                                    <Ionicons name="checkmark" size={12} color={getContrastingTextColor(tc.primary)} />
                                  </View>
                                ) : null}
                              </View>
                              <View>
                                <Text style={s.typeCardLabel} numberOfLines={2}>{name}</Text>
                                <Text style={s.typeCardDesc} numberOfLines={1}>From your history</Text>
                              </View>
                            </View>
                          </ImageBackground>
                        </TouchableOpacity>
                      );
                    });
                  })()}
                </View>
              </>
            )}

            {/* ── Step 3: Details ─────────────────────────────────────── */}
            {step === 3 && category && (
              <>
                {/* Intensity */}
                {category !== 'recovery' && (
                  <>
                    <Text style={[s.label, { color: tc.textPrimary, marginTop: 16 }]}>Intensity</Text>
                    <View style={{ flexDirection: 'row', gap: 8 }}>
                      {INTENSITIES.map(opt => {
                        const active = intensity === opt.key;
                        const optColor = tc[opt.colorKey];
                        return (
                          <TouchableOpacity
                            key={opt.key}
                            activeOpacity={0.75}
                            style={[s.intensityBtn, {
                              flex: 1,
                              borderColor: active ? optColor : tc.border,
                              backgroundColor: active ? optColor + '18' : tc.surfaceRaised,
                            }]}
                            onPress={() => setIntensity(opt.key)}>
                            <Ionicons name={opt.icon as any} size={18} color={active ? optColor : tc.textMuted} />
                            <Text style={{ fontSize: 13, fontWeight: '700', color: active ? optColor : tc.textSecondary }}>{opt.label}</Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  </>
                )}

                {/* Cardio Style */}
                {supportsCardioStyle && (
                  <>
                    <Text style={[s.label, { color: tc.textPrimary, marginTop: 16 }]}>Style</Text>
                    <View style={s.chipRow}>
                      {CARDIO_STYLES.map(opt => {
                        const active = cardioStyle === opt.key;
                        return (
                          <TouchableOpacity
                            key={opt.key}
                            style={[s.chip, { borderColor: active ? tc.primary : tc.border, backgroundColor: active ? tc.primary + '18' : tc.surfaceRaised }]}
                            onPress={() => setCardioStyle(active ? undefined : opt.key)}>
                            <Text style={{ fontSize: 12, fontWeight: '600', color: active ? tc.primary : tc.textSecondary }}>{opt.label}</Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  </>
                )}

                {/* When prefilled (Apple Health import or live-tracker
                    finish), render date + duration + optional metrics
                    as a compact read-only summary row instead of full
                    interactive pickers. Everything here came FROM the
                    source; asking the user to re-enter it is noise.
                    Edit button flips the summary back to editable
                    pickers for users who do need to tweak. */}
                {prefill && !editPrefillValues ? (
                  <View
                    testID="activity-prefill-summary"
                    style={{
                      marginTop: 16,
                      padding: 12,
                      borderRadius: 10,
                      backgroundColor: tc.surfaceRaised,
                      borderWidth: 1,
                      borderColor: tc.border,
                    }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                      <Ionicons name="information-circle-outline" size={14} color={tc.primary} />
                      <Text style={{ fontSize: 11, fontWeight: '700', color: tc.textSecondary, letterSpacing: 0 }}>
                        FROM {prefill.externalId?.startsWith('hk_') ? 'APPLE HEALTH' : 'YOUR TRACKER'}
                      </Text>
                    </View>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 14, marginTop: 8 }}>
                      <SummaryPill label="When" value={formatDate(dateOffset)} tc={tc} />
                      <SummaryPill label="Duration" value={`${durationMin} min`} tc={tc} />
                      {/* Inferred intensity — derived from HR or
                          cardio_style. User can still override via
                          "Edit values". */}
                      <SummaryPill label="Intensity" value={intensity.charAt(0).toUpperCase() + intensity.slice(1)} tc={tc} />
                      {distance ? <SummaryPill label="Distance" value={`${distance} mi`} tc={tc} /> : null}
                      {calories ? <SummaryPill label="Calories" value={`${calories} kcal`} tc={tc} /> : null}
                      {heartRate ? <SummaryPill label="Avg HR" value={`${heartRate} bpm`} tc={tc} /> : null}
                    </View>
                    <TouchableOpacity
                      onPress={() => { configureExpandAnimation(200); setEditPrefillValues(true); }}
                      style={{ marginTop: 10 }}>
                      <Text style={{ fontSize: 11, color: tc.primary, fontWeight: '700' }}>
                        Edit values
                      </Text>
                    </TouchableOpacity>
                  </View>
                ) : (
                  <>
                    {/* Duration */}
                    <Text style={[s.label, { color: tc.textPrimary, marginTop: 16 }]}>Duration</Text>
                    <View style={s.durationRow}>
                      <TouchableOpacity
                        style={[s.durationBtn, { backgroundColor: tc.surfaceRaised, borderColor: tc.border }]}
                        onPress={() => adjustDuration(-5)}>
                        <Ionicons name="remove" size={20} color={tc.textPrimary} />
                      </TouchableOpacity>
                      <View style={[s.durationDisplay, { backgroundColor: tc.surfaceRaised, borderColor: tc.border }]}>
                        <TextInput
                          testID="activity-duration-input"
                          style={{ fontSize: 20, fontWeight: '800', color: tc.textPrimary, textAlign: 'center', minWidth: 50 }}
                          value={String(durationMin)}
                          onChangeText={t => {
                            const n = parseInt(t, 10);
                            if (!isNaN(n) && n >= 0 && n <= 300) setDurationMin(n);
                            else if (t === '') setDurationMin(0);
                          }}
                          keyboardType="number-pad"
                          selectTextOnFocus
                        />
                        <Text style={{ fontSize: 12, color: tc.textMuted, fontWeight: '600' }}>min</Text>
                      </View>
                      <TouchableOpacity
                        style={[s.durationBtn, { backgroundColor: tc.surfaceRaised, borderColor: tc.border }]}
                        onPress={() => adjustDuration(5)}>
                        <Ionicons name="add" size={20} color={tc.textPrimary} />
                      </TouchableOpacity>
                    </View>

                    {/* Date */}
                    <Text style={[s.label, { color: tc.textPrimary, marginTop: 16 }]}>When</Text>
                    <View style={s.datePickerBlock}>
                      <View style={s.datePickerHeader}>
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <Text style={[s.datePickerSelected, { color: tc.textPrimary }]} numberOfLines={1}>
                            {formatDate(dateOffset)}
                          </Text>
                        </View>
                        <TouchableOpacity
                          testID="activity-date-calendar-toggle"
                          accessibilityLabel={dateCalendarOpen ? 'Hide calendar' : 'Open calendar'}
                          accessibilityRole="button"
                          accessibilityState={{ expanded: dateCalendarOpen }}
                          style={[s.dateCalendarToggle, { backgroundColor: tc.surfaceRaised, borderColor: tc.border }]}
                          onPress={() => {
                            configureExpandAnimation(200);
                            setDatePickerMonth(activityMonthStart(getDateForOffset(dateOffset)));
                            setDateCalendarOpen(open => !open);
                          }}>
                          <Ionicons name={dateCalendarOpen ? 'calendar' : 'calendar-outline'} size={18} color={tc.textPrimary} />
                        </TouchableOpacity>
                      </View>
                      <ScrollView
                        horizontal
                        testID="activity-date-scroll"
                        showsHorizontalScrollIndicator={false}
                        contentContainerStyle={s.dateScrollerContent}>
                        {dateScrollOffsets.map(offset => {
                          const date = getDateForOffset(offset);
                          const active = dateOffset === offset;
                          const dayLabel = offset === 0
                            ? 'Today'
                            : offset === -1
                              ? 'Yesterday'
                              : date.toLocaleDateString(undefined, { weekday: 'short' });
                          const monthLabel = date.toLocaleDateString(undefined, { month: 'short' });
                          return (
                            <TouchableOpacity
                              key={offset}
                              testID={`activity-date-offset-${offset}`}
                              accessibilityRole="button"
                              accessibilityLabel={formatDate(offset)}
                              accessibilityState={{ selected: active }}
                              style={[
                                s.dateChip,
                                {
                                  borderColor: active ? tc.primary : tc.border,
                                  backgroundColor: active ? tc.primary + '18' : tc.surfaceRaised,
                                },
                              ]}
                              onPress={() => {
                                const nextDate = getDateForOffset(offset);
                                setDateOffset(offset);
                                setDatePickerMonth(activityMonthStart(nextDate));
                              }}
                              activeOpacity={0.76}>
                              <Text style={[s.dateChipWeekday, { color: active ? tc.primary : tc.textMuted }]} numberOfLines={1}>
                                {dayLabel}
                              </Text>
                              <Text style={[s.dateChipDay, { color: active ? tc.primary : tc.textPrimary }]}>
                                {date.getDate()}
                              </Text>
                              <Text style={[s.dateChipMonth, { color: active ? tc.primary : tc.textMuted }]} numberOfLines={1}>
                                {monthLabel}
                              </Text>
                            </TouchableOpacity>
                          );
                        })}
                      </ScrollView>
                    </View>

                    {dateCalendarOpen && (
                      <View
                        testID="activity-date-picker"
                        style={[s.dateCalendar, { backgroundColor: tc.surfaceRaised, borderColor: tc.border }]}>
                        <View style={s.dateCalendarHeader}>
                          <TouchableOpacity
                            testID="activity-date-prev-month"
                            accessibilityLabel="activity-date-prev-month"
                            style={[s.dateCalendarNav, { borderColor: tc.border, opacity: dateCalendar.canGoPrev ? 1 : 0.35 }]}
                            onPress={() => setDatePickerMonth(prev => activityMonthStart(new Date(prev.getFullYear(), prev.getMonth() - 1, 1, 12)))}
                            disabled={!dateCalendar.canGoPrev}>
                            <Ionicons name="chevron-back" size={18} color={tc.textPrimary} />
                          </TouchableOpacity>
                          <View style={s.dateCalendarTitle}>
                            <Text style={[s.dateCalendarMonth, { color: tc.textPrimary }]} numberOfLines={1}>
                              {dateCalendar.monthLabel}
                            </Text>
                          </View>
                          <TouchableOpacity
                            testID="activity-date-next-month"
                            accessibilityLabel="activity-date-next-month"
                            style={[s.dateCalendarNav, { borderColor: tc.border, opacity: dateCalendar.canGoNext ? 1 : 0.35 }]}
                            onPress={() => setDatePickerMonth(prev => activityMonthStart(new Date(prev.getFullYear(), prev.getMonth() + 1, 1, 12)))}
                            disabled={!dateCalendar.canGoNext}>
                            <Ionicons name="chevron-forward" size={18} color={tc.textPrimary} />
                          </TouchableOpacity>
                        </View>
                        <View style={s.dateCalendarWeekdays}>
                          {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(day => (
                            <Text key={day} style={[s.dateCalendarWeekday, { color: tc.textMuted }]}>
                              {day}
                            </Text>
                          ))}
                        </View>
                        <View style={s.dateCalendarGrid}>
                          {dateCalendar.cells.map(({ offset, date, dateKey, disabled, inMonth }) => {
                            const active = dateOffset === offset;
                            const dateTestID = disabled
                              ? `activity-date-disabled-${dateKey}`
                              : `activity-date-offset-${offset}`;
                            return (
                              <TouchableOpacity
                                key={dateKey}
                                testID={dateTestID}
                                accessibilityLabel={dateTestID}
                                style={[
                                  s.dateCalendarCell,
                                  {
                                    borderColor: active ? tc.primary : tc.border,
                                    backgroundColor: active ? tc.primary + '18' : 'transparent',
                                    opacity: disabled ? 0.25 : inMonth ? 1 : 0.48,
                                  },
                                ]}
                                onPress={() => {
                                  setDateOffset(offset);
                                  setDatePickerMonth(activityMonthStart(date));
                                  configureExpandAnimation(200);
                                  setDateCalendarOpen(false);
                                }}
                                disabled={disabled}
                                activeOpacity={0.76}>
                                <Text style={[s.dateCalendarDay, { color: active ? tc.primary : tc.textPrimary }]}>
                                  {date.getDate()}
                                </Text>
                              </TouchableOpacity>
                            );
                          })}
                        </View>
                      </View>
                    )}
                  </>
                )}

                {showPrefillEffortDetails && (
                  <View style={[s.effortCard, { backgroundColor: tc.surfaceRaised, borderColor: tc.border }]}>
                    <View style={s.effortHeader}>
                      <View style={[s.effortIcon, { backgroundColor: tc.primary + '18' }]}>
                        <Ionicons name="speedometer-outline" size={15} color={tc.primary} />
                      </View>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={[s.effortTitle, { color: tc.textPrimary }]}>Effort details</Text>
                        <Text style={[s.effortHint, { color: tc.textMuted }]}>Heart-rate data is optional.</Text>
                      </View>
                    </View>
                    <View style={s.effortInputGrid}>
                      {category === 'cardio' && prefill.distanceMiles == null && (
                        <View style={s.effortInputWrap}>
                          <Text style={[s.effortInputLabel, { color: tc.textMuted }]}>Distance (mi)</Text>
                          <TextInput
                            testID="activity-effort-distance-input"
                            style={[s.effortInput, { backgroundColor: tc.background, borderColor: tc.border, color: tc.textPrimary }]}
                            value={distance}
                            onChangeText={setDistance}
                            keyboardType="decimal-pad"
                            placeholder="--"
                            placeholderTextColor={tc.textMuted}
                          />
                        </View>
                      )}
                      {prefill.caloriesBurned == null && (
                        <View style={s.effortInputWrap}>
                          <Text style={[s.effortInputLabel, { color: tc.textMuted }]}>Calories</Text>
                          <TextInput
                            testID="activity-effort-calories-input"
                            style={[s.effortInput, { backgroundColor: tc.background, borderColor: tc.border, color: tc.textPrimary }]}
                            value={calories}
                            onChangeText={setCalories}
                            keyboardType="number-pad"
                            placeholder="--"
                            placeholderTextColor={tc.textMuted}
                          />
                        </View>
                      )}
                      <View style={s.effortInputWrap}>
                        <Text style={[s.effortInputLabel, { color: tc.textMuted }]}>Avg HR</Text>
                        <TextInput
                          testID="activity-effort-heart-rate-input"
                          style={[s.effortInput, { backgroundColor: tc.background, borderColor: tc.border, color: tc.textPrimary }]}
                          value={heartRate}
                          onChangeText={setHeartRate}
                          keyboardType="number-pad"
                          placeholder="--"
                          placeholderTextColor={tc.textMuted}
                        />
                      </View>
                      {supportsSessionRpe && (
                        <View style={s.effortInputWrap}>
                          <Text style={[s.effortInputLabel, { color: tc.textMuted }]}>RPE</Text>
                          <TextInput
                            testID="activity-effort-rpe-input"
                            style={[s.effortInput, { backgroundColor: tc.background, borderColor: tc.border, color: tc.textPrimary }]}
                            value={sessionRpe}
                            onChangeText={setSessionRpe}
                            keyboardType="decimal-pad"
                            placeholder="1-10"
                            placeholderTextColor={tc.textMuted}
                          />
                        </View>
                      )}
                    </View>
                    {shouldSuggestCalories ? (
                      <View
                        testID="activity-calorie-estimate"
                        style={[s.calorieEstimate, { backgroundColor: tc.primary + '12', borderColor: tc.primary + '38' }]}>
                        <Ionicons name="speedometer-outline" size={14} color={tc.primary} />
                        <Text style={[s.calorieEstimateText, { color: tc.textSecondary }]}>
                          Est. burn ~{estimatedCalories?.calories} kcal ({estimatedCalories?.confidence} confidence)
                        </Text>
                      </View>
                    ) : null}
                  </View>
                )}

                {(!prefill || editPrefillValues || category === 'recovery') ? renderTailoredDetailFields() : null}

                {/* Notes */}
                <Text style={[s.label, { color: tc.textPrimary, marginTop: 16 }]}>Notes</Text>
                <TextInput
                  style={[s.input, s.notesInput, { backgroundColor: tc.surfaceRaised, borderColor: tc.border, color: tc.textPrimary }]}
                  placeholder="Optional — how it felt, what you did"
                  placeholderTextColor={tc.textMuted}
                  value={notes}
                  onChangeText={setNotes}
                  multiline
                  numberOfLines={2}
                />

                {/* Save */}
                <PressableScale
                  testID="activity-save"
                  style={{ marginTop: 20, marginBottom: 30 }}
                  onPress={handleSave}
                  disabled={saving || !effectiveSubtype}>
                  <View style={[s.saveBtn, { backgroundColor: (!effectiveSubtype) ? tc.textMuted : tc.primary }]}>
                    {(() => {
                      const onColor = getContrastingTextColor(!effectiveSubtype ? tc.textMuted : tc.primary);
                      return saving ? (
                        <Text style={[s.saveBtnText, { color: onColor }]}>Saving...</Text>
                      ) : (
                        <>
                          <Ionicons name="checkmark-circle" size={20} color={onColor} />
                          <Text style={[s.saveBtnText, { color: onColor }]}>
                            Log {effectiveLabel || '...'} · {durationMin} min · {formatDate(dateOffset)}
                          </Text>
                        </>
                      );
                    })()}
                  </View>
                </PressableScale>
              </>
            )}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ─── Summary pill for the prefilled-data compact row ────────────────────────

function SummaryPill({ label, value, tc }: { label: string; value: string; tc: any }) {
  return (
    <View>
      <Text style={{ fontSize: 9, fontWeight: '700', color: tc.textMuted, letterSpacing: 0 }}>
        {label.toUpperCase()}
      </Text>
      <Text style={{ fontSize: 13, fontWeight: '800', color: tc.textPrimary, marginTop: 2 }}>
        {value}
      </Text>
    </View>
  );
}

function prettyDetailOption(value: string): string {
  return value
    .split('_')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function breathworkLabel(value: string): string {
  if (value === 'wim_hof') return 'Wim Hof';
  if (value === 'physiological_sigh') return 'Phys. Sigh';
  if (value === 'box') return 'Box';
  return prettyDetailOption(value);
}

function climbingLabel(value: string): string {
  if (value === 'top_rope') return 'Top Rope';
  return prettyDetailOption(value);
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: { borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '92%', borderTopWidth: 1 },
  handleTap: { minHeight: 14, paddingTop: 10, justifyContent: 'flex-start' },
  handle: { width: 36, height: 4, borderRadius: 2 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, paddingTop: 14, paddingBottom: 10 },
  title: { fontSize: 18, fontWeight: '700' },
  content: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 20 },
  label: { fontSize: 14, fontWeight: '700', marginBottom: 8 },

  // Step 1: Category cards
  catGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, justifyContent: 'center', paddingTop: 8, paddingBottom: 20 },
  catCard: { width: '47%', borderRadius: 14, borderWidth: 1, overflow: 'hidden', backgroundColor: '#111827' },
  catImage: { minHeight: 124, justifyContent: 'center' },
  catImageStyle: { borderRadius: 13 },
  catImageOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.48)' },
  catContent: { minHeight: 124, padding: 14, alignItems: 'center', justifyContent: 'center', gap: 6 },
  catIconBubble: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.18)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.24)' },
  catLabel: { fontSize: 15, fontWeight: '800', color: '#fff' },
  catDesc: { fontSize: 11, textAlign: 'center', color: 'rgba(255,255,255,0.78)' },
  importSection: { marginTop: -2, marginBottom: 18, gap: 9 },
  importSectionLabel: { fontSize: 10, fontWeight: '900', letterSpacing: 0 },
  importChoiceGrid: { flexDirection: 'row', gap: 10 },
  importChoiceCard: { flex: 1, minHeight: 98, borderRadius: 12, borderWidth: 1, padding: 12, justifyContent: 'center', alignItems: 'center' },
  importChoiceIcon: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', marginBottom: 7 },
  importChoiceTitle: { fontSize: 13, fontWeight: '900' },
  importChoiceSub: { marginTop: 2, fontSize: 10, fontWeight: '700' },
  appleImportPanel: { borderRadius: 12, borderWidth: 1, padding: 10 },

  // Step 2: Chips
  chipGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  subChip: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 10, borderWidth: 1 },
  chip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10, borderWidth: 1 },
  customTypeCard: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 12, borderWidth: 1.5, paddingHorizontal: 12, paddingVertical: 12, marginBottom: 12 },
  customTypeIcon: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  customTypeTitle: { fontSize: 14, fontWeight: '900' },
  customTypeSub: { marginTop: 2, fontSize: 11, fontWeight: '700' },
  customTypeCheck: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  customTypePanel: { borderWidth: 1, borderRadius: 12, padding: 12, marginTop: -4, marginBottom: 12 },
  customTypeInput: { borderWidth: 1, borderRadius: 9, paddingHorizontal: 12, paddingVertical: 9, fontSize: 14, fontWeight: '800', marginTop: 7 },
  customContinueBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, borderRadius: 10, paddingVertical: 12 },
  customContinueText: { fontSize: 13, fontWeight: '800' },
  typeCardGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  typeCard: { width: '47%', borderRadius: 12, borderWidth: 1.5, overflow: 'hidden', backgroundColor: '#111827' },
  typeImage: { minHeight: 112, justifyContent: 'space-between' },
  typeImageStyle: { borderRadius: 11 },
  typeOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.46)' },
  typeCardContent: { flex: 1, minHeight: 112, padding: 10, justifyContent: 'space-between' },
  typeCardTop: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' },
  typeIconBubble: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.18)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.28)' },
  typeCheck: { width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  typeCardLabel: { fontSize: 13, fontWeight: '900', color: '#fff', lineHeight: 15 },
  typeCardDesc: { marginTop: 2, fontSize: 10, fontWeight: '700', color: 'rgba(255,255,255,0.76)' },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10, fontSize: 14, marginTop: 8 },
  notesInput: { minHeight: 50, textAlignVertical: 'top' },

  // Intensity
  intensityBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 12, borderRadius: 10, borderWidth: 1.5 },

  // Effort details
  effortCard: { marginTop: 14, borderWidth: 1, borderRadius: 10, padding: 12, gap: 10 },
  effortHeader: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  effortIcon: { width: 30, height: 30, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  effortTitle: { fontSize: 13, fontWeight: '900' },
  effortHint: { marginTop: 1, fontSize: 11, fontWeight: '700' },
  effortInputGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  effortInputWrap: { flex: 1, minWidth: 86, gap: 5 },
  effortInputLabel: { fontSize: 10, fontWeight: '900', textTransform: 'uppercase', letterSpacing: 0 },
  effortInput: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 7, fontSize: 14, fontWeight: '800', textAlign: 'center' },
  calorieEstimate: { flexDirection: 'row', alignItems: 'center', gap: 7, borderWidth: 1, borderRadius: 9, paddingHorizontal: 10, paddingVertical: 8 },
  calorieEstimateText: { flex: 1, fontSize: 11, fontWeight: '800' },

  // Duration stepper
  durationRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 12 },
  durationBtn: { width: 44, height: 44, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  durationDisplay: { flexDirection: 'row', alignItems: 'baseline', gap: 4, paddingHorizontal: 16, paddingVertical: 8, borderRadius: 12, borderWidth: 1 },
  datePickerBlock: { gap: 9 },
  datePickerHeader: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  datePickerSelected: { fontSize: 15, fontWeight: '900' },
  dateCalendarToggle: { width: 40, height: 40, borderRadius: 10, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  dateScrollerContent: { gap: 8, paddingRight: 2 },
  dateChip: { width: 76, minHeight: 70, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 8, paddingHorizontal: 6 },
  dateChipWeekday: { fontSize: 10, fontWeight: '900' },
  dateChipDay: { fontSize: 21, fontWeight: '900', lineHeight: 24 },
  dateChipMonth: { fontSize: 10, fontWeight: '800' },
  dateCalendar: { borderWidth: 1, borderRadius: 12, padding: 10, gap: 9 },
  dateCalendarHeader: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  dateCalendarNav: { width: 36, height: 36, borderRadius: 10, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  dateCalendarTitle: { flex: 1, minWidth: 0, alignItems: 'center' },
  dateCalendarMonth: { fontSize: 15, fontWeight: '900' },
  dateCalendarWeekdays: { flexDirection: 'row' },
  dateCalendarWeekday: { width: '14.2857%', textAlign: 'center', fontSize: 10, fontWeight: '900' },
  dateCalendarGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  dateCalendarCell: { width: '14.2857%', aspectRatio: 1, borderRadius: 10, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  dateCalendarDay: { fontSize: 13, fontWeight: '900' },

  // Tailored details
  detailCard: { marginTop: 16, borderWidth: 1, borderRadius: 10, padding: 12, gap: 10 },
  detailHeader: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  detailIcon: { width: 30, height: 30, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  detailTitle: { fontSize: 13, fontWeight: '900' },
  detailInputGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  detailInputWrap: { flex: 1, minWidth: 92, gap: 5 },
  detailChoiceWrap: { gap: 6 },
  detailInputLabel: { fontSize: 10, fontWeight: '900', textTransform: 'uppercase', letterSpacing: 0 },
  detailInput: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 7, fontSize: 14, fontWeight: '800', textAlign: 'center' },
  detailWheelFrame: { borderWidth: 1, borderRadius: 8, paddingVertical: 4, overflow: 'hidden' },

  // Save
  saveBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 16, borderRadius: 12, shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.2, shadowRadius: 6, elevation: 3 },
  saveBtnText: { fontSize: 14, fontWeight: '700' },
});
