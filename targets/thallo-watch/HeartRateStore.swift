// Live heart-rate + cardio metrics reader. Uses HKWorkoutSession +
// HKLiveWorkoutBuilder so we get continuous samples while the
// active-workout screen is up. Stopping the session is explicit —
// when the user taps "End" or the active view is dismissed.
//
// What we collect, by activity type:
//   • All sessions:    heart rate (always), active energy (cardio only)
//   • Running/walking: distanceWalkingRunning (outdoor uses watch GPS;
//                     indoor relies on HK's pedometer-based estimate)
//   • Hiking:          distanceWalkingRunning + outdoor location
//   • Cycling:         distanceCycling — outdoor uses GPS; indoor has
//                     no auto distance and relies on the user manually
//                     setting `manualDistanceMeters`.
//   • Swimming/rower:  no auto distance source today (manual override)
//   • Lifting:         heart rate only (no distance / calories tile)
//
// Zone math:
//   Prefer phone-computed HR zones from /workouts/hr-zones so the live
//   watch display matches the phone's recommended cardio ranges.
//   Fall back to simple %HRmax only when a workout snapshot has not
//   delivered zones yet.

import CoreLocation
import CoreMotion
import Foundation
import HealthKit

/// One sample on the live route. Mirrors the iPhone-side RouteCoord
/// shape so the post-workout map / HKWorkoutRouteBuilder pipeline
/// treats both sources identically.
struct WatchRouteCoord: Equatable {
    let lat: Double
    let lon: Double
    let timestampMs: Double
    let horizontalAccuracyM: Double?
    let altitudeM: Double?
    let verticalAccuracyM: Double?
}

final class HeartRateStore: NSObject, ObservableObject {
    @Published var heartRate: Int? = nil
    @Published var zone: Int? = nil           // 1-5, nil before first sample
    @Published private(set) var zones: [WatchHRZone] = []
    @Published var running: Bool = false
    @Published var errorMessage: String? = nil

    // ── Cardio metrics (nil/0 for lift sessions) ──────────────────────
    /// Native distance from HKLiveWorkoutBuilder. Updates whenever the
    /// builder reports a new sample for the activity-appropriate
    /// quantity type. Outdoor sessions also keep a GPS accumulator as
    /// a live fallback for builders that emit distance late.
    @Published var nativeDistanceMeters: Double = 0
    /// Manual override for indoor cardio with no native distance
    /// source. UI shows a "Set distance" affordance that writes here;
    /// `displayDistanceMeters` prefers native when present.
    @Published var manualDistanceMeters: Double = 0
    /// Distance accumulated from CLLocation updates for outdoor
    /// cardio. Used as a live fallback when HKLiveWorkoutBuilder has
    /// not emitted a distance total yet.
    @Published var gpsDistanceMeters: Double = 0
    @Published var activeCalories: Double = 0
    @Published var elapsedSeconds: Int = 0
    @Published var stepCount: Int = 0
    @Published var elevationGainFeet: Double = 0
    /// Resolved activity type for the current session. Drives which
    /// distance quantity is collected and which UI tab the user sees.
    @Published var activityType: HKWorkoutActivityType = .traditionalStrengthTraining
    @Published var locationType: HKWorkoutSessionLocationType = .indoor

    /// Distance shown in the UI — native if the session collects it,
    /// otherwise the manual override. Pace + downstream HK writes both
    /// read from this so the on-screen number always matches what's
    /// persisted to Apple Health on completion.
    var displayDistanceMeters: Double {
        if nativeDistanceMeters > 0 && gpsDistanceMeters > 0 {
            return max(nativeDistanceMeters, gpsDistanceMeters)
        }
        if nativeDistanceMeters > 0 { return nativeDistanceMeters }
        if gpsDistanceMeters > 0 { return gpsDistanceMeters }
        return manualDistanceMeters
    }

    /// Average pace in seconds per kilometer. Returns nil before the
    /// first 30 m of distance to avoid noisy "9:99" displays during the
    /// first few seconds of a session.
    var averagePaceSecPerKm: Double? {
        let d = displayDistanceMeters
        guard d >= 30, elapsedSeconds > 0 else { return nil }
        return Double(elapsedSeconds) / (d / 1000.0)
    }

    /// True when the resolved activity should render the cardio tab
    /// (live distance + pace + HR + calories) rather than the lift tab.
    var isCardio: Bool { Self.isCardioActivity(activityType) }

    /// True when the activity has no native distance source on the
    /// watch but is machine cardio where the user can read distance
    /// from equipment. Court sports use the cardio UI without distance.
    var needsManualDistance: Bool {
        Self.requiresManualDistanceEntry(for: activityType, location: locationType)
    }

