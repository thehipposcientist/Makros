// Live heart-rate reader. Uses HKWorkoutSession + HKLiveWorkoutBuilder
// so we get continuous HR samples while the active-workout screen is
// up. Stopping the session is explicit — when the user taps "End" or
// the active view is dismissed.
//
// Zone math:
//   Zone 1 < 60% HRmax          — recovery
//   Zone 2 60-70%               — easy aerobic
//   Zone 3 70-80%               — tempo
//   Zone 4 80-90%               — threshold
//   Zone 5 >= 90%               — max
// HRmax is approximated as 220 - age; we pull age from the phone-sent
// payload when we have it, fall back to 30 years old (= 190 bpm max)
// when we don't — same default the phone side uses.

import Foundation
import HealthKit

final class HeartRateStore: NSObject, ObservableObject {
    @Published var heartRate: Int? = nil
    @Published var zone: Int? = nil           // 1-5, nil before first sample
    @Published var running: Bool = false
    @Published var errorMessage: String? = nil

    private let store = HKHealthStore()
    private var session: HKWorkoutSession?
    private var builder: HKLiveWorkoutBuilder?
    private var userAge: Int = 30

    func setAge(_ age: Int?) {
        if let a = age, a > 0 { userAge = a }
    }

    var maxHR: Int { max(120, 220 - userAge) }

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
        let read: Set<HKObjectType> = [
            HKObjectType.quantityType(forIdentifier: .heartRate)!,
            HKObjectType.workoutType(),
        ]
        let write: Set<HKSampleType> = [ HKObjectType.workoutType() ]
        store.requestAuthorization(toShare: write, read: read) { _, _ in
            // Result intentionally ignored — `start()` re-runs auth and
            // surfaces any error there. We just want the dialog to have
            // appeared (and been answered) before the first Start tap.
        }
    }

    func start() {
        guard HKHealthStore.isHealthDataAvailable() else {
            wlog("[watch-hr] HealthKit unavailable")
            errorMessage = "HealthKit unavailable on this device."
            return
        }
        if session != nil {
            wlog("[watch-hr] stale session found — tearing down before new start")
            session?.end()
            builder?.discardWorkout()
            session = nil
            builder = nil
        }
        let status = store.authorizationStatus(for: HKObjectType.workoutType())
        wlog("[watch-hr] auth status=\(status.rawValue) (0=notDetermined, 1=denied, 2=authorized)")
        if status != .notDetermined {
            beginSession()
        } else {
            wlog("[watch-hr] auth not determined — requesting async")
            let read: Set<HKObjectType> = [
                HKObjectType.quantityType(forIdentifier: .heartRate)!,
                HKObjectType.workoutType(),
            ]
            let write: Set<HKSampleType> = [ HKObjectType.workoutType() ]
            store.requestAuthorization(toShare: write, read: read) { [weak self] ok, err in
                wlog("[watch-hr] auth callback ok=\(ok) err=\(err?.localizedDescription ?? "nil")")
                DispatchQueue.main.async { self?.beginSession() }
            }
        }
    }

    private func beginSession() {
        wlog("[watch-hr] beginSession — creating HKWorkoutSession")
        let config = HKWorkoutConfiguration()
        config.activityType = .traditionalStrengthTraining
        config.locationType = .indoor
        do {
            let sess = try HKWorkoutSession(healthStore: store, configuration: config)
            wlog("[watch-hr] session created — calling startActivity")
            let bld = sess.associatedWorkoutBuilder()
            bld.dataSource = HKLiveWorkoutDataSource(healthStore: store, workoutConfiguration: config)
            bld.delegate = self
            sess.delegate = self
            self.session = sess
            self.builder = bld
            let start = Date()
            sess.startActivity(with: start)
            wlog("[watch-hr] startActivity done — calling beginCollection")
            bld.beginCollection(withStart: start) { [weak self] ok, err in
                wlog("[watch-hr] beginCollection callback ok=\(ok) err=\(err?.localizedDescription ?? "nil")")
                DispatchQueue.main.async { self?.running = true }
            }
        } catch {
            wlog("[watch-hr] HK session FAILED: \(error.localizedDescription)")
            DispatchQueue.main.async { self.errorMessage = error.localizedDescription }
        }
    }

    func end() {
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
        session?.end()
        builder?.discardWorkout()
        heartRate = nil
        zone = nil
        running = false
        session = nil
        builder = nil
    }

    private func computeZone(for bpm: Int) -> Int {
        let pct = Double(bpm) / Double(maxHR)
        if pct < 0.60 { return 1 }
        if pct < 0.70 { return 2 }
        if pct < 0.80 { return 3 }
        if pct < 0.90 { return 4 }
        return 5
    }
}

extension HeartRateStore: HKWorkoutSessionDelegate, HKLiveWorkoutBuilderDelegate {
    func workoutSession(_ workoutSession: HKWorkoutSession, didChangeTo toState: HKWorkoutSessionState, from fromState: HKWorkoutSessionState, date: Date) {}
    func workoutSession(_ workoutSession: HKWorkoutSession, didFailWithError error: Error) {
        DispatchQueue.main.async {
            self.errorMessage = error.localizedDescription
            self.running = false
        }
    }

    func workoutBuilderDidCollectEvent(_ workoutBuilder: HKLiveWorkoutBuilder) {}

    func workoutBuilder(_ workoutBuilder: HKLiveWorkoutBuilder, didCollectDataOf collectedTypes: Set<HKSampleType>) {
        guard let qt = HKQuantityType.quantityType(forIdentifier: .heartRate),
              collectedTypes.contains(qt),
              let stats = workoutBuilder.statistics(for: qt),
              let last = stats.mostRecentQuantity()?.doubleValue(for: HKUnit(from: "count/min"))
        else { return }
        let bpm = Int(last.rounded())
        let z = computeZone(for: bpm)
        DispatchQueue.main.async {
            self.heartRate = bpm
            self.zone = z
        }
    }
}
