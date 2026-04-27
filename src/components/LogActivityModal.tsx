import { useState, useCallback, useEffect } from 'react';
import {
  View, Text, Modal, TouchableOpacity, TextInput, ScrollView,
  StyleSheet, Alert, UIManager, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getTheme } from '../constants/theme';
import { configureExpandAnimation } from '../utils/layoutAnim';
import {
  AppThemeName, WorkoutSession,
  ActivityCategory, ActivityIntensity, CardioStyle,
} from '../types';
import PressableScale from './PressableScale';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

// ─── Category definitions ────────────────────────────────────────────────────

const CATEGORIES: { key: ActivityCategory; label: string; icon: string; desc: string }[] = [
  { key: 'strength', label: 'Strength',  icon: 'barbell-outline',    desc: 'Weights, resistance' },
  { key: 'cardio',   label: 'Cardio',    icon: 'bicycle-outline',    desc: 'Running, cycling, swim' },
  { key: 'mobility', label: 'Mobility',  icon: 'body-outline',       desc: 'Yoga, stretching' },
  { key: 'sport',    label: 'Sport',     icon: 'basketball-outline',  desc: 'Basketball, soccer, etc' },
  { key: 'active',   label: 'Active',    icon: 'hammer-outline',      desc: 'Yard work, labor, play' },
  { key: 'recovery', label: 'Recovery',  icon: 'bed-outline',        desc: 'Sauna, ice bath, rest' },
];

type SubtypeDef = { key: string; label: string; icon: string };