    private let store = HKHealthStore()
    /// Live route trail captured during outdoor cardio. Powered by
    /// `CLLocationManager` rather than HKLiveWorkoutBuilder because
    /// HK doesn't expose route samples until finishWorkout fires.
    /// Drawn on the watch's Map tab (Cut 4) and shipped to phone via
    /// `cardio_metrics` updates so the iPhone summary map is also
    /// populated even when the workout was started on the wrist.
    @Published var routeCoords: [WatchRouteCoord] = []
    /// Most recent fix — drives the watch map's camera-follow without
    /// iterating the full coords array on every render.
    @Published var currentLocation: CLLocationCoordinate2D? = nil

    private var session: HKWorkoutSession?
    private var builder: HKLiveWorkoutBuilder?
    private var userAge: Int = 30
    /// Drives the elapsedSeconds @Published. Recreated each session.
    private var elapsedTimer: Timer?
    private var sessionStartedAt: Date?
    private var metricWindowStartedAt: Date?
    private var pendingActivityFocus: String?
    /// CLLocationManager — only spun up for outdoor cardio sessions.
    /// Stays nil for lifting + indoor cardio so the watch doesn't ask
    /// for location permission unless it's actually needed.
    private var locationManager: CLLocationManager?
    private var locationUpdatesActive: Bool = false
    private var lastAcceptedLocation: CLLocation?
    private var lastAcceptedAltitudeM: Double?
    private let pedometer = CMPedometer()
    private static let maxRouteCoords = 12_000  // ~3.3 hrs @ 1Hz

    private var startInFlight: Bool = false
    private var intentionalEnd: Bool = false
    private var autoRestartCount: Int = 0
    private static let maxAutoRestarts = 3

    private static let kDiagKey = "thallo.hrDiag"
    private static let kDiagListKey = "thallo.hrDiagList"
    private static let kDiagListMax = 30
    // Pinned key: survives ring-buffer rotation. Written by absorbContext
    // on every workout absorption outcome so it's always readable even
    // when rapid pull_state sends fill the ring buffer.
    private static let kLastAbsorbKey = "thallo.lastAbsorb"

    /// Save a diagnostic line. Writes the latest message to `kDiagKey`
    /// (single-string, overwrite) AND appends to a small ring buffer at
    /// `kDiagListKey` so the on-watch debug strip can show recent
    /// history rather than just the most recent line. The single-string
    /// key is kept so existing call sites stay one-line readable.
    static func saveDiag(_ msg: String) {
        let stamped = "\(timestamp()) \(msg)"
        UserDefaults.standard.set(stamped, forKey: kDiagKey)
        var list = UserDefaults.standard.stringArray(forKey: kDiagListKey) ?? []
        list.append(stamped)
        if list.count > kDiagListMax {
            list.removeFirst(list.count - kDiagListMax)
        }
        UserDefaults.standard.set(list, forKey: kDiagListKey)
    }

    /// Save a pinned "last context absorb" summary. Unlike the ring buffer,
    /// this key is never rotated out — it holds the most recent workout
    /// absorption result so the sync-log strip can always show it.
    static func saveLastAbsorb(_ msg: String) {
        let stamped = "\(timestamp()) ctx: \(msg)"
        UserDefaults.standard.set(stamped, forKey: kLastAbsorbKey)
    }

    static func lastDiag() -> String? {
        UserDefaults.standard.string(forKey: kDiagKey)
    }

    static func lastAbsorb() -> String? {
        UserDefaults.standard.string(forKey: kLastAbsorbKey)
    }

    /// Return the recent diagnostic lines, oldest → newest. Empty when
    /// nothing has been logged yet.
    static func recentDiag(limit: Int = kDiagListMax) -> [String] {
        let list = UserDefaults.standard.stringArray(forKey: kDiagListKey) ?? []
        if list.count <= limit { return list }
        return Array(list.suffix(limit))
    }

    private static func timestamp() -> String {
        let now = Date()
        let cal = Calendar.current
        let h = cal.component(.hour, from: now)
        let m = cal.component(.minute, from: now)
        let s = cal.component(.second, from: now)
        return String(format: "%02d:%02d:%02d", h, m, s)
    }

    func setAge(_ age: Int?) {
        if let a = age, a > 0 { userAge = a }
    }

    func setZones(_ incoming: [WatchHRZone]?) {
        let normalized = (incoming ?? [])
            .filter { $0.zone >= 1 && $0.zone <= 5 && $0.low > 0 && $0.high >= $0.low }
            .sorted { $0.zone < $1.zone }
        zones = normalized
        if let bpm = heartRate {
            zone = computeZone(for: bpm)
        }
    }

