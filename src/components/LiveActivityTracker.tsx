// Open-ended live workout tracker. The user picks a category +
// subtype, hits Start, and Thallo runs a timer + HR polling while
// they're moving. Quick-start workout picks hand off to the standard
// ActiveWorkoutScreen flow when the parent provides it, so they finish
// with the same recap/share summary as assigned workouts. The in-modal
// stopwatch remains the fallback save path.
//
// Why not write directly to history on Finish?
//   Users often want to bump intensity or add distance / notes once
//   the workout is over. Routing through LogActivityModal keeps the
//   single canonical save path (same manualActivity shape, same
//   fatigue routing) instead of forking a second save function.
//
// Why is this separate from ActiveWorkoutScreen?
//   ActiveWorkoutScreen is a structured lift flow — exercise list,
//   set logging, rest timers, PR modal. This tracker is for the
//   "just going for a run" case where none of that matters.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import LiveCardioMap from './LiveCardioMap';

// Conversion constant — `miToUnit` from utils/units uses miles as
// canonical. The GPS tracker emits meters; we convert via km here.
const MI_PER_KM = 0.6213711922;

function fmtPaceSecPerMi(secPerKm: number | null): string {
  if (secPerKm == null) return '—';
  // sec/mi = sec/km / MI_PER_KM (mile is longer than km)
  const secPerMi = secPerKm / MI_PER_KM;
  const m = Math.floor(secPerMi / 60);
  const s = Math.floor(secPerMi % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function fmtDistanceMi(meters: number): string {
  if (meters <= 0) return '—';
  const mi = (meters / 1000) * MI_PER_KM;
  return mi < 100 ? `${mi.toFixed(2)}` : `${mi.toFixed(0)}`;
}
import {
  AppState, Modal, View, Text, TouchableOpacity, ScrollView, Alert, StyleSheet, ImageBackground, TextInput,
} from 'react-native';
import type { ImageSourcePropType } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { getTheme, radius } from '../constants/theme';
import {
  AppThemeName, ActivityCategory, CardioStyle, WorkoutSession,
} from '../types';
import { isHealthKitAvailable, getLatestHeartRate, getWorkoutHrSummary, getAppleWorkoutCaloriesForWindow, readHealthSummary } from '../services/appleHealth';
import { getHRZones, type HRZone } from '../services/api';
import LogActivityModal, { LogActivityPrefill } from './LogActivityModal';
import { saveWorkoutSession } from '../utils/workoutHistory';
import { startRestActivity, updateRestActivity, endRestActivity } from '../services/liveActivity';
import { pushWorkoutToWatch, clearWorkoutFromWatch, WatchBridge } from '../utils/watchSync';
import { clearManagedInterval, useManagedInterval } from '../hooks/useManagedInterval';
import { hrZoneColorHex, hrZoneRangeText, liveActivityHrZoneFields, zoneForHeartRate } from '../utils/hrZones';
import {
  LIVE_ACTIVITY_QUICK_START,
  liveActivityQuickStartKey,
  resolveLiveActivityQuickStart,
  type LiveActivityInitialActivity,
  type LiveActivityQuickStartOption,
} from '../utils/liveActivityQuickStart';
import { estimateRouteElevationGainFt } from '../utils/cardioGpsTracker';
import { defaultVenueForActivity, venueImpliesGps, type ActivityVenue } from '../utils/activityVenue';

interface Props {
  visible: boolean;
  onClose: () => void;
  themeName?: AppThemeName;
  /** Optional — called after the save completes so the parent can
   *  refresh history / fatigue. */
  onSaved?: () => void;
  /** Optional canonical persistence path. When provided by the parent,
   *  it should save locally and sync the completion to the backend. */
  onSave?: (session: WorkoutSession) => Promise<void>;
  /** Strength picks (Push / Pull / Legs / Strength / etc) don't fit
   *  the cardio stopwatch model — they need an exercise picker + per-
   *  set logging. When this callback is provided, the strength rows
   *  in QUICK_START close this modal and call back with the focus so
   *  the parent can mount ActiveWorkoutScreen on an empty workout
   *  the user populates manually. Falls back to the stopwatch path
   *  when omitted. */
  onStartStrengthWorkout?: (focus: string) => void;
  /** When set, non-strength picks (Run/Walk/Basketball/Yoga/etc.)
   *  close this modal and hand off to the parent's active-workout flow
   *  instead of the basic stopwatch path. The parent mounts
   *  ActiveWorkoutScreen with a synthetic WorkoutDay so the user gets
   *  the full recap/share experience. Falls back to the in-modal
   *  stopwatch when omitted. */
  onStartCardioWorkout?: (label: string, subtype: string, category?: ActivityCategory, cardioStyle?: CardioStyle, venue?: ActivityVenue) => void;
  enableHealthKit?: boolean;
  initialActivity?: LiveActivityInitialActivity | null;
  authToken?: string | null;
  /** Bump to request that the tracker run its finish flow as if the
   *  user had tapped the in-modal Finish button. Used when the watch
   *  ends a session it started — without this, the watch's
   *  `end_workout` command would only dismiss the companion modal and
   *  the cardio session would never reach `/workouts/complete`. */
  finishSignal?: number;
}

type Phase = 'pick' | 'running' | 'paused' | 'finishing';
type QuickStartFilterKey = 'all' | 'strength' | 'cardio' | 'sport' | 'mobility' | 'indoor' | 'outdoor';

const QUICK_START_FILTERS: Array<{ key: QuickStartFilterKey; label: string; icon: string }> = [
  { key: 'all', label: 'All', icon: 'apps-outline' },
  { key: 'strength', label: 'Strength', icon: 'barbell-outline' },
  { key: 'cardio', label: 'Cardio', icon: 'speedometer-outline' },
  { key: 'sport', label: 'Sport', icon: 'tennisball-outline' },
  { key: 'mobility', label: 'Mobility', icon: 'body-outline' },
  { key: 'outdoor', label: 'Outdoor', icon: 'sunny-outline' },
  { key: 'indoor', label: 'Indoor', icon: 'home-outline' },
];

const QUICK_START_SEARCH_ALIASES: Partial<Record<string, string>> = {
  lift: 'weights lifting gym barbell dumbbell',
  full_body: 'full body total body',
  powerlifting: 'power lifting squat bench deadlift',
  crossfit: 'functional fitness wod metcon',
  run: 'running jog jogging treadmill',
  walk: 'walking steps treadmill',
  hike: 'hiking trail',
  ride: 'bike bicycle cycling cycle',
  spin: 'stationary bike indoor bike cycling',
  swim: 'swimming pool open water',
  row: 'rowing erg rower',
  stair: 'stairs stairmaster stair climber',
  hiit: 'intervals bootcamp boot camp',
  martial_arts: 'martial arts mma boxing',
  beach_volleyball: 'beach volleyball',
  yoga: 'flow mobility',
  pilates: 'core reformer',
  stretching: 'stretch mobility recovery',
};

const QUICK_START_IMAGES: Record<string, ImageSourcePropType> = {
  'strength:lift': require('../../assets/images/card-backgrounds/workout-card-free-weights-day-male.jpg'),
  'strength:push': require('../../assets/images/card-backgrounds/workout-card-push-day-male.jpg'),
  'strength:pull': require('../../assets/images/card-backgrounds/workout-card-pull-day-rowing.jpg'),
  'strength:legs': require('../../assets/images/card-backgrounds/workout-card-legs-day-male.jpg'),
  'strength:upper': require('../../assets/images/card-backgrounds/workout-card-push-day-female.jpg'),
  'strength:lower': require('../../assets/images/card-backgrounds/workout-card-leg-extension-day-female.jpg'),
  'strength:full_body': require('../../assets/images/card-backgrounds/workout-card-generic-gym-day-neutral.jpg'),
  'strength:powerlifting': require('../../assets/images/card-backgrounds/workout-card-hinge-day-male.jpg'),
  'strength:crossfit': require('../../assets/images/card-backgrounds/workout-card-hiit-day-female.jpg'),
  'cardio:run:outdoor': require('../../assets/images/card-backgrounds/workout-card-running-day-male.jpg'),
  'cardio:run:indoor': require('../../assets/images/card-backgrounds/workout-card-treadmill-day-neutral.jpg'),
  'cardio:walk:outdoor': require('../../assets/images/card-backgrounds/workout-card-walking-day.jpg'),
  'cardio:walk:indoor': require('../../assets/images/card-backgrounds/workout-card-treadmill-day-female.jpg'),
  'cardio:hike': require('../../assets/images/card-backgrounds/workout-card-hiking-mountains-day.jpg'),
  'cardio:hike:outdoor': require('../../assets/images/card-backgrounds/workout-card-hiking-mountains-day.jpg'),
  'cardio:ride:outdoor': require('../../assets/images/card-backgrounds/workout-card-cycling-day.jpg'),
  'cardio:ride:indoor': require('../../assets/images/card-backgrounds/workout-card-spin-class-day.jpg'),
  'cardio:swim:indoor': require('../../assets/images/card-backgrounds/workout-card-swimming-day-neutral.jpg'),
  'cardio:swim:outdoor': require('../../assets/images/card-backgrounds/workout-card-open-water-swim-day.jpg'),
  'cardio:row:indoor': require('../../assets/images/card-backgrounds/workout-card-pull-day-rowing.jpg'),
  'cardio:row:outdoor': require('../../assets/images/card-backgrounds/workout-card-rowing-outdoor-day.jpg'),
  'cardio:spin': require('../../assets/images/card-backgrounds/workout-card-cycling-day.jpg'),
  'cardio:spin:indoor': require('../../assets/images/card-backgrounds/workout-card-spin-class-day.jpg'),
  'cardio:stair': require('../../assets/images/card-backgrounds/workout-card-treadmill-day-female.jpg'),
  'cardio:stair:indoor': require('../../assets/images/card-backgrounds/workout-card-stair-day.jpg'),
  'cardio:hiit': require('../../assets/images/card-backgrounds/workout-card-hiit-day-male.jpg'),
  'cardio:hiit:indoor': require('../../assets/images/card-backgrounds/workout-card-hiit-day-male.jpg'),
  'cardio:bootcamp': require('../../assets/images/card-backgrounds/workout-card-hiit-day-male.jpg'),
  'sport:soccer:outdoor': require('../../assets/images/card-backgrounds/workout-card-soccer-day.jpg'),
  'sport:soccer:indoor': require('../../assets/images/card-backgrounds/workout-card-soccer-indoor-day.jpg'),
  'sport:basketball:indoor': require('../../assets/images/card-backgrounds/workout-card-basketball-day.jpg'),
  'sport:basketball:outdoor': require('../../assets/images/card-backgrounds/workout-card-basketball-outdoor-day.jpg'),
  'sport:tennis:outdoor': require('../../assets/images/card-backgrounds/workout-card-tennis-day.jpg'),
  'sport:tennis:indoor': require('../../assets/images/card-backgrounds/workout-card-tennis-indoor-day.jpg'),
  'sport:pickleball:outdoor': require('../../assets/images/card-backgrounds/workout-card-pickleball-day.jpg'),
  'sport:pickleball:indoor': require('../../assets/images/card-backgrounds/workout-card-pickleball-indoor-day.jpg'),
  'sport:volleyball:indoor': require('../../assets/images/card-backgrounds/workout-card-volleyball-day.jpg'),
  'sport:volleyball:outdoor': require('../../assets/images/card-backgrounds/workout-card-volleyball-outdoor-day.jpg'),
  'sport:beach_volleyball': require('../../assets/images/card-backgrounds/workout-card-beach-volleyball-day.jpg'),
  'sport:beach_volleyball:outdoor': require('../../assets/images/card-backgrounds/workout-card-beach-volleyball-day.jpg'),
  'sport:golf': require('../../assets/images/card-backgrounds/workout-card-golf-day.jpg'),
  'sport:golf:outdoor': require('../../assets/images/card-backgrounds/workout-card-golf-day.jpg'),
  'sport:martial_arts': require('../../assets/images/card-backgrounds/workout-card-martial-arts-day.jpg'),
  'sport:martial_arts:indoor': require('../../assets/images/card-backgrounds/workout-card-martial-arts-day.jpg'),
  'mobility:yoga': require('../../assets/images/card-backgrounds/workout-card-yoga-day.jpg'),
  'mobility:yoga:indoor': require('../../assets/images/card-backgrounds/workout-card-yoga-day.jpg'),
  'mobility:yoga:outdoor': require('../../assets/images/card-backgrounds/workout-card-yoga-outdoor-day.jpg'),
  'mobility:pilates': require('../../assets/images/card-backgrounds/workout-card-pilates-day.jpg'),
  'mobility:stretching': require('../../assets/images/card-backgrounds/workout-card-recovery-day-male.jpg'),
};

const QUICK_START_FALLBACK_IMAGE = require('../../assets/images/card-backgrounds/workout-card-generic-gym-day-neutral.jpg');

function normalizeQuickStartText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');
}

function quickStartVenue(option: LiveActivityQuickStartOption): ActivityVenue | null {
  if (option.venue) return option.venue;
  if (option.category === 'strength') return null;
  return defaultVenueForActivity(option.category, option.subtype);
}

function quickStartMatchesFilter(option: LiveActivityQuickStartOption, filter: QuickStartFilterKey): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'indoor':
    case 'outdoor':
      return quickStartVenue(option) === filter;
    default:
      return option.category === filter;
  }
}