const SUBTYPES: Record<ActivityCategory, SubtypeDef[]> = {
  strength: [
    { key: 'push',       label: 'Push',       icon: 'arrow-up-outline' },
    { key: 'pull',       label: 'Pull',       icon: 'arrow-down-outline' },
    { key: 'legs',       label: 'Legs',       icon: 'footsteps-outline' },
    { key: 'upper_body', label: 'Upper Body', icon: 'body-outline' },
    { key: 'lower_body', label: 'Lower Body', icon: 'fitness-outline' },
    { key: 'full_body',  label: 'Full Body',  icon: 'expand-outline' },
  ],
  cardio: [
    { key: 'walk',       label: 'Walk',       icon: 'walk-outline' },
    { key: 'run',        label: 'Run',        icon: 'footsteps-outline' },
    { key: 'ride',       label: 'Ride',       icon: 'bicycle-outline' },
    { key: 'spin',       label: 'Spin Class', icon: 'fitness-outline' },
    { key: 'hike',       label: 'Hike',       icon: 'trail-sign-outline' },
    { key: 'swim',       label: 'Swim',       icon: 'water-outline' },
    { key: 'row',        label: 'Row',        icon: 'boat-outline' },
    { key: 'stair',      label: 'Stair',      icon: 'trending-up-outline' },
    { key: 'elliptical', label: 'Elliptical', icon: 'sync-outline' },
    { key: 'bootcamp',   label: 'Bootcamp',   icon: 'flame-outline' },
    { key: 'other',      label: 'Other',      icon: 'ellipsis-horizontal-outline' },
  ],
  mobility: [
    { key: 'yoga',       label: 'Yoga',       icon: 'body-outline' },
    { key: 'stretching', label: 'Stretching', icon: 'resize-outline' },
    { key: 'foam_roll',  label: 'Foam Roll',  icon: 'ellipse-outline' },
    { key: 'pilates',    label: 'Pilates',    icon: 'flower-outline' },
  ],
  sport: [
    { key: 'basketball',   label: 'Basketball',   icon: 'basketball-outline' },
    { key: 'soccer',       label: 'Soccer',       icon: 'football-outline' },
    { key: 'tennis',       label: 'Tennis',        icon: 'tennisball-outline' },
    { key: 'pickleball',   label: 'Pickleball',   icon: 'tennisball-outline' },
    { key: 'golf',         label: 'Golf',          icon: 'golf-outline' },
    { key: 'climbing',     label: 'Climbing',      icon: 'trending-up-outline' },
    { key: 'boxing',       label: 'Boxing',        icon: 'hand-right-outline' },
    { key: 'kickboxing',   label: 'Kickboxing',    icon: 'hand-left-outline' },
    { key: 'martial_arts', label: 'Martial Arts',  icon: 'shield-outline' },
    { key: 'surfing',      label: 'Surfing',       icon: 'water-outline' },
    { key: 'skiing',       label: 'Skiing',        icon: 'snow-outline' },
    { key: 'other',        label: 'Other',         icon: 'ellipsis-horizontal-outline' },
  ],
  active: [
    { key: 'yard_work',    label: 'Yard Work',     icon: 'leaf-outline' },
    { key: 'chopping_wood', label: 'Chopping Wood', icon: 'hammer-outline' },
    { key: 'moving',       label: 'Moving / Lifting', icon: 'cube-outline' },
    { key: 'gardening',    label: 'Gardening',     icon: 'flower-outline' },
    { key: 'cleaning',     label: 'House Cleaning', icon: 'home-outline' },
    { key: 'construction', label: 'Construction',  icon: 'construct-outline' },
    { key: 'shoveling',    label: 'Shoveling',     icon: 'snow-outline' },
    { key: 'playing',      label: 'Playing w/ Kids', icon: 'happy-outline' },
    { key: 'dancing',      label: 'Dancing',       icon: 'musical-notes-outline' },
    { key: 'other',        label: 'Other',         icon: 'ellipsis-horizontal-outline' },
  ],
  recovery: [
    { key: 'sauna',      label: 'Sauna',      icon: 'flame-outline' },
    { key: 'ice_bath',   label: 'Ice Bath',   icon: 'snow-outline' },
    { key: 'walk',       label: 'Walk',        icon: 'walk-outline' },
    { key: 'sleep',      label: 'Sleep',       icon: 'moon-outline' },
    { key: 'meditation', label: 'Meditation',  icon: 'leaf-outline' },
    { key: 'general',    label: 'General',     icon: 'heart-outline' },
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

// ─── Legacy focus mapping ────────────────────────────────────────────────────

const LEGACY_FOCUS: Record<string, Record<string, string>> = {
  strength: { push: 'Push', pull: 'Pull', legs: 'Legs', upper_body: 'Upper Body', lower_body: 'Lower Body', full_body: 'Full Body' },
  cardio:   { walk: 'Walking', run: 'Running', ride: 'Cycling', spin: 'Spin Class', hike: 'Hiking', swim: 'Swimming', row: 'Rowing', stair: 'Cardio', elliptical: 'Cardio', bootcamp: 'Cardio', other: 'Cardio' },
  mobility: { yoga: 'Yoga', stretching: 'Stretching', foam_roll: 'Foam Rolling', pilates: 'Pilates' },
  sport:    { basketball: 'Cardio', soccer: 'Cardio', tennis: 'Cardio', pickleball: 'Cardio', golf: 'Cardio', climbing: 'Cardio', boxing: 'Cardio', kickboxing: 'Cardio', martial_arts: 'Cardio', surfing: 'Cardio', skiing: 'Cardio', other: 'Cardio' },
  active:   { yard_work: 'Full Body', chopping_wood: 'Full Body', moving: 'Full Body', gardening: 'Cardio', cleaning: 'Cardio', construction: 'Full Body', shoveling: 'Full Body', playing: 'Cardio', dancing: 'Cardio', other: 'Cardio' },
  recovery: { sauna: 'Recovery', ice_bath: 'Recovery', walk: 'Recovery', sleep: 'Recovery', meditation: 'Recovery', general: 'Recovery' },
};

function getLegacyFocus(category: ActivityCategory, subtype: string, custom?: string): string {
  if (custom?.trim()) return custom.trim();
  return LEGACY_FOCUS[category]?.[subtype] ?? 'General';
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
  distanceMiles?: number | null;
  caloriesBurned?: number | null;
  avgHeartRate?: number | null;
  startedAtISO?: string;
  endedAtISO?: string;
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
}

export default function LogActivityModal({ visible, onClose, onSave, themeName, prefill }: Props) {
  const tc = getTheme(themeName).colors;

  const [step, setStep] = useState<1 | 2>(1);
  const [category, setCategory] = useState<ActivityCategory | null>(null);
  const [subtype, setSubtype] = useState('');
  const [customSubtype, setCustomSubtype] = useState('');
  const [intensity, setIntensity] = useState<ActivityIntensity>('moderate');
  const [cardioStyle, setCardioStyle] = useState<CardioStyle | undefined>(undefined);
  const [durationMin, setDurationMin] = useState(45);
  const [dateOffset, setDateOffset] = useState(0);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [distance, setDistance] = useState('');
  const [calories, setCalories] = useState('');
  const [heartRate, setHeartRate] = useState('');

  const reset = useCallback(() => {
    setStep(1);
    setCategory(null);
    setSubtype('');
    setCustomSubtype('');
    setIntensity('moderate');
    setCardioStyle(undefined);
    setDurationMin(45);
    setDateOffset(0);
    setNotes('');
    setSaving(false);
    setShowAdvanced(false);
    setDistance('');
    setCalories('');
    setHeartRate('');
  }, []);

  // Seed state from prefill when the modal opens. Only runs on
  // visibility transition so it doesn't clobber user edits mid-flow.
  useEffect(() => {
    if (!visible) return;
    if (!prefill) return;
    if (prefill.category) {
      setCategory(prefill.category);
      setStep(2); // skip the category picker — AH already told us
    }
    if (prefill.subtype) setSubtype(prefill.subtype);
    if (prefill.cardioStyle) setCardioStyle(prefill.cardioStyle);
    if (typeof prefill.durationMin === 'number' && prefill.durationMin > 0) {
      setDurationMin(Math.round(prefill.durationMin));
    }
    if (prefill.dateISO) {
      // Date offset must be computed from LOCAL calendar dates, not raw
      // timestamp diffs. The old code used `then.getTime() - midnightToday`
      // which gave a rounded ms-diff: a Thursday 22:00 local workout
      // about 2h before today's midnight rounded to 0 = "today" — even
      // though Apple Health correctly recorded it as Thursday. Result:
      // table said Thursday, but the log form defaulted to today (= Fri).
      //
      // Fix: build local-date keys (YYYY-MM-DD using getFullYear/Month/Date,
      // NOT toISOString which is UTC) and diff by day count.
      const then = new Date(prefill.dateISO);
      const now = new Date();
      const localDateKey = (d: Date) =>
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const thenKey = localDateKey(then);
      const nowKey = localDateKey(now);
      // Walk back from today; matching date wins. Caps at 14 days to
      // align with the picker's range.
      let offset = 0;
      for (let i = 0; i >= -14; i--) {
        const probe = new Date();
        probe.setDate(probe.getDate() + i);
        if (localDateKey(probe) === thenKey) {
          offset = i;
          break;
        }
      }
      // Defensive: if thenKey is older than 14 days OR (rarely) future,
      // clamp. We never trust prefill to set a future date.
      if (thenKey === nowKey) offset = 0;
      setDateOffset(Math.max(-14, Math.min(0, offset)));
    }
    if (prefill.distanceMiles != null) setDistance(String(prefill.distanceMiles));
    if (prefill.caloriesBurned != null) setCalories(String(Math.round(prefill.caloriesBurned)));
    if (prefill.avgHeartRate != null) setHeartRate(String(Math.round(prefill.avgHeartRate)));
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
    // NOTE: do NOT auto-open the Advanced section when prefill is
    // present. The read-only summary card already shows distance /
    // calories / HR clearly. Auto-expanding was hiding the summary
    // and forcing users to re-pick date + duration that HK already
    // gave us. (The "Edit values" link on the summary exposes the
    // full pickers on demand.)
  }, [visible, prefill]);

  const selectCategory = (cat: ActivityCategory) => {
    configureExpandAnimation(300);
    setCategory(cat);
    setSubtype('');
    setCustomSubtype('');
    if (cat === 'recovery') setIntensity('easy');
    else setIntensity('moderate');
    setCardioStyle(undefined);
    setStep(2);
  };

  const goBack = () => {
    configureExpandAnimation(300);
    setStep(1);
  };

  const getDateForOffset = (offset: number) => {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return d;
  };

  const formatDate = (offset: number) => {
    if (offset === 0) return 'Today';
    if (offset === -1) return 'Yesterday';
    const d = getDateForOffset(offset);
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  };

  const effectiveSubtype = subtype || customSubtype.trim();
  const effectiveLabel = (() => {
    if (customSubtype.trim()) return customSubtype.trim();
    if (!category || !subtype) return '';
    const def = SUBTYPES[category]?.find(s => s.key === subtype);
    return def?.label ?? subtype;
  })();

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
      const legacyFocus = getLegacyFocus(category, subtype, customSubtype);
      const session: WorkoutSession = {
        // Keep the HK externalId (or whatever the caller passed) as
        // the session id so a re-import of the same workout dedupes
        // via `alreadyImportedIds` in detectUnloggedWorkouts.
        id: prefill?.externalId
          ?? `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        date: date.toISOString(),
        focus: legacyFocus,
        durationSeconds: durationMin * 60,
        // When an import or live-tracker gave us exact timestamps
        // carry them through — the fatigue model + overlap-dedupe
        // both benefit from real intervals instead of synthesized ones.
        ...(prefill?.startedAtISO ? { startedAt: prefill.startedAtISO } : {}),
        ...(prefill?.endedAtISO ? { endedAt: prefill.endedAtISO } : {}),
        exercises: [],
        completed: true,
        manualActivity: {
          category,
          subtype: effectiveSubtype,
          intensity,
          ...(category === 'cardio' && cardioStyle ? { cardioStyle } : {}),
          ...(notes.trim() ? { notes: notes.trim() } : {}),
          ...(distance ? { distanceMiles: parseFloat(distance) } : {}),
          ...(calories ? { caloriesBurned: parseFloat(calories) } : {}),
          ...(heartRate ? { avgHeartRate: parseInt(heartRate, 10) } : {}),
          // Tag the source so the UI + analytics can distinguish
          // imported HK workouts, live-tracker sessions, and plain
          // manual-retro entries.
          ...(prefill?.externalId?.startsWith('hk_') ? { source: 'apple_health' as any } : {}),
          ...(prefill?.externalId?.startsWith('live_') ? { source: 'live_tracker' as any } : {}),
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

  const adjustDuration = (delta: number) => {
    setDurationMin(prev => Math.max(5, Math.min(300, prev + delta)));
  };

  // ─── Render ──────────────────────────────────────────────────────────────────

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={() => { reset(); onClose(); }}>
      <View style={s.overlay}>
        <View style={[s.sheet, { backgroundColor: tc.surface, borderTopColor: tc.border }]}>
          <View style={[s.handle, { backgroundColor: tc.border }]} />

          {/* Header */}
          <View style={s.header}>
            {step === 2 ? (
              <TouchableOpacity onPress={goBack} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                <Ionicons name="chevron-back" size={20} color={tc.primary} />
                <Text style={{ fontSize: 16, fontWeight: '600', color: tc.primary }}>
                  {CATEGORIES.find(c => c.key === category)?.label ?? 'Back'}
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

          <ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>

            {/* ── Step 1: Category Selection ─────────────────────────── */}
            {step === 1 && (
              <View style={s.catGrid}>
                {CATEGORIES.map(cat => (
                  <TouchableOpacity
                    key={cat.key}
                    style={[s.catCard, { backgroundColor: tc.surfaceRaised, borderColor: tc.border }]}
                    onPress={() => selectCategory(cat.key)}
                    activeOpacity={0.7}>
                    <Ionicons name={cat.icon as any} size={28} color={tc.primary} />
                    <Text style={[s.catLabel, { color: tc.textPrimary }]}>{cat.label}</Text>
                    <Text style={[s.catDesc, { color: tc.textMuted }]}>{cat.desc}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}

            {/* ── Step 2: Details ─────────────────────────────────────── */}
            {step === 2 && category && (
              <>
                {/* Subtype */}
                <Text style={[s.label, { color: tc.textPrimary }]}>Type</Text>
                <View style={s.chipGrid}>
                  {SUBTYPES[category].map(opt => {
                    const active = subtype === opt.key;
                    return (
                      <TouchableOpacity
                        key={opt.key}
                        style={[s.subChip, {
                          borderColor: active ? tc.primary : tc.border,
                          backgroundColor: active ? tc.primary + '18' : tc.surfaceRaised,
                        }]}
                        onPress={() => { setSubtype(active ? '' : opt.key); setCustomSubtype(''); }}>
                        <Ionicons name={opt.icon as any} size={16} color={active ? tc.primary : tc.textMuted} />
                        <Text style={{ fontSize: 13, fontWeight: '600', color: active ? tc.primary : tc.textPrimary }}>{opt.label}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
                <TextInput
                  style={[s.input, { backgroundColor: tc.surfaceRaised, borderColor: tc.border, color: tc.textPrimary }]}
                  placeholder="Or describe your own"
                  placeholderTextColor={tc.textMuted}
                  value={customSubtype}
                  onChangeText={t => { setCustomSubtype(t); if (t.trim()) setSubtype(''); }}
                  returnKeyType="done"
                />

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
                {category === 'cardio' && (
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
                {prefill && !showAdvanced ? (
                  <View style={{
                    marginTop: 16,
                    padding: 12,
                    borderRadius: 10,
                    backgroundColor: tc.surfaceRaised,
                    borderWidth: 1,
                    borderColor: tc.border,
                  }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                      <Ionicons name="information-circle-outline" size={14} color={tc.primary} />
                      <Text style={{ fontSize: 11, fontWeight: '700', color: tc.textSecondary, letterSpacing: 0.4 }}>
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
                      onPress={() => { configureExpandAnimation(200); setShowAdvanced(true); }}
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
                    <View style={s.chipRow}>
                      {[0, -1, -2, -3].map(offset => {
                        const active = dateOffset === offset;
                        return (
                          <TouchableOpacity
                            key={offset}
                            style={[s.chip, { borderColor: active ? tc.primary : tc.border, backgroundColor: active ? tc.primary + '18' : tc.surfaceRaised }]}
                            onPress={() => setDateOffset(offset)}>
                            <Text style={{ fontSize: 12, fontWeight: '600', color: active ? tc.primary : tc.textSecondary }}>{formatDate(offset)}</Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  </>
                )}

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

                {/* Advanced toggle */}
                <TouchableOpacity
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 12, alignSelf: 'flex-start' }}
                  onPress={() => { configureExpandAnimation(300); setShowAdvanced(!showAdvanced); }}>
                  <Ionicons name={showAdvanced ? 'chevron-up' : 'chevron-down'} size={16} color={tc.textMuted} />
                  <Text style={{ fontSize: 12, fontWeight: '600', color: tc.textMuted }}>Advanced details</Text>
                </TouchableOpacity>

                {showAdvanced && (
                  <View style={{ gap: 10, marginTop: 10 }}>
                    {category === 'cardio' && (
                      <View style={s.advRow}>
                        <Text style={[s.advLabel, { color: tc.textSecondary }]}>Distance (mi)</Text>
                        <TextInput
                          style={[s.advInput, { backgroundColor: tc.surfaceRaised, borderColor: tc.border, color: tc.textPrimary }]}
                          value={distance} onChangeText={setDistance} keyboardType="decimal-pad" placeholder="—" placeholderTextColor={tc.textMuted}
                        />
                      </View>
                    )}
                    <View style={s.advRow}>
                      <Text style={[s.advLabel, { color: tc.textSecondary }]}>Calories burned</Text>
                      <TextInput
                        style={[s.advInput, { backgroundColor: tc.surfaceRaised, borderColor: tc.border, color: tc.textPrimary }]}
                        value={calories} onChangeText={setCalories} keyboardType="number-pad" placeholder="—" placeholderTextColor={tc.textMuted}
                      />
                    </View>
                    <View style={s.advRow}>
                      <Text style={[s.advLabel, { color: tc.textSecondary }]}>Avg heart rate</Text>
                      <TextInput
                        style={[s.advInput, { backgroundColor: tc.surfaceRaised, borderColor: tc.border, color: tc.textPrimary }]}
                        value={heartRate} onChangeText={setHeartRate} keyboardType="number-pad" placeholder="—" placeholderTextColor={tc.textMuted}
                      />
                    </View>
                  </View>
                )}

                {/* Save */}
                <PressableScale
                  style={{ marginTop: 20, marginBottom: 30 }}
                  onPress={handleSave}
                  disabled={saving || !effectiveSubtype}>
                  <View style={[s.saveBtn, { backgroundColor: (!effectiveSubtype) ? tc.textMuted : tc.primary }]}>
                    {saving ? (
                      <Text style={s.saveBtnText}>Saving...</Text>
                    ) : (
                      <>
                        <Ionicons name="checkmark-circle" size={20} color="#fff" />
                        <Text style={s.saveBtnText}>
                          Log {effectiveLabel || '...'} · {durationMin} min · {formatDate(dateOffset)}
                        </Text>
                      </>
                    )}
                  </View>
                </PressableScale>
              </>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

// ─── Summary pill for the prefilled-data compact row ────────────────────────

function SummaryPill({ label, value, tc }: { label: string; value: string; tc: any }) {
  return (
    <View>
      <Text style={{ fontSize: 9, fontWeight: '700', color: tc.textMuted, letterSpacing: 0.5 }}>
        {label.toUpperCase()}
      </Text>
      <Text style={{ fontSize: 13, fontWeight: '800', color: tc.textPrimary, marginTop: 2 }}>
        {value}
      </Text>
    </View>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: { borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '92%', borderTopWidth: 1 },
  handle: { width: 36, height: 4, borderRadius: 2, alignSelf: 'center', marginTop: 10 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, paddingTop: 14, paddingBottom: 10 },
  title: { fontSize: 18, fontWeight: '700' },
  content: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 20 },
  label: { fontSize: 14, fontWeight: '700', marginBottom: 8 },

  // Step 1: Category cards
  catGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, justifyContent: 'center', paddingTop: 8, paddingBottom: 20 },
  catCard: { width: '47%', borderRadius: 14, borderWidth: 1, padding: 16, alignItems: 'center', gap: 6 },
  catLabel: { fontSize: 15, fontWeight: '700' },
  catDesc: { fontSize: 11, textAlign: 'center' },

  // Step 2: Chips
  chipGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  subChip: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 10, borderWidth: 1 },
  chip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10, borderWidth: 1 },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10, fontSize: 14, marginTop: 8 },
  notesInput: { minHeight: 50, textAlignVertical: 'top' },

  // Intensity
  intensityBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 12, borderRadius: 10, borderWidth: 1.5 },

  // Duration stepper
  durationRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 12 },
  durationBtn: { width: 44, height: 44, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  durationDisplay: { flexDirection: 'row', alignItems: 'baseline', gap: 4, paddingHorizontal: 16, paddingVertical: 8, borderRadius: 12, borderWidth: 1 },

  // Advanced
  advRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  advLabel: { fontSize: 13, fontWeight: '600' },
  advInput: { width: 90, borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, fontSize: 14, textAlign: 'center' },

  // Save
  saveBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 16, borderRadius: 12, shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.2, shadowRadius: 6, elevation: 3 },
  saveBtnText: { color: '#fff', fontSize: 14, fontWeight: '700' },
});