    /// Manual distance override — used by the indoor-cardio "Set
    /// distance" tile. Stored separately from native distance so the
    /// two sources don't collide; `displayDistanceMeters` resolves the
    /// right one based on whether a native source is feeding data.
    func setManualDistance(meters: Double) {
        let clamped = max(0, meters)
        DispatchQueue.main.async { self.manualDistanceMeters = clamped }
    }

    var maxHR: Int { max(120, 220 - userAge) }

    var currentZoneDefinition: WatchHRZone? {
        guard let zone else { return nil }
        return zones.first { $0.zone == zone }
    }

    /// Request HealthKit authorization at app launch — no session start.
    /// The HK auth dialog is the slow step in the start-workout flow; if
    /// it appears the moment the user taps Start, watchOS can suspend
    /// the app before HKWorkoutSession is established (no foreground
    /// claim → no extended runtime). Pre-warming here means by the time
    /// the user taps Start, requestAuthorization returns immediately and
    /// `beginSession` runs in milliseconds. Safe to call repeatedly —
    /// watchOS only shows the dialog once per install.
    func prewarmAuth() {
        guard HKHealthStore.isHealthDataAvailable() else { return }
        let read = Self.readDataTypes()
        let write = Self.shareDataTypes()
        store.requestAuthorization(toShare: write, read: read) { _, _ in
            // Result intentionally ignored — `start()` re-runs auth and
            // surfaces any error there. We just want the dialog to have
            // appeared (and been answered) before the first Start tap.
        }
    }

    /// Start the workout session. The optional `onReady` fires on
    /// main thread once `beginCollection` confirms data is flowing —
    /// callers should wait for this before transitioning the UI.
    ///
    /// `focus` (e.g. "Run", "Push", "Bike") drives activity-type
    /// detection so the session is configured correctly for the sport
    /// the user is doing. Without this, every session was previously
    /// configured as `.traditionalStrengthTraining + .indoor` — runs
    /// would never collect distance or use GPS.
    func start(focus: String? = nil, onReady: (() -> Void)? = nil) {
        Self.saveDiag("start called focus=\(focus ?? "nil")")
        guard HKHealthStore.isHealthDataAvailable() else {
            Self.saveDiag("ERR:HK unavailable")
            errorMessage = "HealthKit unavailable on this device."
            return
        }
        if session != nil {
            Self.saveDiag("start: session exists (running=\(running))")
            if running { onReady?() }
            return
        }
        // Reentrancy guard — multiple onAppear/onReceive/pendingLaunch events
        // can race into start() before beginSession creates the session ref.
        if startInFlight {
            Self.saveDiag("start: already in-flight, skipping")
            return
        }
        startInFlight = true
        intentionalEnd = false
        autoRestartCount = 0
        nativeDistanceMeters = 0
        manualDistanceMeters = 0
        gpsDistanceMeters = 0
        activeCalories = 0
        elapsedSeconds = 0
        stepCount = 0
        elevationGainFeet = 0
        routeCoords = []
        currentLocation = nil
        lastAcceptedLocation = nil
        lastAcceptedAltitudeM = nil

        let resolved = Self.resolveActivity(focus: focus)
        let assignResolvedActivity = {
            self.activityType = resolved.type
            self.locationType = resolved.location
        }
        if Thread.isMainThread {
            assignResolvedActivity()
        } else {
            DispatchQueue.main.async { assignResolvedActivity() }
        }

        let status = store.authorizationStatus(for: HKObjectType.workoutType())
        Self.saveDiag("auth=\(status.rawValue) type=\(resolved.type.rawValue) loc=\(resolved.location.rawValue)")
        if status != .notDetermined {
            beginSession(activity: resolved, onReady: onReady)
        } else {
            Self.saveDiag("requesting auth")
            let read = Self.readDataTypes()
            let write = Self.shareDataTypes()
            store.requestAuthorization(toShare: write, read: read) { [weak self] ok, err in
                Self.saveDiag("auth cb ok=\(ok) err=\(err?.localizedDescription ?? "nil")")
                DispatchQueue.main.async { self?.beginSession(activity: resolved, onReady: onReady) }
            }
        }
    }

