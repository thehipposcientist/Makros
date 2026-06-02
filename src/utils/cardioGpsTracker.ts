/**
 * iPhone-side live GPS tracker for outdoor cardio sessions.
 *
 * When the user starts a cardio workout AND no Apple Watch is paired or
 * reachable, this tracker takes over the role the watch would normally
 * play: streams live distance, pace, and elapsed time into the same
 * `liveCardio` state shape that the watch's `cardio_metrics` command
 * feeds into. The phone's cardio metrics row reads from that state and
 * has no idea where the data came from.
 *
 * Architecture:
 *   • `expo-location.watchPositionAsync` with `BestForNavigation` accuracy
 *     gives us ~5m resolution updates roughly every 1-2 seconds while
 *     the user is moving.
 *   • Distance accumulates from haversine deltas between samples, with
 *     activity-specific floors so slow walks don't get undercounted.
 *   • Pace = total elapsed seconds / total distance km.
 *   • Background updates require `UIBackgroundModes` includes "location"
 *     and the user grants "Always" or "While Using". The expo-location
 *     plugin in app.json sets both up.
 *
 * Indoor cardio (treadmill / stationary bike) is NOT a fit for GPS — for
 * those activities the user logs distance manually post-workout, same
 * as the watch's `ManualDistanceSheet` flow. The tracker auto-skips
 * starting for indoor activity types.
 */

// Lazy type — `expo-location` is dynamically imported at runtime so
// the module can be added to the JS build without breaking type-check
// before the native build is rebuilt. Once expo-location ships in the
// native bundle, TypeScript will resolve the real type from the
// dynamic `import('expo-location')` below.
type ActivityType = number;

export type CardioGpsActivityType =
  | 'running'
  | 'walking'
  | 'cycling'
  | 'hiking'
  | 'unknown';

export interface RouteCoord {
  /** WGS84 latitude. */
  lat: number;
  /** WGS84 longitude. */
  lon: number;
  /** epoch-ms when the sample was captured. Lets the playback /
   *  post-workout map reconstruct exact pacing per segment. */
  t_ms: number;
  /** Reported horizontal accuracy in meters at this sample, or null. */
  acc_m?: number | null;
  /** Reported altitude above sea level in meters, when the OS has it. */
  alt_m?: number | null;
  /** Reported vertical accuracy in meters, or null when unavailable. */
  v_acc_m?: number | null;
}

export interface CardioGpsSample {
  /** Cumulative distance in meters since `start()` was called. */
  distanceMeters: number;
  /** Total elapsed seconds since start. Pause-aware. */
  elapsedSeconds: number;
  /** Average pace in seconds per kilometer. Null until ≥30 m logged. */
  paceSecPerKm: number | null;
  /** Current smoothed pace in seconds per kilometer from the OS speed
   *  estimate. Useful for live displays; final pace should still use
   *  total elapsed / total distance. */
  currentPaceSecPerKm: number | null;
  /** Current speed estimate from CoreLocation, in meters per second. */
  speedMps: number | null;
  /** Cumulative climb from accepted altitude samples. */
  elevationGainFt: number | null;
  /** Last known accuracy in meters; useful for the UI to dim metrics
   *  when accuracy is poor (e.g. urban canyons, indoors). */
  lastAccuracyM: number | null;
  /** True when expo-location currently has a fix. False before the
   *  first sample arrives or after a long gap. */
  hasFix: boolean;
  /** Most recent {lat, lon} so a live map camera can follow the user
   *  without iterating the full coords array on every frame. */
  lastCoord: { lat: number; lon: number } | null;
}

export interface CardioGpsHandle {
  /** Stop watching position and finalize state. The last sample is
   *  returned so the caller can persist a final number to backend /
   *  Apple Health. Safe to call multiple times. */
  stop(): Promise<CardioGpsSample>;
  /** Pause accumulation without stopping the watcher. Distance won't
   *  increase but the watcher keeps a fix so resume is instant. */
  pause(): void;
  /** Resume accumulation after pause. */
  resume(): void;
  /** Snapshot the current state synchronously. */
  snapshot(): CardioGpsSample;
  /** The full route trail captured so far. Returns a copy so callers
   *  can safely freeze it into immutable state. Used for the live map
   *  polyline + the persisted `route_coords` payload at workout end. */
  getRouteCoords(): RouteCoord[];
}

