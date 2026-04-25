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

    func start() {
        guard HKHealthStore.isHealthDataAvailable() else {
            errorMessage = "HealthKit unavailable on this device."
            return
        }
        // Auth FIRST — calling HKWorkoutSession.startActivity before
        // authorization is resolved can hard-crash the app on watchOS
        // (rather than throw a catchable error). The earlier
        // "synchronous start before auth" optimization for snappier
        // UI was the cause of the "tap Start → app instantly closes"
        // crash. Keep the placeholder live-HR view in ActiveWorkoutView
        // (added separately) to prevent watchOS backgrounding during
        // the brief auth → session-start window.
        let read: Set<HKObjectType> = [
            HKObjectType.quantityType(forIdentifier: .heartRate)!,
            HKObjectType.workoutType(),
        ]
        let write: Set<HKSampleType> = [ HKObjectType.workoutType() ]
        store.requestAuthorization(toShare: write, read: read) { [weak self] ok, err in
            guard let self else { return }
            if let err {
                DispatchQueue.main.async { self.errorMessage = err.localizedDescription }
                return
            }
            // Even when the user denies, ok=true (auth completed).
            // Session can still start; HR samples just won't flow.
            // Failures inside beginSession's try/catch set
            // errorMessage instead of crashing.
            self.beginSession()
        }
    }

    private func beginSession() {
        let config = HKWorkoutConfiguration()
        // "traditionalStrengthTraining" maps to the activity type the
        // iPhone app uses for lift sessions. The watch will log the
        // workout to Health once `end()` runs.
        config.activityType = .traditionalStrengthTraining
        config.locationType = .indoor
        do {
            let sess = try HKWorkoutSession(healthStore: store, configuration: config)
            let bld = sess.associatedWorkoutBuilder()
            bld.dataSource = HKLiveWorkoutDataSource(healthStore: store, workoutConfiguration: config)
            bld.delegate = self
            sess.delegate = self
            self.session = sess
            self.builder = bld
            let start = Date()
            sess.startActivity(with: start)
            bld.beginCollection(withStart: start) { [weak self] _, _ in
                DispatchQueue.main.async { self?.running = true }
            }
        } catch {
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