    private func beginSession(
        activity: (type: HKWorkoutActivityType, location: HKWorkoutSessionLocationType),
        onReady: (() -> Void)? = nil
    ) {
        Self.saveDiag("beginSession type=\(activity.type.rawValue) loc=\(activity.location.rawValue)")
        let config = HKWorkoutConfiguration()
        config.activityType = activity.type
        config.locationType = activity.location
        // Swimming needs a swimming-location enum (pool vs open water).
        // Default to pool so HK's auto-lap detection turns on. Open-water
        // swims would need a separate code path — out of Cut 1 scope.
        if activity.type == .swimming {
            config.swimmingLocationType = .pool
        }
        do {
            let sess = try HKWorkoutSession(healthStore: store, configuration: config)
            Self.saveDiag("session created")
            let bld = sess.associatedWorkoutBuilder()
            bld.dataSource = HKLiveWorkoutDataSource(healthStore: store, workoutConfiguration: config)
            bld.delegate = self
            sess.delegate = self
            self.session = sess
            self.builder = bld
            let start = Date()
            sessionStartedAt = start
            metricWindowStartedAt = start
            sess.startActivity(with: start)
            Self.saveDiag("startActivity OK")
            bld.beginCollection(withStart: start) { [weak self] ok, err in
                Self.saveDiag("collecting ok=\(ok) err=\(err?.localizedDescription ?? "nil")")
                DispatchQueue.main.async {
                    self?.startInFlight = false
                    if ok {
                        self?.running = true
                        self?.startElapsedTimer()
                        self?.startPedometerUpdatesIfNeeded(from: start)
                        self?.startLocationUpdatesIfNeeded()
                        if let pending = self?.pendingActivityFocus {
                            self?.pendingActivityFocus = nil
                            self?.beginActivity(focus: pending)
                        }
                        onReady?()
                    } else {
                        self?.errorMessage = err?.localizedDescription ?? "Failed to start collection"
                        self?.session?.end()
                        self?.session = nil
                        self?.builder = nil
                    }
                }
            }
        } catch {
            Self.saveDiag("ERR:\(error.localizedDescription)")
            startInFlight = false
            DispatchQueue.main.async { self.errorMessage = error.localizedDescription }
        }
    }