export interface StartCardioGpsOptions {
  activity: CardioGpsActivityType;
  /** Called every time we have a new sample. Throttled to ≥1 second
   *  apart so React state writes don't thrash. */
  onSample: (sample: CardioGpsSample) => void;
  /** Called once if the user denies / has-denied location permission.
   *  The tracker won't retry — the caller is responsible for surfacing
   *  the UI affordance to send the user to Settings. */
  onPermissionDenied?: () => void;
  /** Called if the watcher errors out mid-session (rare but possible
   *  on iOS — battery saver throttling, airplane mode, etc.). */
  onError?: (message: string) => void;
}

/** True for activity types where the iPhone GPS can give meaningful
 *  distance. Indoor cardio (rower, stationary bike, elliptical) gets a
 *  different UX (manual distance entry, post-workout). */
export function isOutdoorCardio(activity: CardioGpsActivityType): boolean {
  return activity === 'running' || activity === 'walking'
    || activity === 'cycling' || activity === 'hiking';
}

/** Map a workout focus string to the GPS-tracker's activity bucket.
 *  Mirrors the watch's HeartRateStore.resolveActivity but returns the
 *  smaller set we care about for GPS purposes. Uses substring matching
 *  to handle both display names ("Run", "Outdoor Cycling") and slug
 *  forms ("outdoor_run", "bike_outdoor"). */