function quickStartSearchText(option: LiveActivityQuickStartOption): string {
  const venue = quickStartVenue(option);
  return normalizeQuickStartText([
    option.label,
    option.category,
    option.subtype,
    option.cardioStyle,
    venue,
    QUICK_START_SEARCH_ALIASES[option.subtype],
  ].filter(Boolean).join(' '));
}

function fmtElapsed(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

export default function LiveActivityTracker({ visible, onClose, themeName, onSaved, onSave, onStartStrengthWorkout, onStartCardioWorkout, enableHealthKit = true, initialActivity = null, authToken = null, finishSignal = 0 }: Props) {
  const theme = getTheme(themeName);
  const tc = theme.colors;
  const insets = useSafeAreaInsets();
  const [phase, setPhase] = useState<Phase>('pick');
  const [choice, setChoice] = useState<LiveActivityQuickStartOption | null>(null);
  const [startedAtMs, setStartedAtMs] = useState<number | null>(null);
  const [pausedAccum, setPausedAccum] = useState<number>(0); // seconds
  const [pauseStartMs, setPauseStartMs] = useState<number | null>(null);
  const [elapsedSec, setElapsedSec] = useState<number>(0);
  const [hr, setHr] = useState<number | null>(null);
  // Simple running HR average — sum + count, not per-sample history.
  const [hrSum, setHrSum] = useState<number>(0);
  const [hrN, setHrN] = useState<number>(0);
  const [hrZones, setHrZones] = useState<HRZone[]>([]);
  const [prefill, setPrefill] = useState<LogActivityPrefill | null>(null);
  const [logModalVisible, setLogModalVisible] = useState(false);
  const [activitySearch, setActivitySearch] = useState('');
  const [activityFilter, setActivityFilter] = useState<QuickStartFilterKey>('all');

  // ── Live GPS tracking (outdoor cardio only) ──────────────────────
  // Activated when the user picks an outdoor cardio (Run/Walk/Bike/
  // Hike) and the timer enters the running phase. Indoor cardio,
  // strength, sport, mobility skip the tracker entirely so we never
  // ask for location permission unless it actually drives the UI.
  // Same `cardioGpsTracker` infrastructure ActiveWorkoutScreen uses.
  const cardioGpsHandleRef = useRef<import('../utils/cardioGpsTracker').CardioGpsHandle | null>(null);
  const [gpsDistanceMeters, setGpsDistanceMeters] = useState<number>(0);
  const [gpsPaceSecPerKm, setGpsPaceSecPerKm] = useState<number | null>(null);
  const [gpsCoords, setGpsCoords] = useState<ReadonlyArray<{ lat: number; lon: number }>>([]);
  const [gpsCurrent, setGpsCurrent] = useState<{ lat: number; lon: number } | null>(null);
  const lastGpsRouteLenRef = useRef(0);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const hrIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const liveActivityIdRef = useRef<string | null>(null);
  const liveActivityGenerationRef = useRef(0);
  const autoStartKeyRef = useRef<string | null>(null);
  // Watch sync: each in-modal stopwatch session gets a sessionId pushed
  // to the watch so it knows the phone is mid-workout. When the session
  // was originated by a watch tap (`source: 'watch'` payload), we re-use
  // its `watch-` sessionId so both devices end the same identity instead
  // of leaking ghost sessions. `phone-` prefix when the user picked from
  // the phone modal directly.
  const watchSessionIdRef = useRef<string | null>(null);

  /// True when the picked activity should pull GPS — drives whether
  /// the map renders + whether we attach route coords on finish. Now keyed
  /// off the chosen venue (indoor never GPS-tracks) rather than guessing by
  /// subtype, so an "Indoor Run" / trainer ride stays quiet.
  const isOutdoorCardio = useMemo(() => {
    if (!choice) return false;
    const venue = choice.venue ?? defaultVenueForActivity(choice.category, choice.subtype);
    return venueImpliesGps(venue, choice.category, choice.subtype);
  }, [choice]);
  const canUseHealthKit = enableHealthKit && isHealthKitAvailable();
  const liveZone = zoneForHeartRate(hr, hrZones);
  const liveZoneColor = hrZoneColorHex(liveZone?.zone, tc.primary);
  const filteredQuickStartOptions = useMemo(() => {
    const query = normalizeQuickStartText(activitySearch);
    const terms = query.split(' ').filter(Boolean);
    return LIVE_ACTIVITY_QUICK_START.filter((option) => {
      if (!quickStartMatchesFilter(option, activityFilter)) return false;
      if (terms.length === 0) return true;
      const haystack = quickStartSearchText(option);
      return terms.every(term => haystack.includes(term));
    });
  }, [activityFilter, activitySearch]);
  const hasQuickStartFilters = activityFilter !== 'all' || activitySearch.trim().length > 0;

  const endWorkoutLiveActivity = useCallback(() => {
    liveActivityGenerationRef.current += 1;
    const id = liveActivityIdRef.current;
    liveActivityIdRef.current = null;
    if (id) endRestActivity(id).catch(() => undefined);
  }, []);

  // Tell the watch this phone-side session is over. Best-effort —
  // failures are non-fatal (the watch's auto-renew handler will
  // eventually surface today's plan workout instead). Only clears
  // the watch when the active session was actually phone-initiated;
  // for watch-initiated sessions the watch already drives its own
  // teardown via the end_workout / cancel_workout command path.
  const clearWatchSession = useCallback(async () => {
    const sid = watchSessionIdRef.current;
    watchSessionIdRef.current = null;
    if (!sid) return;
    if (sid.startsWith('watch-')) return;
    try { await clearWorkoutFromWatch(); } catch {}
  }, []);

  // Stop + tear down the GPS tracker. Best-effort — failures are
  // non-fatal because the tracker auto-stops when the watcher is
  // garbage collected anyway. Clears local state so the next session
  // starts from zero.
  const stopGpsTracker = useCallback(async () => {
    const handle = cardioGpsHandleRef.current;
    cardioGpsHandleRef.current = null;
    if (handle) { try { await handle.stop(); } catch {} }
    setGpsDistanceMeters(0);
    setGpsPaceSecPerKm(null);
    setGpsCoords([]);
    setGpsCurrent(null);
    lastGpsRouteLenRef.current = 0;
  }, []);

  const reset = useCallback(() => {
    endWorkoutLiveActivity();
    void clearWatchSession();
    setPhase('pick');
    setChoice(null);
    setStartedAtMs(null);
    setPausedAccum(0);
    setPauseStartMs(null);
    setElapsedSec(0);
    setHr(null);
    setHrSum(0);
    setHrN(0);
    setPrefill(null);
    setLogModalVisible(false);
    setActivitySearch('');
    setActivityFilter('all');
    clearManagedInterval(timerRef);
    clearManagedInterval(hrIntervalRef);
    void stopGpsTracker();
  }, [endWorkoutLiveActivity, clearWatchSession, stopGpsTracker]);

  useEffect(() => {
    if (!visible || !authToken || !enableHealthKit) {
      setHrZones([]);
      return;
    }
    let cancelled = false;
    readHealthSummary()
      .then((hs: any) => getHRZones(authToken, hs?.restingHeartRate, hs?.vo2Max))
      .catch(() => getHRZones(authToken))
      .then(r => { if (!cancelled) setHrZones(r.zones ?? []); })
      .catch(() => { if (!cancelled) setHrZones([]); });
    return () => { cancelled = true; };
  }, [authToken, enableHealthKit, visible]);

  // On close from outside (e.g. swipe down without saving) clean up
  // the timers so they don't leak into the next open.
  useEffect(() => {
    if (!visible) {
      autoStartKeyRef.current = null;
      reset();
    }
    return () => {
      clearManagedInterval(timerRef);
      clearManagedInterval(hrIntervalRef);
      endWorkoutLiveActivity();
    };
  }, [visible, reset, endWorkoutLiveActivity]);

  // GPS tracker lifecycle — fires once when the user actually starts
  // an outdoor cardio session. We DON'T re-create the tracker on every
  // pause/resume; pause/resume just toggle the handle's accumulator
  // so distance freezes during pause but the watcher stays warm.
  useEffect(() => {
    if (phase !== 'running' || !isOutdoorCardio || !choice) return;
    if (cardioGpsHandleRef.current) return;     // already started
    let cancelled = false;
    (async () => {
      try {
        const { activityFromFocus, isOutdoorCardio: isOutdoor, startCardioGpsTracker } =
          await import('../utils/cardioGpsTracker');
        const activity = activityFromFocus(choice.label);
        if (!isOutdoor(activity)) return;
        const handle = await startCardioGpsTracker({
          activity,
          onSample: (s) => {
            if (cancelled) return;
            setGpsDistanceMeters(s.distanceMeters);
            setGpsPaceSecPerKm(s.paceSecPerKm);
            if (s.lastCoord) setGpsCurrent(s.lastCoord);
            // Re-snapshot the polyline only when a new point landed.
            const liveHandle = cardioGpsHandleRef.current;
            if (liveHandle) {
              const route = liveHandle.getRouteCoords();
              if (route.length !== lastGpsRouteLenRef.current) {
                lastGpsRouteLenRef.current = route.length;
                setGpsCoords(route.map(c => ({ lat: c.lat, lon: c.lon })));
              }
            }
          },
          onPermissionDenied: () => {
            if (cancelled) return;
            Alert.alert(
              'Location off',
              'Live distance + pace need location access. Enable it in Settings → Thallo to track outdoor cardio. Your workout will still log without GPS.',
            );
          },
          onError: (msg) => console.warn('[liveTracker] GPS error:', msg),
        });
        if (cancelled) {
          try { await handle?.stop(); } catch {}
          return;
        }
        cardioGpsHandleRef.current = handle;
      } catch (e: any) {
        console.warn('[liveTracker] GPS start failed:', e?.message ?? e);
      }
    })();
    return () => { cancelled = true; };
    // The tracker should outlast pause/resume, so phase isn't a dep —
    // we only care about the *transition* into running, captured by
    // the early-return above. Re-keying on choice handles "user
    // discarded and started a different activity" cleanly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, isOutdoorCardio, choice?.subtype]);

  // Pause / resume the GPS tracker alongside the timer so distance
  // and pace freeze when the user pauses, then resume cleanly without
  // counting walking-during-the-break as part of the run.
  useEffect(() => {
    const h = cardioGpsHandleRef.current;
    if (!h) return;
    if (phase === 'paused') h.pause();
    else if (phase === 'running') h.resume();
  }, [phase]);

  // Timer tick — runs while phase=running; pauses accumulate a static
  // offset that's subtracted from elapsed so the paused period doesn't
  // count toward workout time.
  const tickElapsed = useCallback(() => {
    if (!startedAtMs) return;
    const now = Date.now();
    const raw = Math.floor((now - startedAtMs) / 1000);
    setElapsedSec(Math.max(0, raw - pausedAccum));
  }, [pausedAccum, startedAtMs]);
  useManagedInterval(tickElapsed, 1000, phase === 'running' && !!startedAtMs, timerRef);

  // HR polling — only while running. Uses getLatestHeartRate which
  // hits HealthKit's latest sample. Sampling every 10s is plenty for
  // a display + a running-average calculation.
  const tickHeartRate = useCallback(async () => {
    try {
      const bpm = await getLatestHeartRate();
      if (bpm && bpm > 30 && bpm < 230) {
        setHr(bpm);
        setHrSum(prev => prev + bpm);
        setHrN(prev => prev + 1);
        if (liveActivityIdRef.current) {
          updateRestActivity(liveActivityIdRef.current, liveActivityHrZoneFields(bpm, hrZones)).catch(() => undefined);
        }
      }
    } catch { /* swallow — HR isn't required */ }
  }, [hrZones]);
  const shouldPollHr = phase === 'running' && canUseHealthKit;
  useEffect(() => {
    if (!shouldPollHr) return;
    tickHeartRate();
  }, [shouldPollHr, tickHeartRate]);
  useManagedInterval(tickHeartRate, 10_000, shouldPollHr, hrIntervalRef);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      if (phase === 'running' && startedAtMs) tickElapsed();
      if (shouldPollHr) tickHeartRate();
    });
    return () => sub.remove();
  }, [phase, shouldPollHr, startedAtMs, tickElapsed, tickHeartRate]);

  const handleStart = (c: LiveActivityQuickStartOption) => {
    import('../utils/feedback').then(f => f.hapticMedium()).catch(() => {});
    // Strength picks don't belong in the stopwatch path — they need
    // an exercise picker + per-set logging. Hand off to the parent's
    // active-workout flow with an empty shell labeled by the focus.
    if (c.category === 'strength' && onStartStrengthWorkout) {
      const focusLabel =
        c.subtype === 'lift'         ? 'Strength'
        : c.subtype === 'push'        ? 'Push'
        : c.subtype === 'pull'        ? 'Pull'
        : c.subtype === 'legs'        ? 'Legs'
        : c.subtype === 'upper'       ? 'Upper'
        : c.subtype === 'lower'       ? 'Lower'
        : c.subtype === 'full_body'   ? 'Full Body'
        : c.subtype === 'powerlifting' ? 'Powerlifting'
        : c.subtype === 'crossfit'    ? 'CrossFit'
        : c.label;
      onStartStrengthWorkout(focusLabel);
      reset();
      onClose();
      return;
    }
    if (c.category !== 'strength' && onStartCardioWorkout) {
      onStartCardioWorkout(c.label, c.subtype, c.category, c.cardioStyle, c.venue);
      reset();
      onClose();
      return;
    }
    const now = Date.now();
    setChoice(c);
    setStartedAtMs(now);
    setPhase('running');
    const generation = liveActivityGenerationRef.current + 1;
    liveActivityGenerationRef.current = generation;
    const workoutId = `live_${now}`;
    // Push the active session to the watch. Re-use the watch's own
    // sessionId when the start was originated from the wrist; otherwise
    // mint a `phone-` id so the watch's terminal-status guard knows
    // which session to honor for dismissal vs ignore.
    const watchSid = (typeof initialActivity?.sessionId === 'string' && initialActivity.sessionId.startsWith('watch-'))
      ? initialActivity.sessionId
      : `phone-${now}-${Math.random().toString(36).slice(2, 8)}`;
    watchSessionIdRef.current = watchSid;
    const syntheticDay: any = {
      day: new Date(now).toLocaleDateString('en-US', { weekday: 'long' }),
      focus: c.label,
      exercises: [],
      stimulus: c.category === 'cardio' || c.cardioStyle ? 'conditioning' : 'mixed',
      _source_context: c.category === 'cardio' || c.cardioStyle ? 'custom_cardio' : `custom_${c.category}`,
      _custom_activity_category: c.category,
      _custom_cardio_subtype: c.subtype,
      _custom_cardio_style: c.cardioStyle,
      _custom_activity_venue: c.venue ?? defaultVenueForActivity(c.category, c.subtype),
    };
    const pushToWatch = pushWorkoutToWatch(syntheticDay, {
      status: 'active',
      sessionId: watchSid,
      reason: 'start_echo',
    }).catch(() => false);
    if (!watchSid.startsWith('watch-')) {
      pushToWatch
        .then(() => WatchBridge.startWatchWorkout())
        .catch(() => false);
    }
    startRestActivity({
      mode: 'elapsed',
      workoutId,
      exerciseName: c.label,
      setNumber: 0,
      totalSets: 0,
      startedAtMs: now,
      durationSeconds: 0,
      endDateMs: now + 12 * 60 * 60 * 1000,
      nextSetRecommendation: 'Timer running',
      themeColorHex: tc.primary,
      paused: false,
      elapsedSeconds: 0,
      ...liveActivityHrZoneFields(hr, hrZones),
    }).then((id) => {
      if (!id) return;
      if (liveActivityGenerationRef.current !== generation) {
        endRestActivity(id).catch(() => undefined);
        return;
      }
      liveActivityIdRef.current = id;
    }).catch(() => undefined);
  };

  useEffect(() => {
    if (!visible || phase !== 'pick') return;
    const option = resolveLiveActivityQuickStart(initialActivity);
    if (!option) return;
    const key = liveActivityQuickStartKey(option);
    if (autoStartKeyRef.current === key) return;
    autoStartKeyRef.current = key;
    handleStart(option);
  }, [visible, phase, initialActivity?.category, initialActivity?.subtype, initialActivity?.label, initialActivity?.venue]);

  const handlePause = () => {
    import('../utils/feedback').then(f => f.hapticLight()).catch(() => {});
    const now = Date.now();
    const currentElapsed = startedAtMs
      ? Math.max(0, Math.floor((now - startedAtMs) / 1000) - pausedAccum)
      : elapsedSec;
    setElapsedSec(currentElapsed);
    setPauseStartMs(now);
    setPhase('paused');
    if (liveActivityIdRef.current) {
      updateRestActivity(liveActivityIdRef.current, {
        mode: 'elapsed',
        paused: true,
        elapsedSeconds: currentElapsed,
        nextSetRecommendation: 'Paused',
        ...liveActivityHrZoneFields(hr, hrZones),
      }).catch(() => undefined);
    }
  };

  const handleResume = () => {
    import('../utils/feedback').then(f => f.hapticLight()).catch(() => {});
    const resumedAt = Date.now();
    const currentElapsed = elapsedSec;
    if (pauseStartMs) {
      const paused = Math.floor((resumedAt - pauseStartMs) / 1000);
      setPausedAccum(prev => prev + paused);
      setPauseStartMs(null);
    }
    setPhase('running');
    if (liveActivityIdRef.current) {
      updateRestActivity(liveActivityIdRef.current, {
        mode: 'elapsed',
        paused: false,
        startedAtMs: resumedAt - currentElapsed * 1000,
        elapsedSeconds: currentElapsed,
        nextSetRecommendation: 'Timer running',
        ...liveActivityHrZoneFields(hr, hrZones),
      }).catch(() => undefined);
    }
  };

  const handleFinish = async () => {
    if (!choice || !startedAtMs) { reset(); onClose(); return; }
    import('../utils/feedback').then(f => f.hapticSuccess()).catch(() => {});
    // Snap a final elapsed before opening the log modal.
    const endedMs = phase === 'paused' && pauseStartMs
      ? pauseStartMs
      : Date.now();
    const finalSeconds = Math.max(1, Math.floor((endedMs - startedAtMs) / 1000) - pausedAccum);
    const fallbackAvgHr = hrN > 0 ? Math.round(hrSum / hrN) : null;
    endWorkoutLiveActivity();

    // Parity with AH imports: pull the authoritative HR + kcal
    // summary from HealthKit for the tracked window. HK records at
    // a higher sample rate than our 10s poll, and it also catches
    // any Apple Workout the user may have started in parallel (e.g.
    // Outdoor Run logged via the Watch's Workout app), whose calorie
    // model is better calibrated than anything we'd compute client-
    // side. Both calls are best-effort — null on failure, we still
    // save the session.
    let avgHr: number | null = fallbackAvgHr;
    let kcal: number | null = null;
    if (canUseHealthKit) {
      try {
        const hr = await getWorkoutHrSummary(startedAtMs, endedMs, null, null, hrZones).catch(() => null);
        if (hr?.avgBpm) avgHr = Math.round(hr.avgBpm);
      } catch { /* swallow — HK optional */ }
      try {
        const c = await getAppleWorkoutCaloriesForWindow(startedAtMs, endedMs).catch(() => null);
        if (c && typeof c === 'number') kcal = Math.round(c);
      } catch { /* swallow */ }
    }

    // Snapshot GPS state BEFORE stopping the tracker — stop clears
    // gpsCoords / gpsDistanceMeters async via the reset path, and the
    // prefill needs the final values.
    const capturedRoute = cardioGpsHandleRef.current?.getRouteCoords() ?? [];
    const capturedElevationGainFt = estimateRouteElevationGainFt(capturedRoute);
    const capturedDistanceMi = isOutdoorCardio && gpsDistanceMeters > 0
      ? Math.round(((gpsDistanceMeters / 1000) * MI_PER_KM) * 100) / 100
      : null;
    if (isOutdoorCardio) {
      // Stop GPS now so we don't keep watching position while the
      // user is on the log/save modal.
      void stopGpsTracker();
    }

    setPrefill({
      // Namespacing the id with `live_` lets the save path tag the
      // session as `source: 'live_tracker'` for analytics, and keeps
      // it distinct from manual-retro and HK-import sessions.
      externalId: `live_${startedAtMs}`,
      dateISO: new Date(startedAtMs).toISOString(),
      startedAtISO: new Date(startedAtMs).toISOString(),
      endedAtISO: new Date(endedMs).toISOString(),
      durationMin: Math.max(1, Math.round(finalSeconds / 60)),
      category: choice.category,
      subtype: choice.subtype,
      cardioStyle: choice.cardioStyle,
      ...(choice.venue ? { indoorOutdoor: choice.venue } : {}),
      avgHeartRate: avgHr,
      caloriesBurned: kcal,
      // Pre-fill distance from GPS so the user doesn't have to type
      // it on the save form. They can override if they want.
      ...(capturedDistanceMi != null ? { distanceMiles: capturedDistanceMi } : {}),
      ...(capturedElevationGainFt != null ? { elevationGainFt: capturedElevationGainFt } : {}),
      ...(capturedRoute.length > 0 ? { routeCoords: capturedRoute } : {}),
    });
    setPhase('finishing');
    setLogModalVisible(true);
  };

  // Watch-initiated finish. The watch sends `end_workout` when the user
  // taps End on their wrist; HomeScreen bumps `finishSignal` and we run
  // the same flow as the in-modal Finish button so the cardio session
  // actually reaches `/workouts/complete` instead of being silently
  // dismissed. Guard against the initial 0 and against re-firing when
  // we're already in 'finishing' (LogActivityModal is up).
  const handleFinishRef = useRef(handleFinish);
  useEffect(() => { handleFinishRef.current = handleFinish; });
  const lastFinishSignalRef = useRef(finishSignal);
  useEffect(() => {
    if (finishSignal === lastFinishSignalRef.current) return;
    lastFinishSignalRef.current = finishSignal;
    if (finishSignal <= 0) return;
    if (phase !== 'running' && phase !== 'paused') return;
    handleFinishRef.current();
  }, [finishSignal, phase]);

  const handleDiscard = () => {
    Alert.alert(
      'Discard workout?',
      'The timer + HR you recorded will be thrown away. This can\'t be undone.',
      [
        { text: 'Keep going', style: 'cancel' },
        {
          text: 'Discard',
          style: 'destructive',
          onPress: () => { reset(); onClose(); },
        },
      ],
    );
  };

  const handleSaveConfirmed = async (session: WorkoutSession) => {
    if (onSave) {
      await onSave(session);
    } else {
      await saveWorkoutSession(session);
    }
    reset();
    onClose();
    onSaved?.();
  };

  return (
    <>
      <Modal visible={visible && phase !== 'finishing'} animationType="slide" onRequestClose={onClose}>
        <View style={[styles.root, { backgroundColor: tc.background }]}>
          {phase === 'pick' ? (
            <>
              <View style={[styles.header, { borderBottomColor: tc.border, paddingTop: insets.top + 6 }]}>
                <TouchableOpacity
                  testID="live-tracker-close"
                  accessibilityLabel="live-tracker-close"
                  onPress={onClose}
                  style={styles.headerBtn}
                  hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
                  <Ionicons name="close" size={26} color={tc.textPrimary} />
                </TouchableOpacity>
                <Text style={[styles.headerTitle, { color: tc.textPrimary }]}>Custom Workout</Text>
                <View style={styles.headerBtn} />
              </View>
              <Text style={{ fontSize: 12, color: tc.textMuted, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4 }}>
                {canUseHealthKit
                  ? "Pick a type. We'll time it and use Apple Health heart-rate samples when available."
                  : "Pick a type. We'll time it and save the activity to your log."}
              </Text>
              <View style={styles.quickControls}>
                <View style={[styles.quickSearchBox, { backgroundColor: tc.surface, borderColor: tc.border }]}>
                  <Ionicons name="search" size={16} color={tc.textMuted} />
                  <TextInput
                    testID="live-quickstart-search"
                    accessibilityLabel="Search start activities"
                    value={activitySearch}
                    onChangeText={setActivitySearch}
                    placeholder="Search activities"
                    placeholderTextColor={tc.textMuted}
                    autoCapitalize="none"
                    autoCorrect={false}
                    returnKeyType="search"
                    style={[styles.quickSearchInput, { color: tc.textPrimary }]}
                  />
                  {activitySearch.length > 0 && (
                    <TouchableOpacity
                      accessibilityLabel="Clear activity search"
                      onPress={() => setActivitySearch('')}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                      <Ionicons name="close-circle" size={18} color={tc.textMuted} />
                    </TouchableOpacity>
                  )}
                </View>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.quickFilterScroller}>
                  {QUICK_START_FILTERS.map(filter => {
                    const active = activityFilter === filter.key;
                    return (
                      <TouchableOpacity
                        key={filter.key}
                        testID={`live-quickstart-filter-${filter.key}`}
                        accessibilityRole="button"
                        accessibilityState={{ selected: active }}
                        accessibilityLabel={`Filter start activities by ${filter.label}`}
                        onPress={() => setActivityFilter(active ? 'all' : filter.key)}
                        style={[
                          styles.quickFilterChip,
                          {
                            backgroundColor: active ? tc.primary + '18' : tc.surface,
                            borderColor: active ? tc.primary : tc.border,
                          },
                        ]}>
                        <Ionicons name={filter.icon as any} size={13} color={active ? tc.primary : tc.textMuted} />
                        <Text style={[styles.quickFilterText, { color: active ? tc.primary : tc.textSecondary }]}>
                          {filter.label}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>
              </View>
              <ScrollView contentContainerStyle={styles.quickGrid} showsVerticalScrollIndicator={false}>
                {filteredQuickStartOptions.length === 0 ? (
                  <View style={[styles.quickEmptyState, { borderColor: tc.border, backgroundColor: tc.surface }]}>
                    <Ionicons name="search" size={28} color={tc.textMuted} />
                    <Text style={[styles.quickEmptyTitle, { color: tc.textPrimary }]}>No matches</Text>
                    <Text style={[styles.quickEmptyBody, { color: tc.textMuted }]}>
                      Try a different activity name or clear the filter.
                    </Text>
                    {hasQuickStartFilters && (
                      <TouchableOpacity
                        accessibilityRole="button"
                        accessibilityLabel="Clear start activity filters"
                        onPress={() => {
                          setActivitySearch('');
                          setActivityFilter('all');
                        }}
                        style={[styles.quickEmptyClear, { borderColor: tc.primary + '66', backgroundColor: tc.primary + '12' }]}>
                        <Text style={[styles.quickEmptyClearText, { color: tc.primary }]}>Clear</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                ) : filteredQuickStartOptions.map((c) => {
                  const quickKey = liveActivityQuickStartKey(c);
                  const testKey = quickKey.replace(/:/g, '-');
                  return (
                    <TouchableOpacity
                      key={quickKey}
                      testID={`live-quickstart-${testKey}`}
                      accessibilityLabel={`live-quickstart-${testKey}`}
                      onPress={() => handleStart(c)}
                      activeOpacity={0.78}
                      style={[styles.quickCard, { borderColor: tc.border }]}>
                      <ImageBackground
                        source={QUICK_START_IMAGES[quickKey] ?? QUICK_START_FALLBACK_IMAGE}
                        style={styles.quickImage}
                        imageStyle={styles.quickImageStyle}
                        resizeMode="cover">
                        <View style={styles.quickImageOverlay} />
                        <View style={styles.quickCardTop}>
                          <View style={styles.quickIconBubble}>
                            <Ionicons name={c.icon as any} size={19} color="#fff" />
                          </View>
                          <Ionicons name="play-circle" size={22} color="#fff" />
                        </View>
                        <View style={styles.quickCardBottom}>
                          <Text
                            style={styles.quickLabel}
                            numberOfLines={1}
                            adjustsFontSizeToFit
                            minimumFontScale={0.82}>
                            {c.label}
                          </Text>
                        </View>
                      </ImageBackground>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            </>
          ) : (
            <View style={{ flex: 1, padding: 20, paddingTop: insets.top + 12, justifyContent: 'space-between' }}>
              <View>
                <Text style={{ fontSize: 12, color: tc.textMuted, letterSpacing: 1.4, fontWeight: '700' }}>
                  {choice?.label.toUpperCase()}
                </Text>
                {/* Live route map for outdoor cardio. Renders above the
                    timer so the user sees their path drawing as they go.
                    Hidden for indoor / strength / sport / mobility. */}
                {isOutdoorCardio && (
                  <View style={{ marginTop: 12, marginHorizontal: -8 }}>
                    <LiveCardioMap
                      themeName={themeName}
                      coords={gpsCoords}
                      current={gpsCurrent}
                      height={170}
                    />
                  </View>
                )}
                <Text style={{
                  fontSize: isOutdoorCardio ? 60 : 84,
                  fontWeight: '900', color: tc.textPrimary,
                  marginTop: isOutdoorCardio ? 12 : 6,
                  letterSpacing: -3, fontVariant: ['tabular-nums'],
                }}>
                  {fmtElapsed(elapsedSec)}
                </Text>
                {phase === 'paused' && (
                  <Text style={{ fontSize: 12, fontWeight: '800', color: tc.warning, letterSpacing: 1.2 }}>
                    PAUSED
                  </Text>
                )}
                <View style={{ flexDirection: 'row', gap: 20, marginTop: 28 }}>
                  {/* Distance + Pace columns — only for outdoor cardio
                      where GPS gives them. Indoor cardio + lifting hide
                      these to avoid showing "—" placeholders. */}
                  {isOutdoorCardio && (
                    <>
                      <View>
                        <Text style={{ fontSize: 10, color: tc.textMuted, fontWeight: '700', letterSpacing: 1 }}>
                          DISTANCE
                        </Text>
                        <Text style={{
                          fontSize: 28, fontWeight: '900',
                          color: gpsDistanceMeters > 0 ? tc.textPrimary : tc.textMuted,
                          marginTop: 4, fontVariant: ['tabular-nums'],
                        }}>
                          {fmtDistanceMi(gpsDistanceMeters)}
                        </Text>
                        <Text style={{ fontSize: 10, color: tc.textMuted }}>mi</Text>
                      </View>
                      <View>
                        <Text style={{ fontSize: 10, color: tc.textMuted, fontWeight: '700', letterSpacing: 1 }}>
                          PACE
                        </Text>
                        <Text style={{
                          fontSize: 28, fontWeight: '900',
                          color: gpsPaceSecPerKm != null ? tc.textPrimary : tc.textMuted,
                          marginTop: 4, fontVariant: ['tabular-nums'],
                        }}>
                          {fmtPaceSecPerMi(gpsPaceSecPerKm)}
                        </Text>
                        <Text style={{ fontSize: 10, color: tc.textMuted }}>/mi</Text>
                      </View>
                    </>
                  )}
                  <View>
                    <Text style={{ fontSize: 10, color: tc.textMuted, fontWeight: '700', letterSpacing: 1 }}>
                      HEART RATE
                    </Text>
                    <Text style={{ fontSize: 28, fontWeight: '900', color: hr != null && hr > 0 ? liveZoneColor : tc.error, marginTop: 4 }}>
                      {hr != null ? `${hr}` : '—'}
                    </Text>
                    <Text style={{ fontSize: 10, color: tc.textMuted }}>
                      {hrN > 0 ? `avg ${Math.round(hrSum / hrN)} bpm` : 'bpm'}
                    </Text>
                    {hr != null && hr > 0 ? (
                      <View style={{
                        flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 8,
                        alignSelf: 'flex-start', borderRadius: 999, borderWidth: 1,
                        borderColor: liveZoneColor + '66', backgroundColor: liveZoneColor + '18',
                        paddingHorizontal: 9, paddingVertical: 5,
                      }}>
                        <Text style={{ fontSize: 11, fontWeight: '900', color: liveZoneColor }}>
                          {liveZone ? `Z${liveZone.zone}` : 'HR'}
                        </Text>
                        <Text style={{ fontSize: 10, fontWeight: '700', color: tc.textMuted }}>
                          {liveZone ? hrZoneRangeText(liveZone) : 'live'}
                        </Text>
                      </View>
                    ) : null}
                  </View>
                </View>
              </View>
              <View style={{ gap: 10 }}>
                {phase === 'running' ? (
                  <TouchableOpacity
                    testID="live-pause"
                    accessibilityLabel="live-pause"
                    onPress={handlePause}
                    style={{
                      paddingVertical: 16, borderRadius: 14,
                      backgroundColor: tc.surface, borderWidth: 1, borderColor: tc.border,
                      alignItems: 'center',
                    }}>
                    <Text style={{ fontSize: 15, fontWeight: '800', color: tc.textSecondary }}>Pause</Text>
                  </TouchableOpacity>
                ) : (
                  <TouchableOpacity
                    testID="live-resume"
                    accessibilityLabel="live-resume"
                    onPress={handleResume}
                    style={{
                      paddingVertical: 16, borderRadius: 14,
                      backgroundColor: tc.primary,
                      alignItems: 'center',
                    }}>
                    <Text style={{ fontSize: 15, fontWeight: '800', color: tc.background }}>Resume</Text>
                  </TouchableOpacity>
                )}
                <TouchableOpacity
                  testID="live-finish"
                  accessibilityLabel="live-finish"
                  onPress={handleFinish}
                  style={{
                    paddingVertical: 16, borderRadius: 14,
                    backgroundColor: tc.success,
                    alignItems: 'center',
                  }}>
                  <Text style={{ fontSize: 15, fontWeight: '800', color: '#fff' }}>Finish</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  testID="live-discard"
                  accessibilityLabel="live-discard"
                  onPress={handleDiscard}
                  style={{
                    paddingVertical: 12, alignItems: 'center',
                  }}>
                  <Text style={{ fontSize: 12, fontWeight: '700', color: tc.textMuted }}>Discard</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
        </View>
      </Modal>

      <LogActivityModal
        visible={logModalVisible}
        onClose={() => {
          // User bailed on saving the finished workout. Reset so the
          // tracker starts clean next open. We deliberately don't
          // persist a silent save here — if the user dismisses the
          // confirm step we trust that they didn't want the workout.
          setLogModalVisible(false);
          reset();
          onClose();
        }}
        onSave={handleSaveConfirmed}
        themeName={themeName}
        prefill={prefill}
      />
    </>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 10, paddingVertical: 10,
    borderBottomWidth: 1,
  },
  headerBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: 16, fontWeight: '800' },
  quickControls: {
    paddingHorizontal: 16,
    paddingTop: 8,
    gap: 8,
  },
  quickSearchBox: {
    minHeight: 42,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 11,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  quickSearchInput: {
    flex: 1,
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0,
    paddingVertical: 9,
  },
  quickFilterScroller: {
    gap: 8,
    paddingRight: 16,
  },
  quickFilterChip: {
    minHeight: 32,
    borderRadius: radius.full,
    borderWidth: 1,
    paddingHorizontal: 11,
    paddingVertical: 7,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  quickFilterText: {
    fontSize: 11,
    fontWeight: '800',
  },
  quickGrid: {
    padding: 16,
    paddingBottom: 28,
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    gap: 10,
  },
  quickCard: {
    width: '48%',
    minHeight: 124,
    borderRadius: radius.lg,
    borderWidth: 1,
    overflow: 'hidden',
    backgroundColor: '#111827',
  },
  quickEmptyState: {
    width: '100%',
    minHeight: 180,
    borderRadius: 14,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 22,
    gap: 8,
  },
  quickEmptyTitle: {
    fontSize: 15,
    fontWeight: '900',
  },
  quickEmptyBody: {
    maxWidth: 240,
    textAlign: 'center',
    fontSize: 12,
    lineHeight: 17,
    fontWeight: '600',
  },
  quickEmptyClear: {
    marginTop: 4,
    borderRadius: radius.full,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  quickEmptyClearText: {
    fontSize: 12,
    fontWeight: '900',
  },
  quickImage: { minHeight: 124, justifyContent: 'space-between' },
  quickImageStyle: { borderRadius: radius.lg },
  quickImageOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.42)' },
  quickCardTop: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    padding: 10,
  },
  quickIconBubble: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.18)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.24)',
  },
  quickCardBottom: { paddingHorizontal: 12, paddingBottom: 12 },
  quickLabel: { fontSize: 15, fontWeight: '900', color: '#fff' },
});