    private func startElapsedTimer() {
        elapsedTimer?.invalidate()
        // 1Hz tick — small payload, smooth pace updates. Pause-aware
        // via session state changes (HK pauses the builder's elapsed
        // time automatically; we just resync from sessionStartedAt
        // minus accumulated pauses on each tick).
        elapsedTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            guard let self, let bld = self.builder else { return }
            // Builder's elapsedTime already accounts for pauses, which
            // is exactly the behavior the UI expects. Falling back to
            // a wall-clock delta would tick during pauses. Cardio
            // segments inside a lift+cardio workout reset the visible
            // metric window when the activity changes, so the finisher
            // starts at 0:00 instead of inheriting lift elapsed time.
            let baseSecs = Int(bld.elapsedTime.rounded())
            let secs: Int
            if Self.isCardioActivity(self.activityType),
               let windowStart = self.metricWindowStartedAt {
                secs = max(0, Int(Date().timeIntervalSince(windowStart).rounded()))
            } else {
                secs = baseSecs
            }
            DispatchQueue.main.async { self.elapsedSeconds = secs }
        }
    }

    /// Switch the live HealthKit activity without ending the workout.
    /// Used when a mixed lift + cardio plan reaches its cardio finisher:
    /// the session starts as strength for the lifting block, then begins
    /// a cardio activity so distance / calories / route metrics flow.
    func beginActivity(focus: String?) {
        let resolved = Self.resolveActivity(focus: focus)
        Self.saveDiag("beginActivity focus=\(focus ?? "nil") type=\(resolved.type.rawValue) loc=\(resolved.location.rawValue)")
        if session == nil {
            pendingActivityFocus = focus
            if !startInFlight {
                start(focus: focus)
            }
            return
        }
        pendingActivityFocus = nil
        if activityType == resolved.type && locationType == resolved.location {
            return
        }
        guard let sess = session, let bld = builder else { return }

        stopPedometerUpdates()
        stopLocationUpdates()
        nativeDistanceMeters = 0
        manualDistanceMeters = 0
        gpsDistanceMeters = 0
        activeCalories = 0
        elapsedSeconds = 0
        stepCount = 0
        elevationGainFeet = 0
        routeCoords = []
        currentLocation = nil
        lastAcceptedLocation = nil
        lastAcceptedAltitudeM = nil

        let config = HKWorkoutConfiguration()
        config.activityType = resolved.type
        config.locationType = resolved.location
        if resolved.type == .swimming {
            config.swimmingLocationType = .pool
        }
        let start = Date()
        metricWindowStartedAt = start
        activityType = resolved.type
        locationType = resolved.location
        bld.dataSource = HKLiveWorkoutDataSource(healthStore: store, workoutConfiguration: config)
        sess.beginNewActivity(configuration: config, date: start, metadata: nil)
        startPedometerUpdatesIfNeeded(from: start)
        startLocationUpdatesIfNeeded()
    }

    func end() {
        intentionalEnd = true
        startInFlight = false
        pendingActivityFocus = nil
        Self.saveDiag("end() called")
        elapsedTimer?.invalidate()
        elapsedTimer = nil
        stopPedometerUpdates()
        stopLocationUpdates()
        guard let sess = session, let bld = builder else {
            running = false
            return
        }
        sess.end()
        bld.endCollection(withEnd: Date()) { [weak self] _, _ in
            bld.finishWorkout { _, _ in
                DispatchQueue.main.async {
                    self?.running = false
                    self?.session = nil
                    self?.builder = nil
                }
            }
        }
    }

    /// Teardown-without-save. Used when the user cancels a workout —
    /// we stop the HK session but DO NOT call `finishWorkout`, so
    /// nothing lands in the Health app. Rolls back HR / session refs
    /// so the next `start()` begins cleanly.
    func discard() {
        intentionalEnd = true
        startInFlight = false
        Self.saveDiag("discard() called")
        elapsedTimer?.invalidate()
        elapsedTimer = nil
        stopPedometerUpdates()
        stopLocationUpdates()
        session?.end()
        builder?.discardWorkout()
        heartRate = nil
        zone = nil
        nativeDistanceMeters = 0
        manualDistanceMeters = 0
        gpsDistanceMeters = 0
        activeCalories = 0
        elapsedSeconds = 0
        stepCount = 0
        elevationGainFeet = 0
        sessionStartedAt = nil
        metricWindowStartedAt = nil
        pendingActivityFocus = nil
        routeCoords = []
        currentLocation = nil
        lastAcceptedLocation = nil
        lastAcceptedAltitudeM = nil
        running = false
        session = nil
        builder = nil
    }

    private func startPedometerUpdatesIfNeeded(from start: Date) {
        guard isCardio, CMPedometer.isStepCountingAvailable() else { return }
        pedometer.startUpdates(from: start) { [weak self] data, _ in
            guard let self, let data else { return }
            let steps = data.numberOfSteps.intValue
            let floorGainFt = data.floorsAscended.map { Double(truncating: $0) * 10.0 } ?? 0
            DispatchQueue.main.async {
                self.stepCount = max(self.stepCount, steps)
                if floorGainFt > self.elevationGainFeet {
                    self.elevationGainFeet = floorGainFt
                }
            }
        }
    }

    private func stopPedometerUpdates() {
        pedometer.stopUpdates()
    }

    // ─── Location tracking (outdoor cardio only) ──────────────────────

    private func startLocationUpdatesIfNeeded() {
        // Only spin up GPS for outdoor cardio. Indoor / lifting users
        // shouldn't see a location-permission prompt or pay battery
        // cost for a metric they won't use.
        guard isCardio, locationType == .outdoor else { return }
        if let manager = locationManager {
            startAuthorizedLocationUpdates(manager)
            return
        }
        let manager = CLLocationManager()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBestForNavigation
        manager.distanceFilter = kCLDistanceFilterNone
        manager.activityType = (activityType == .cycling) ? .fitness : .fitness
        // Foreground-only is fine on watchOS — the workout session
        // keeps the app foregrounded for the entire duration. No
        // backgrounding rights needed for the wrist.
        let status = manager.authorizationStatus
        Self.saveDiag("LM auth=\(status.rawValue)")
        locationManager = manager
        switch status {
        case .notDetermined:
            manager.requestWhenInUseAuthorization()
        case .authorizedAlways, .authorizedWhenInUse:
            startAuthorizedLocationUpdates(manager)
        case .denied, .restricted:
            Self.saveDiag("LM skipped: auth=\(status.rawValue)")
        @unknown default:
            Self.saveDiag("LM skipped: auth unknown=\(status.rawValue)")
        }
    }

    private func startAuthorizedLocationUpdates(_ manager: CLLocationManager) {
        guard !locationUpdatesActive else { return }
        let status = manager.authorizationStatus
        guard status == .authorizedAlways || status == .authorizedWhenInUse else { return }
        locationUpdatesActive = true
        manager.startUpdatingLocation()
        Self.saveDiag("LM start updates")
    }

    private func stopLocationUpdates() {
        locationManager?.stopUpdatingLocation()
        locationManager?.delegate = nil
        locationManager = nil
        locationUpdatesActive = false
    }

    private func computeZone(for bpm: Int) -> Int {
        if !zones.isEmpty {
            if let match = zones.first(where: { bpm >= $0.low && bpm <= $0.high }) {
                return match.zone
            }
            if let first = zones.first, bpm < first.low {
                return first.zone
            }
            if let last = zones.last {
                return last.zone
            }
        }
        let pct = Double(bpm) / Double(maxHR)
        if pct < 0.60 { return 1 }
        if pct < 0.70 { return 2 }
        if pct < 0.80 { return 3 }
        if pct < 0.90 { return 4 }
        return 5
    }

    // ─── Activity-type mapping (mirrors phone-side) ───────────────────
    //
    // Kept in sync with ThalloHealthKitModule.activityTypeFromString so
    // a workout started on the watch maps to the same HK type the phone
    // would have used if started there. Any new sport should be added
    // in BOTH places (and both should map to the same HKWorkoutActivityType).

    private static func resolveActivity(focus: String?) -> (type: HKWorkoutActivityType, location: HKWorkoutSessionLocationType) {
        let s = (focus ?? "").lowercased()
        if isMixedStrengthCardioFocus(focus) {
            return (.traditionalStrengthTraining, .indoor)
        }
        // Outdoor activity types — watch GPS auto-feeds distance into
        // the live builder when locationType is .outdoor.
        if s.contains("run") {
            let loc: HKWorkoutSessionLocationType = s.contains("treadmill") || s.contains("indoor") ? .indoor : .outdoor
            return (.running, loc)
        }
        if s.contains("walk") {
            let loc: HKWorkoutSessionLocationType = s.contains("indoor") || s.contains("treadmill") ? .indoor : .outdoor
            return (.walking, loc)
        }
        if s.contains("hike") { return (.hiking, .outdoor) }
        if s.contains("bike") || s.contains("cycl") || s == "ride" || s == "spin" {
            let loc: HKWorkoutSessionLocationType = s.contains("indoor") || s.contains("stationary") || s.contains("spin") ? .indoor : .outdoor
            return (.cycling, loc)
        }
        if s.contains("swim") || s.contains("open water") || s.contains("pool") {
            let loc: HKWorkoutSessionLocationType = s.contains("open water") || s.contains("outdoor") ? .outdoor : .indoor
            return (.swimming, loc)
        }
        if s.contains("row") {
            let loc: HKWorkoutSessionLocationType = s.contains("outdoor") || s.contains("water") ? .outdoor : .indoor
            return (.rowing, loc)
        }
        if s.contains("ellipt") { return (.elliptical, .indoor) }
        if s.contains("stair") { return (.stairClimbing, .indoor) }
        if s.contains("climb") || s.contains("boulder") { return (.climbing, .indoor) }
        if s.contains("hiit") || s.contains("bootcamp") || s.contains("boot camp") || s.contains("boot-camp") || s.contains("interval") || s.contains("tabata") { return (.highIntensityIntervalTraining, .indoor) }
        if s.contains("zone") || s.contains("cardio") || s.contains("conditioning") || s.contains("tempo") { return (.mixedCardio, .indoor) }
        if s.contains("yoga") { return (.yoga, s.contains("outdoor") ? .outdoor : .indoor) }
        if s.contains("pilates") { return (.pilates, .indoor) }
        if s.contains("circuit") || s.contains("cross") { return (.crossTraining, .indoor) }
        if s.contains("core") { return (.coreTraining, .indoor) }
        if s.contains("mobility") || s.contains("stretch") || s.contains("flex") { return (.flexibility, .indoor) }
        if s.contains("dance") || s.contains("spin") { return (.cardioDance, .indoor) }
        if s.contains("boxing") || s.contains("kickbox") || s.contains("martial") || s.contains("mma") { return (.boxing, .indoor) }
        if s.contains("soccer") || s.contains("futsal") {
            return (.soccer, s.contains("indoor") || s.contains("futsal") ? .indoor : .outdoor)
        }
        if s.contains("basket") {
            return (.basketball, s.contains("outdoor") ? .outdoor : .indoor)
        }
        if s.contains("tennis") {
            return (.tennis, s.contains("indoor") ? .indoor : .outdoor)
        }
        if s.contains("pickle") {
            return (.pickleball, s.contains("indoor") ? .indoor : .outdoor)
        }
        if s.contains("golf") { return (.golf, .outdoor) }
        if s.contains("volley") { return (.volleyball, s.contains("beach") || s.contains("outdoor") ? .outdoor : .indoor) }
        // Lift fallbacks
        if s.contains("lift") || s.contains("weight") || s.contains("strength") { return (.traditionalStrengthTraining, .indoor) }
        if ["push", "pull", "legs", "upper", "lower", "full body", "full_body"].contains(where: s.contains) {
            return (.traditionalStrengthTraining, .indoor)
        }
        return (.functionalStrengthTraining, .indoor)
    }

    static func isMixedStrengthCardioFocus(_ focus: String?) -> Bool {
        let s = (focus ?? "").lowercased()
        guard s.contains("+ cardio") || s.contains("+cardio") else { return false }
        return ["push", "pull", "legs", "upper", "lower", "full body", "full_body", "lift", "strength", "weight"].contains { s.contains($0) }
    }

    static func isCardioFocus(_ focus: String?) -> Bool {
        isCardioActivity(resolveActivity(focus: focus).type)
    }

    static func isCardioActivity(_ type: HKWorkoutActivityType) -> Bool {
        switch type {
        case .running, .walking, .hiking, .cycling, .swimming, .rowing,
             .elliptical, .stairClimbing, .stairs, .stepTraining,
             .mixedCardio, .highIntensityIntervalTraining,
             .cardioDance, .crossTraining, .boxing,
             .soccer, .basketball, .tennis, .pickleball, .volleyball, .golf:
            return true
        default:
            return false
        }
    }

    static func requiresManualDistanceEntry(
        for type: HKWorkoutActivityType,
        location: HKWorkoutSessionLocationType
    ) -> Bool {
        if distanceQuantityType(for: type, location: location) != nil { return false }
        switch type {
        case .cycling, .rowing, .elliptical, .stairClimbing, .stairs, .stepTraining,
             .mixedCardio, .highIntensityIntervalTraining, .cardioDance, .crossTraining:
            return true
        default:
            return false
        }
    }

    /// Returns the HK distance quantity the live builder should
    /// produce for the given (activity, location) combination, or nil
    /// when no auto source exists — UI then surfaces manual entry.
    static func distanceQuantityType(
        for type: HKWorkoutActivityType,
        location: HKWorkoutSessionLocationType
    ) -> HKQuantityType? {
        switch type {
        case .running, .walking, .hiking:
            // Walk/Run distance works indoors via pedometer too.
            return HKQuantityType.quantityType(forIdentifier: .distanceWalkingRunning)
        case .cycling:
            // Cycling distance only flows when the watch has GPS
            // (outdoor). Indoor bikes need a paired BLE sensor or the
            // manual override path. distanceCycling will not auto-fill
            // for indoor sessions.
            guard location == .outdoor else { return nil }
            return HKQuantityType.quantityType(forIdentifier: .distanceCycling)
        case .swimming:
            // HKWorkoutSession with .swimming auto-detects pool laps and
            // emits distanceSwimming on Series 4+ when a pool length is
            // configured. We let HK try; users without a configured pool
            // can use the manual override.
            return HKQuantityType.quantityType(forIdentifier: .distanceSwimming)
        default:
            return nil
        }
    }

    private static func readDataTypes() -> Set<HKObjectType> {
        let types: Set<HKObjectType> = [
            HKObjectType.workoutType(),
            HKQuantityType.quantityType(forIdentifier: .heartRate)!,
            HKQuantityType.quantityType(forIdentifier: .activeEnergyBurned)!,
            HKQuantityType.quantityType(forIdentifier: .distanceWalkingRunning)!,
            HKQuantityType.quantityType(forIdentifier: .distanceCycling)!,
            HKQuantityType.quantityType(forIdentifier: .distanceSwimming)!,
        ]
        // Elevation is a workout route field — surfaced post-workout
        // via HKWorkoutRoute, not the live builder. Leaving out of the
        // request set keeps the consent dialog tighter.
        return types
    }

    private static func shareDataTypes() -> Set<HKSampleType> {
        var types: Set<HKSampleType> = [HKObjectType.workoutType()]
        if let activeEnergy = HKQuantityType.quantityType(forIdentifier: .activeEnergyBurned) {
            types.insert(activeEnergy)
        }
        if let walkingRunning = HKQuantityType.quantityType(forIdentifier: .distanceWalkingRunning) {
            types.insert(walkingRunning)
        }
        if let cycling = HKQuantityType.quantityType(forIdentifier: .distanceCycling) {
            types.insert(cycling)
        }
        if let swimming = HKQuantityType.quantityType(forIdentifier: .distanceSwimming) {
            types.insert(swimming)
        }
        types.insert(HKSeriesType.workoutRoute())
        return types
    }
}