export function activityFromFocus(focus: string | null | undefined): CardioGpsActivityType {
  const s = (focus ?? '').toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return 'unknown';
  if (/\b(treadmill|indoor|stationary|spin|peloton|assault|fan bike|airbike|row(?:er|ing)?|elliptical|stair|skierg|ski erg|versa climber|versaclimber)\b/.test(s)) return 'unknown';
  if (
    /\b(walk(?:ing)?|run(?:ning)?|jog(?:ging)?)\b/.test(s)
    && /\b(lunges?|farmer's|farmers?|carries|carry|suitcase|overhead|dumbbell|kettlebell|barbell|band(?:ed)?|lateral|monster|wall|inchworm|walkouts?|bear|duck|sled)\b/.test(s)
  ) {
    return 'unknown';
  }
  if (/\b(run(?:ning)?|jog(?:ging)?)\b/.test(s)) return 'running';
  if (/\bwalk(?:ing)?\b/.test(s)) return 'walking';
  if (/\bhik(?:e|ing)\b/.test(s)) return 'hiking';
  if (/\b(bike|biking|bicycle|cycl(?:e|ing)|ride)\b/.test(s)) return 'cycling';
  return 'unknown';
}

const HAVERSINE_R_M = 6_371_000;
function haversineMeters(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const aHav = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
  const c = 2 * Math.atan2(Math.sqrt(aHav), Math.sqrt(1 - aHav));
  return HAVERSINE_R_M * c;
}

const ACTIVITY_GPS_FILTERS: Record<CardioGpsActivityType, {
  minDeltaMeters: number;
  maxAccuracyMeters: number;
  movingSpeedMps: number;
  maxSpeedMps: number;
}> = {
  walking: { minDeltaMeters: 1.2, maxAccuracyMeters: 45, movingSpeedMps: 0.35, maxSpeedMps: 3.5 },
  hiking: { minDeltaMeters: 1.5, maxAccuracyMeters: 55, movingSpeedMps: 0.30, maxSpeedMps: 3.8 },
  running: { minDeltaMeters: 1.8, maxAccuracyMeters: 50, movingSpeedMps: 0.70, maxSpeedMps: 8.5 },
  cycling: { minDeltaMeters: 3.0, maxAccuracyMeters: 75, movingSpeedMps: 1.20, maxSpeedMps: 22.0 },
  unknown: { minDeltaMeters: 2.5, maxAccuracyMeters: 60, movingSpeedMps: 0.50, maxSpeedMps: 10.0 },
};
const FALLBACK_MAX_DELTA_METERS = 200;
const MIN_ELEVATION_DELTA_METERS = 1.5;
const MAX_VERTICAL_ACCURACY_METERS = 30;
const METERS_TO_FEET = 3.280839895;

export function estimateRouteElevationGainFt(coords: ReadonlyArray<RouteCoord> | null | undefined): number | null {
  if (!coords || coords.length < 2) return null;
  let gainMeters = 0;
  let lastAlt: number | null = null;
  for (const c of coords) {
    const alt = typeof c.alt_m === 'number' && Number.isFinite(c.alt_m) ? c.alt_m : null;
    if (alt == null) continue;
    const vAcc = typeof c.v_acc_m === 'number' && Number.isFinite(c.v_acc_m) ? c.v_acc_m : null;
    if (vAcc != null && vAcc > MAX_VERTICAL_ACCURACY_METERS) continue;
    if (lastAlt != null) {
      const delta = alt - lastAlt;
      if (delta >= MIN_ELEVATION_DELTA_METERS) gainMeters += delta;
    }
    lastAlt = alt;
  }
  if (gainMeters <= 0) return null;
  return Math.round(gainMeters * METERS_TO_FEET);
}

/** Map our activity bucket to expo-location's ActivityType so iOS can
 *  optimize battery and re-entry behavior for the right motion type. */
function activityTypeForExpo(activity: CardioGpsActivityType): ActivityType | undefined {
  // expo-location's ActivityType: Other | AutomotiveNavigation | Fitness | OtherNavigation | Airborne
  // Cardio fits "Fitness" for all our outdoor types.
  if (isOutdoorCardio(activity)) {
    // Numeric enum value 4 = Fitness — kept as-is so we don't need to
    // import the enum at the top level (avoids a hard dep on
    // expo-location resolving at import time even when GPS is
    // unavailable).
    return 4 as ActivityType;
  }
  return undefined;
}

/** Start the GPS tracker. Throws synchronously if `expo-location` isn't
 *  installed (caller should check for that and fall back to a "GPS
 *  not available — install update" message). */
export async function startCardioGpsTracker(
  opts: StartCardioGpsOptions,
): Promise<CardioGpsHandle | null> {
  if (!isOutdoorCardio(opts.activity)) {
    // No-op for indoor activities — caller should not invoke for them
    // but we defend anyway so a misrouted call doesn't burn battery
    // running GPS for a stationary bike workout.
    return null;
  }

  // Dynamic import keeps the dependency optional at type-check time.
  // The runtime require resolves once expo-location is installed via
  // `npm install` + a fresh native build (added to package.json + the
  // expo-location plugin to app.json).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Location: any;
  try {
    Location = await import('expo-location' as any);
  } catch {
    opts.onError?.('expo-location not installed in this build.');
    return null;
  }

  // Foreground permission first — required for everything. Background
  // is requested only after foreground is granted (iOS rejects the
  // background request if foreground hasn't been granted first).
  const fg = await Location.requestForegroundPermissionsAsync();
  if (fg.status !== 'granted') {
    opts.onPermissionDenied?.();
    return null;
  }
  // Background isn't strictly required to track during a foregrounded
  // workout, but we request it so users who lock their phone mid-run
  // don't lose data. Denial is non-fatal — foreground tracking still
  // works as long as the screen stays on.
  try { await Location.requestBackgroundPermissionsAsync(); } catch {}

  const startedAtMs = Date.now();
  let lastSamplePos: { lat: number; lon: number } | null = null;
  let lastSampleAtMs = startedAtMs;
  let lastAcceptedAltitudeM: number | null = null;
  let totalDistanceMeters = 0;
  let totalElevationGainMeters = 0;
  let lastAccuracyM: number | null = null;
  let lastSpeedMps: number | null = null;
  let hasFix = false;
  let paused = false;
  let pausedAtMs = 0;
  let totalPausedMs = 0;
  let lastEmitMs = 0;
  let stopped = false;
  let subscription: { remove: () => void } | null = null;
  // Captured route trail. Each accepted sample (i.e. one that passed
  // the noise / teleport filters and was added to totalDistanceMeters)
  // also gets appended here. Capped at 12_000 entries (~3.3 hours @
  // 1Hz) so a marathon-length session can't blow up memory.
  const ROUTE_CAP = 12_000;
  const route: RouteCoord[] = [];

  const computeElapsedSeconds = (): number => {
    const now = Date.now();
    const live = paused ? pausedAtMs : now;
    return Math.max(0, Math.round((live - startedAtMs - totalPausedMs) / 1000));
  };

  const snapshot = (): CardioGpsSample => {
    const elapsedSeconds = computeElapsedSeconds();
    const paceSecPerKm = totalDistanceMeters >= 30 && elapsedSeconds > 0
      ? elapsedSeconds / (totalDistanceMeters / 1000)
      : null;
    const currentPaceSecPerKm = lastSpeedMps != null && lastSpeedMps > 0.2
      ? 1000 / lastSpeedMps
      : null;
    return {
      distanceMeters: totalDistanceMeters,
      elapsedSeconds,
      paceSecPerKm,
      currentPaceSecPerKm,
      speedMps: lastSpeedMps,
      elevationGainFt: totalElevationGainMeters > 0
        ? Math.round(totalElevationGainMeters * METERS_TO_FEET)
        : null,
      lastAccuracyM,
      hasFix,
      lastCoord: lastSamplePos ? { ...lastSamplePos } : null,
    };
  };

  // Throttle emits to ≥1s apart so React state churn is bounded.
  const emit = () => {
    const now = Date.now();
    if (now - lastEmitMs < 1000 && !stopped) return;
    lastEmitMs = now;
    opts.onSample(snapshot());
  };

  // 1Hz pulse so the UI's elapsed seconds tick even when no location
  // sample has arrived in the last second (e.g. user paused at a red
  // light, GPS sample frequency drops).
  const pulse = setInterval(() => {
    if (stopped) return;
    if (paused) return;
    emit();
  }, 1000);

  try {
    subscription = await Location.watchPositionAsync(
      {
        accuracy: Location.LocationAccuracy.BestForNavigation,
        timeInterval: 1_000,
        distanceInterval: 0,
        // Drives iOS power management — Fitness lets the OS keep GPS
        // active during the workout but ramp down when stationary.
        activityType: activityTypeForExpo(opts.activity),
        // Without this, `pausesUpdatesAutomatically` on iOS may pause
        // the watcher when the user stops moving (red lights, water
        // breaks) and then never auto-resume reliably. Disabling forces
        // continuous updates — costs ~5% extra battery vs auto-pause.
        pausesUpdatesAutomatically: false,
        // Show the iOS blue location pill while in background to reassure
        // the user GPS is on. Required for App Store review of bg location.
        showsBackgroundLocationIndicator: true,
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (loc: any) => {
        if (stopped) return;
        hasFix = true;
        const filters = ACTIVITY_GPS_FILTERS[opts.activity] ?? ACTIVITY_GPS_FILTERS.unknown;
        const acc = loc.coords.accuracy;
        lastAccuracyM = typeof acc === 'number' && Number.isFinite(acc) && acc >= 0 ? acc : null;
        const speed = loc.coords.speed;
        lastSpeedMps = typeof speed === 'number' && Number.isFinite(speed) && speed >= 0
          ? speed
          : null;
        if (paused) {
          // Still update accuracy + fix-state so resume is responsive,
          // but do NOT extend the distance — pause means "freeze
          // metrics."
          return;
        }
        const next = { lat: loc.coords.latitude, lon: loc.coords.longitude };
        const alt = typeof loc.coords.altitude === 'number' && Number.isFinite(loc.coords.altitude)
          ? loc.coords.altitude
          : null;
        const vAcc = typeof loc.coords.altitudeAccuracy === 'number' && Number.isFinite(loc.coords.altitudeAccuracy)
          ? loc.coords.altitudeAccuracy
          : null;
        const sampleAtMs = typeof loc.timestamp === 'number' && Number.isFinite(loc.timestamp)
          ? loc.timestamp
          : Date.now();
        const recordRoutePoint = () => {
          if (route.length >= ROUTE_CAP) return;
          route.push({
            lat: next.lat,
            lon: next.lon,
            t_ms: sampleAtMs,
            acc_m: lastAccuracyM,
            alt_m: alt,
            v_acc_m: vAcc,
          });
        };
        const acceptPoint = (distanceToAdd: number) => {
          totalDistanceMeters += Math.max(0, distanceToAdd);
          if (alt != null && (vAcc == null || vAcc <= MAX_VERTICAL_ACCURACY_METERS)) {
            if (lastAcceptedAltitudeM != null) {
              const gain = alt - lastAcceptedAltitudeM;
              if (gain >= MIN_ELEVATION_DELTA_METERS) totalElevationGainMeters += gain;
            }
            lastAcceptedAltitudeM = alt;
          }
          lastSamplePos = next;
          lastSampleAtMs = sampleAtMs;
          recordRoutePoint();
        };
        if (lastSamplePos != null) {
          const delta = haversineMeters(lastSamplePos, next);
          const dtSec = Math.max(1, (sampleAtMs - lastSampleAtMs) / 1000);
          const maxDelta = Math.max(FALLBACK_MAX_DELTA_METERS, filters.maxSpeedMps * dtSec * 2.2);
          const movingBySpeed = lastSpeedMps != null && lastSpeedMps >= filters.movingSpeedMps;
          const goodAccuracy = lastAccuracyM == null || lastAccuracyM <= filters.maxAccuracyMeters;
          const meaningfulPoorAccuracyMove = lastAccuracyM != null
            && delta >= Math.max(filters.minDeltaMeters * 4, lastAccuracyM * 0.35);
          // Reject low-quality deltas: GPS noise floor, impossible
          // teleports, and tiny movements inside a very poor accuracy
          // bubble. The old "accuracy must be narrower than the delta"
          // rule punished slow walks because each 1 Hz step is usually
          // smaller than the reported horizontal accuracy.
          if (delta >= filters.minDeltaMeters && delta <= maxDelta) {
            if (goodAccuracy || movingBySpeed || meaningfulPoorAccuracyMove) {
              acceptPoint(delta);
            }
          } else if (delta > maxDelta) {
            // Don't accumulate the teleport but DO update lastSamplePos
            // so the next legitimate movement starts from the new spot.
            // Record the new spot too so the polyline picks up there
            // instead of drawing a long jump line through the city.
            acceptPoint(0);
          }
        } else {
          // First fix — anchor the polyline. Distance stays 0 until
          // the user actually moves more than the activity-specific
          // noise floor.
          acceptPoint(0);
        }
        emit();
      },
    );
  } catch (e: any) {
    clearInterval(pulse);
    opts.onError?.(e?.message ?? 'GPS watcher failed to start.');
    return null;
  }

  return {
    snapshot,
    getRouteCoords() {
      // Defensive copy so callers can store the array in immutable
      // state without worrying about us mutating it later.
      return route.slice();
    },
    pause() {
      if (paused || stopped) return;
      paused = true;
      pausedAtMs = Date.now();
    },
    resume() {
      if (!paused || stopped) return;
      totalPausedMs += Date.now() - pausedAtMs;
      paused = false;
      pausedAtMs = 0;
    },
    async stop() {
      if (stopped) return snapshot();
      stopped = true;
      clearInterval(pulse);
      try { subscription?.remove(); } catch {}
      subscription = null;
      const final = snapshot();
      opts.onSample(final);
      return final;
    },
  };
}