extension HeartRateStore: CLLocationManagerDelegate {
    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status = manager.authorizationStatus
        Self.saveDiag("LM auth changed=\(status.rawValue)")
        switch status {
        case .authorizedAlways, .authorizedWhenInUse:
            startAuthorizedLocationUpdates(manager)
        case .denied, .restricted:
            stopLocationUpdates()
        default:
            break
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        // Filter out low-accuracy + obviously stationary samples to
        // keep the polyline clean. CLLocation.horizontalAccuracy is
        // negative when invalid; samples in urban canyons / right
        // after a fix can show ±50m which would draw drunken zigzags.
        for loc in locations {
            guard loc.horizontalAccuracy >= 0, loc.horizontalAccuracy <= 50 else { continue }
            let next = WatchRouteCoord(
                lat: loc.coordinate.latitude,
                lon: loc.coordinate.longitude,
                timestampMs: loc.timestamp.timeIntervalSince1970 * 1000,
                horizontalAccuracyM: loc.horizontalAccuracy >= 0 ? loc.horizontalAccuracy : nil,
                altitudeM: loc.verticalAccuracy >= 0 ? loc.altitude : nil,
                verticalAccuracyM: loc.verticalAccuracy >= 0 ? loc.verticalAccuracy : nil
            )
            let deltaMeters: Double
            if let prev = lastAcceptedLocation {
                let rawDelta = loc.distance(from: prev)
                // Keep walking pace responsive without letting GPS
                // jitter or impossible jumps inflate distance.
                deltaMeters = rawDelta >= 1.5 && rawDelta <= 200 ? rawDelta : 0
            } else {
                deltaMeters = 0
            }
            lastAcceptedLocation = loc
            var altitudeGainFt: Double = 0
            if loc.verticalAccuracy >= 0, loc.verticalAccuracy <= 30 {
                if let prevAltitude = lastAcceptedAltitudeM {
                    let gainM = loc.altitude - prevAltitude
                    if gainM > 0.5 && gainM < 80 {
                        altitudeGainFt = gainM * 3.280839895
                    }
                }
                lastAcceptedAltitudeM = loc.altitude
            }
            DispatchQueue.main.async {
                if self.routeCoords.count >= Self.maxRouteCoords { return }
                self.routeCoords.append(next)
                self.currentLocation = loc.coordinate
                if deltaMeters > 0 {
                    self.gpsDistanceMeters += deltaMeters
                }
                if altitudeGainFt > 0 {
                    self.elevationGainFeet += altitudeGainFt
                }
            }
        }
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        Self.saveDiag("LM err: \(error.localizedDescription)")
    }
}

extension HeartRateStore: HKWorkoutSessionDelegate, HKLiveWorkoutBuilderDelegate {
    func workoutSession(_ workoutSession: HKWorkoutSession, didChangeTo toState: HKWorkoutSessionState, from fromState: HKWorkoutSessionState, date: Date) {
        Self.saveDiag("state \(fromState.rawValue)→\(toState.rawValue) intent=\(intentionalEnd)")
        wlog("[watch-hr] HK state \(fromState.rawValue)→\(toState.rawValue)")

        if toState == .ended && !intentionalEnd && autoRestartCount < Self.maxAutoRestarts {
            autoRestartCount += 1
            Self.saveDiag("AUTO-RESTART #\(autoRestartCount)")
            wlog("[watch-hr] AUTO-RESTART #\(autoRestartCount)")
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.session = nil
                self.builder = nil
                let resolved = (type: self.activityType, location: self.locationType)
                self.beginSession(activity: resolved)
            }
        }
    }
    func workoutSession(_ workoutSession: HKWorkoutSession, didFailWithError error: Error) {
        Self.saveDiag("FAILED:\(error.localizedDescription)")
        wlog("[watch-hr] HK FAILED: \(error.localizedDescription)")
        DispatchQueue.main.async {
            self.errorMessage = error.localizedDescription
            self.running = false
        }
    }

    func workoutBuilderDidCollectEvent(_ workoutBuilder: HKLiveWorkoutBuilder) {}

    func workoutBuilder(_ workoutBuilder: HKLiveWorkoutBuilder, didCollectDataOf collectedTypes: Set<HKSampleType>) {
        // ── Heart rate (always) ──────────────────────────────────────
        if let hrType = HKQuantityType.quantityType(forIdentifier: .heartRate),
           collectedTypes.contains(hrType),
           let stats = workoutBuilder.statistics(for: hrType),
           let last = stats.mostRecentQuantity()?.doubleValue(for: HKUnit(from: "count/min"))
        {
            let bpm = Int(last.rounded())
            let z = computeZone(for: bpm)
            DispatchQueue.main.async {
                self.heartRate = bpm
                self.zone = z
            }
        }

        // ── Active energy (cardio only — lift sessions don't read it
        //    so the chip stays at 0 / hidden) ─────────────────────────
        if Self.isCardioActivity(activityType),
           let calType = HKQuantityType.quantityType(forIdentifier: .activeEnergyBurned),
           collectedTypes.contains(calType),
           let stats = workoutBuilder.statistics(for: calType),
           let total = stats.sumQuantity()?.doubleValue(for: .kilocalorie())
        {
            DispatchQueue.main.async { self.activeCalories = total }
        }

        // ── Distance (sport-specific quantity) ───────────────────────
        if let distanceType = Self.distanceQuantityType(for: activityType, location: locationType),
           collectedTypes.contains(distanceType),
           let stats = workoutBuilder.statistics(for: distanceType),
           let total = stats.sumQuantity()?.doubleValue(for: .meter())
        {
            DispatchQueue.main.async { self.nativeDistanceMeters = total }
        }
    }
}
