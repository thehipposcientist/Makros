import CoreLocation
import CoreMotion
import ExpoModulesCore
import HealthKit

public class ThalloHealthKitModule: Module {
    private let store = HKHealthStore()
    private let activityManager = CMMotionActivityManager()
    private let activityQueue = OperationQueue()
    private var activityDetectionRunning = false
    private var activityCandidateKind: String?
    private var activityCandidateStartedAt: Date?
    private var emittedActivityCandidateKey: String?

    deinit {
        activityManager.stopActivityUpdates()
    }

    public func definition() -> ModuleDefinition {
        Name("ThalloHealthKitModule")

        Events("activityDetection")

        Function("isAvailable") { () -> Bool in
            HKHealthStore.isHealthDataAvailable()
        }

        Function("isActivityDetectionAvailable") { () -> Bool in
            CMMotionActivityManager.isActivityAvailable()
        }

        Function("getActivityDetectionAuthorizationStatus") { () -> String in
            return self.activityAuthorizationStatus()
        }

        AsyncFunction("startActivityDetection") { () -> Bool in
            guard CMMotionActivityManager.isActivityAvailable() else { return false }
            if self.activityAuthorizationStatus() == "denied" || self.activityAuthorizationStatus() == "restricted" {
                return false
            }
            if self.activityDetectionRunning { return true }
            self.activityQueue.name = "com.thallo.activity-detection"
            self.activityDetectionRunning = true
            self.activityManager.startActivityUpdates(to: self.activityQueue) { [weak self] activity in
                guard let self, let activity else { return }
                self.handleActivityDetectionSample(activity)
            }
            return true
        }

        Function("stopActivityDetection") {
            self.activityDetectionRunning = false
            self.activityCandidateKind = nil
            self.activityCandidateStartedAt = nil
            self.emittedActivityCandidateKey = nil
            self.activityManager.stopActivityUpdates()
        }

        AsyncFunction("requestAuthorization") { (readTypes: [String]) -> Bool in
            guard HKHealthStore.isHealthDataAvailable() else { return false }
            var types = Set<HKObjectType>()
            for name in readTypes {
                if let t = self.objectType(for: name) { types.insert(t) }
            }
            var shareTypes = Set<HKSampleType>()
            shareTypes.insert(HKObjectType.workoutType())
            if let activeEnergy = HKQuantityType.quantityType(forIdentifier: .activeEnergyBurned) {
                shareTypes.insert(activeEnergy)
            }
            if let walkingRunning = HKQuantityType.quantityType(forIdentifier: .distanceWalkingRunning) {
                shareTypes.insert(walkingRunning)
            }
            if let cycling = HKQuantityType.quantityType(forIdentifier: .distanceCycling) {
                shareTypes.insert(cycling)
            }
            if let swimming = HKQuantityType.quantityType(forIdentifier: .distanceSwimming) {
                shareTypes.insert(swimming)
            }
            // Workout route series — required for HKWorkoutRouteBuilder
            // to attach a GPS trail to a saved HKWorkout. Without this
            // in the share set, insertRouteData fails silently.
            shareTypes.insert(HKSeriesType.workoutRoute())
            return try await withCheckedThrowingContinuation { cont in
                self.store.requestAuthorization(toShare: shareTypes, read: types) { ok, err in
                    if let err { cont.resume(throwing: err) } else { cont.resume(returning: ok) }
                }
            }
        }

        AsyncFunction("getRestingHeartRate") { (startMs: Double, endMs: Double, limit: Int) -> [[String: Any]] in
            guard let qt = HKQuantityType.quantityType(forIdentifier: .restingHeartRate) else { return [] }
            return try await self.querySamples(type: qt, start: startMs, end: endMs, limit: limit) { sample in
                ["value": sample.quantity.doubleValue(for: HKUnit(from: "count/min")),
                 "startDate": ThalloHealthKitModule.iso(sample.startDate), "endDate": ThalloHealthKitModule.iso(sample.endDate)]
            }
        }

        // Raw HR samples during a time window. Used to annotate past workouts
        // with avg / max HR and time-in-zones.
        AsyncFunction("getHeartRate") { (startMs: Double, endMs: Double, limit: Int) -> [[String: Any]] in
            guard let qt = HKQuantityType.quantityType(forIdentifier: .heartRate) else { return [] }
            return try await self.querySamples(type: qt, start: startMs, end: endMs, limit: limit) { sample in
                ["value": sample.quantity.doubleValue(for: HKUnit(from: "count/min")),
                 "startDate": ThalloHealthKitModule.iso(sample.startDate), "endDate": ThalloHealthKitModule.iso(sample.endDate)]
            }
        }

        // Menstrual flow samples. `value` is an integer 1-5 from
        // HKCategoryValueVaginalBleeding (unspecified, light, medium, heavy, none).
        AsyncFunction("getMenstrualFlow") { (startMs: Double, endMs: Double) -> [[String: Any]] in
            guard let ct = HKCategoryType.categoryType(forIdentifier: .menstrualFlow) else { return [] }
            return try await self.queryCategorySamples(type: ct, start: startMs, end: endMs) { sample in
                return [
                    "value": sample.value,
                    "startDate": ThalloHealthKitModule.iso(sample.startDate),
                    "endDate": ThalloHealthKitModule.iso(sample.endDate),
                ]
            }
        }

        AsyncFunction("getDailySteps") { (startMs: Double, endMs: Double) -> [[String: Any]] in
            guard let qt = HKQuantityType.quantityType(forIdentifier: .stepCount) else { return [] }
            return try await self.statisticsPerDay(type: qt, unit: .count(), start: startMs, end: endMs)
        }

        AsyncFunction("getWorkoutCount") { (startMs: Double, endMs: Double) -> Int in
            return try await self.countSamples(type: .workoutType(), start: startMs, end: endMs)
        }

        AsyncFunction("getSleepSamples") { (startMs: Double, endMs: Double) -> [[String: Any]] in
            guard let ct = HKCategoryType.categoryType(forIdentifier: .sleepAnalysis) else { return [] }
            return try await self.queryCategorySamples(type: ct, start: startMs, end: endMs) { sample in
                let val: String
                if #available(iOS 16.0, *) {
                    switch sample.value {
                    case HKCategoryValueSleepAnalysis.asleepCore.rawValue: val = "CORE"
                    case HKCategoryValueSleepAnalysis.asleepDeep.rawValue: val = "DEEP"
                    case HKCategoryValueSleepAnalysis.asleepREM.rawValue: val = "REM"
                    case HKCategoryValueSleepAnalysis.asleepUnspecified.rawValue: val = "ASLEEP"
                    case HKCategoryValueSleepAnalysis.awake.rawValue: val = "AWAKE"
                    default: val = "INBED"
                    }
                } else {
                    val = sample.value == 1 ? "ASLEEP" : "INBED"
                }
                return ["value": val, "startDate": ThalloHealthKitModule.iso(sample.startDate), "endDate": ThalloHealthKitModule.iso(sample.endDate)]
            }
        }

        AsyncFunction("getActiveEnergyBurned") { (startMs: Double, endMs: Double) -> [[String: Any]] in
            guard let qt = HKQuantityType.quantityType(forIdentifier: .activeEnergyBurned) else { return [] }
            return try await self.statisticsPerDay(type: qt, unit: .kilocalorie(), start: startMs, end: endMs)
        }

        AsyncFunction("getHRV") { (startMs: Double, endMs: Double, limit: Int) -> [[String: Any]] in
            guard let qt = HKQuantityType.quantityType(forIdentifier: .heartRateVariabilitySDNN) else { return [] }
            return try await self.querySamples(type: qt, start: startMs, end: endMs, limit: limit) { sample in
                ["value": sample.quantity.doubleValue(for: .secondUnit(with: .milli)),
                 "startDate": ThalloHealthKitModule.iso(sample.startDate), "endDate": ThalloHealthKitModule.iso(sample.endDate)]
            }
        }

        AsyncFunction("getVO2Max") { (startMs: Double, endMs: Double, limit: Int) -> [[String: Any]] in
            guard let qt = HKQuantityType.quantityType(forIdentifier: .vo2Max) else { return [] }
            let unit = HKUnit.literUnit(with: .milli).unitDivided(by: HKUnit.gramUnit(with: .kilo).unitMultiplied(by: .minute()))
            return try await self.querySamples(type: qt, start: startMs, end: endMs, limit: limit) { sample in
                ["value": sample.quantity.doubleValue(for: unit),
                 "startDate": ThalloHealthKitModule.iso(sample.startDate), "endDate": ThalloHealthKitModule.iso(sample.endDate)]
            }
        }

        AsyncFunction("getRespiratoryRate") { (startMs: Double, endMs: Double, limit: Int) -> [[String: Any]] in
            guard let qt = HKQuantityType.quantityType(forIdentifier: .respiratoryRate) else { return [] }
            return try await self.querySamples(type: qt, start: startMs, end: endMs, limit: limit) { sample in
                ["value": sample.quantity.doubleValue(for: HKUnit(from: "count/min")),
                 "startDate": ThalloHealthKitModule.iso(sample.startDate), "endDate": ThalloHealthKitModule.iso(sample.endDate)]
            }
        }

        AsyncFunction("getOxygenSaturation") { (startMs: Double, endMs: Double, limit: Int) -> [[String: Any]] in
            guard let qt = HKQuantityType.quantityType(forIdentifier: .oxygenSaturation) else { return [] }
            return try await self.querySamples(type: qt, start: startMs, end: endMs, limit: limit) { sample in
                ["value": sample.quantity.doubleValue(for: .percent()) * 100,
                 "startDate": ThalloHealthKitModule.iso(sample.startDate), "endDate": ThalloHealthKitModule.iso(sample.endDate)]
            }
        }

        AsyncFunction("getSleepingWristTemperature") { (startMs: Double, endMs: Double, limit: Int) -> [[String: Any]] in
            if #available(iOS 16.0, *) {
                guard let qt = HKQuantityType.quantityType(forIdentifier: .appleSleepingWristTemperature) else { return [] }
                return try await self.querySamples(type: qt, start: startMs, end: endMs, limit: limit) { sample in
                    ["value": sample.quantity.doubleValue(for: .degreeCelsius()),
                     "startDate": ThalloHealthKitModule.iso(sample.startDate), "endDate": ThalloHealthKitModule.iso(sample.endDate)]
                }
            }
            return []
        }

        AsyncFunction("getSleepingBreathingDisturbances") { (startMs: Double, endMs: Double, limit: Int) -> [[String: Any]] in
            if #available(iOS 18.0, *) {
                guard let qt = HKQuantityType.quantityType(forIdentifier: .appleSleepingBreathingDisturbances) else { return [] }
                return try await self.querySamples(type: qt, start: startMs, end: endMs, limit: limit) { sample in
                    var result: [String: Any] = [
                        "value": sample.quantity.doubleValue(for: .count()),
                        "startDate": ThalloHealthKitModule.iso(sample.startDate),
                        "endDate": ThalloHealthKitModule.iso(sample.endDate),
                    ]
                    if let classification = HKAppleSleepingBreathingDisturbancesClassification(classifying: sample.quantity) {
                        result["classification"] = classification == .elevated ? "elevated" : "not_elevated"
                    }
                    return result
                }
            }
            return []
        }

        AsyncFunction("getStandingHours") { (startMs: Double, endMs: Double) -> [[String: Any]] in
            guard let ct = HKCategoryType.categoryType(forIdentifier: .appleStandHour) else { return [] }
            return try await self.queryCategorySamples(type: ct, start: startMs, end: endMs) { sample in
                ["value": sample.value == HKCategoryValueAppleStandHour.stood.rawValue ? 1 : 0,
                 "startDate": ThalloHealthKitModule.iso(sample.startDate), "endDate": ThalloHealthKitModule.iso(sample.endDate)]
            }
        }

        AsyncFunction("getMindfulMinutes") { (startMs: Double, endMs: Double) -> [[String: Any]] in
            guard let ct = HKCategoryType.categoryType(forIdentifier: .mindfulSession) else { return [] }
            return try await self.queryCategorySamples(type: ct, start: startMs, end: endMs) { sample in
                let mins = sample.endDate.timeIntervalSince(sample.startDate) / 60.0
                return ["value": mins, "startDate": ThalloHealthKitModule.iso(sample.startDate), "endDate": ThalloHealthKitModule.iso(sample.endDate)]
            }
        }

        AsyncFunction("getTimeInDaylight") { (startMs: Double, endMs: Double, limit: Int) -> [[String: Any]] in
            if #available(iOS 17.0, *) {
                guard let qt = HKQuantityType.quantityType(forIdentifier: .timeInDaylight) else { return [] }
                return try await self.querySamples(type: qt, start: startMs, end: endMs, limit: limit) { sample in
                    var result: [String: Any] = [
                        "value": sample.quantity.doubleValue(for: .minute()),
                        "startDate": ThalloHealthKitModule.iso(sample.startDate),
                        "endDate": ThalloHealthKitModule.iso(sample.endDate),
                    ]
                    if let maxLight = sample.metadata?[HKMetadataKeyMaximumLightIntensity] as? HKQuantity {
                        result["maximumLightIntensityLux"] = maxLight.doubleValue(for: .lux())
                    }
                    return result
                }
            }
            return []
        }

        AsyncFunction("getBasalEnergyBurned") { (startMs: Double, endMs: Double) -> [[String: Any]] in
            guard let qt = HKQuantityType.quantityType(forIdentifier: .basalEnergyBurned) else { return [] }
            return try await self.statisticsPerDay(type: qt, unit: .kilocalorie(), start: startMs, end: endMs)
        }

        AsyncFunction("getDietaryEnergyConsumed") { (startMs: Double, endMs: Double) -> [[String: Any]] in
            guard let qt = HKQuantityType.quantityType(forIdentifier: .dietaryEnergyConsumed) else { return [] }
            return try await self.statisticsPerDay(type: qt, unit: .kilocalorie(), start: startMs, end: endMs)
        }

        AsyncFunction("getDietaryProtein") { (startMs: Double, endMs: Double) -> [[String: Any]] in
            guard let qt = HKQuantityType.quantityType(forIdentifier: .dietaryProtein) else { return [] }
            return try await self.statisticsPerDay(type: qt, unit: .gram(), start: startMs, end: endMs)
        }

        AsyncFunction("getDietaryCarbohydrates") { (startMs: Double, endMs: Double) -> [[String: Any]] in
            guard let qt = HKQuantityType.quantityType(forIdentifier: .dietaryCarbohydrates) else { return [] }
            return try await self.statisticsPerDay(type: qt, unit: .gram(), start: startMs, end: endMs)
        }

        AsyncFunction("getDietaryFatTotal") { (startMs: Double, endMs: Double) -> [[String: Any]] in
            guard let qt = HKQuantityType.quantityType(forIdentifier: .dietaryFatTotal) else { return [] }
            return try await self.statisticsPerDay(type: qt, unit: .gram(), start: startMs, end: endMs)
        }

        AsyncFunction("getWeight") { (startMs: Double, endMs: Double, limit: Int) -> [[String: Any]] in
            guard let qt = HKQuantityType.quantityType(forIdentifier: .bodyMass) else { return [] }
            return try await self.querySamples(type: qt, start: startMs, end: endMs, limit: limit) { sample in
                ["value": sample.quantity.doubleValue(for: .pound()),
                 "startDate": ThalloHealthKitModule.iso(sample.startDate), "endDate": ThalloHealthKitModule.iso(sample.endDate)]
            }
        }

        AsyncFunction("saveWorkout") { (
            startMs: Double,
            endMs: Double,
            activityType: String,
            kcal: Double?,
            distanceMiles: Double?,
            routeCoords: [[String: Any]]?
        ) -> Bool in
            // Phone-side workouts (lift sessions, live-tracker runs)
            // didn't land in Apple Health before — only watch-started
            // workouts via HKLiveWorkoutBuilder did. This writes the
            // session as an HKWorkout sample so it shows up in Fitness
            // / Activity rings.
            //
            // Uses HKWorkoutBuilder (deprecation-aware fallback to
            // HKWorkout init for older iOS deployment targets is not
            // needed here — Thallo's deployment target is iOS 16+ and
            // HKWorkoutBuilder is the preferred API). Call requires
            // `workoutType()` write authorisation, which Thallo
            // already requests.
            let (s, e) = ThalloHealthKitModule.dates(startMs, endMs)
            let type: HKWorkoutActivityType = self.activityTypeFromString(activityType)
            let config = HKWorkoutConfiguration()
            config.activityType = type
            // When the caller hands us a GPS route, the session was
            // outdoor — switch the location type so HK shows the route
            // on the Apple Fitness map. Otherwise default to indoor.
            let hasRoute = (routeCoords?.isEmpty == false)
            config.locationType = hasRoute ? .outdoor : .indoor

            let builder = HKWorkoutBuilder(healthStore: self.store, configuration: config, device: .local())
            // HKWorkoutRouteBuilder is created up-front so we can append
            // CLLocation samples after the workout's been added but
            // before finishWorkout completes. Apple's contract: route
            // builder must call finishRoute(with:metadata:) BEFORE
            // workoutBuilder.finishWorkout fires.
            let routeBuilder: HKWorkoutRouteBuilder? = hasRoute
                ? HKWorkoutRouteBuilder(healthStore: self.store, device: .local())
                : nil
            return try await withCheckedThrowingContinuation { cont in
                builder.beginCollection(withStart: s) { ok, err in
                    if let err { cont.resume(throwing: err); return }
                    guard ok else { cont.resume(returning: false); return }
                    var samples: [HKSample] = []
                    if let kcal {
                        let q = HKQuantity(unit: .kilocalorie(), doubleValue: kcal)
                        if let t = HKQuantityType.quantityType(forIdentifier: .activeEnergyBurned) {
                            samples.append(HKQuantitySample(type: t, quantity: q, start: s, end: e))
                        }
                    }
                    if let dist = distanceMiles {
                        let q = HKQuantity(unit: .mile(), doubleValue: dist)
                        if let t = self.distanceQuantityType(for: type) {
                            samples.append(HKQuantitySample(type: t, quantity: q, start: s, end: e))
                        }
                    }
                    // After endCollection + finishWorkout, attach the
                    // GPS route (if any) via HKWorkoutRouteBuilder so
                    // Apple Fitness shows the trail on the workout
                    // detail map. Routes must be associated with a
                    // saved HKWorkout, which is why we wait until
                    // finishWorkout's callback fires.
                    let attachRouteAndResume: (HKWorkout) -> Void = { workout in
                        guard let routeBuilder = routeBuilder, let coords = routeCoords, !coords.isEmpty else {
                            cont.resume(returning: true)
                            return
                        }
                        // Convert raw {lat, lon, t_ms, acc_m, alt_m, v_acc_m} dicts into
                        // CLLocation samples. iOS rejects routes whose
                        // timestamps fall outside the workout window, so
                        // clamp t_ms to [s, e] just in case GPS clock
                        // drifted relative to the workout clock.
                        let locations: [CLLocation] = coords.compactMap { dict in
                            guard let lat = ThalloHealthKitModule.number(dict["lat"]),
                                  let lon = ThalloHealthKitModule.number(dict["lon"]) else { return nil }
                            let ts: Date
                            if let tMs = ThalloHealthKitModule.number(dict["t_ms"]), tMs > 0 {
                                let clamped = min(max(tMs / 1000.0, s.timeIntervalSince1970), e.timeIntervalSince1970)
                                ts = Date(timeIntervalSince1970: clamped)
                            } else {
                                ts = s
                            }
                            let acc = ThalloHealthKitModule.number(dict["acc_m"]) ?? 5.0
                            let altitude = ThalloHealthKitModule.number(dict["alt_m"]) ?? 0.0
                            let verticalAccuracy = ThalloHealthKitModule.number(dict["v_acc_m"]) ?? -1.0
                            return CLLocation(
                                coordinate: CLLocationCoordinate2D(latitude: lat, longitude: lon),
                                altitude: altitude,
                                horizontalAccuracy: acc,
                                verticalAccuracy: verticalAccuracy,
                                timestamp: ts
                            )
                        }
                        if locations.isEmpty {
                            cont.resume(returning: true)
                            return
                        }
                        routeBuilder.insertRouteData(locations) { ok, err in
                            if let err {
                                NSLog("[ThalloHealthKit] insertRouteData failed: \(err.localizedDescription)")
                                cont.resume(returning: true)  // workout itself saved
                                return
                            }
                            guard ok else {
                                cont.resume(returning: true)  // workout itself saved
                                return
                            }
                            routeBuilder.finishRoute(with: workout, metadata: nil) { _, err in
                                if let err {
                                    NSLog("[ThalloHealthKit] finishRoute failed: \(err.localizedDescription)")
                                }
                                cont.resume(returning: true)
                            }
                        }
                    }
                    let finishCollection: () -> Void = {
                        builder.endCollection(withEnd: e) { ok, err in
                            if let err { cont.resume(throwing: err); return }
                            guard ok else { cont.resume(returning: false); return }
                            builder.finishWorkout { workout, err in
                                if let err { cont.resume(throwing: err); return }
                                guard let workout else { cont.resume(returning: false); return }
                                attachRouteAndResume(workout)
                            }
                        }
                    }
                    if samples.isEmpty {
                        finishCollection()
                    } else {
                        builder.add(samples) { _, err in
                            if let err { cont.resume(throwing: err); return }
                            finishCollection()
                        }
                    }
                }
            }
        }

        AsyncFunction("getWorkouts") { (startMs: Double, endMs: Double) -> [[String: Any]] in
            let (s, e) = ThalloHealthKitModule.dates(startMs, endMs)
            let pred = HKQuery.predicateForSamples(withStart: s, end: e, options: .strictStartDate)
            let sort = NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: false)
            return try await withCheckedThrowingContinuation { cont in
                let q = HKSampleQuery(sampleType: .workoutType(), predicate: pred, limit: HKObjectQueryNoLimit, sortDescriptors: [sort]) { _, results, err in
                    if let err { cont.resume(throwing: err); return }
                    let workouts = (results as? [HKWorkout]) ?? []
                    let mapped: [[String: Any]] = workouts.map { w in
                        var entry: [String: Any] = [
                            "activityType": Int(w.workoutActivityType.rawValue),
                            "activityName": ThalloHealthKitModule.workoutName(w.workoutActivityType),
                            "duration": w.duration / 60.0,
                            "startDate": ThalloHealthKitModule.iso(w.startDate),
                            "endDate": ThalloHealthKitModule.iso(w.endDate),
                        ]
                        if let cal = w.totalEnergyBurned?.doubleValue(for: .kilocalorie()) { entry["calories"] = cal }
                        if let dist = w.totalDistance?.doubleValue(for: .mile()) { entry["distanceMiles"] = dist }
                        return entry
                    }
                    cont.resume(returning: mapped)
                }
                self.store.execute(q)
            }
        }

        AsyncFunction("getWorkoutRoute") { (startMs: Double, endMs: Double) -> [String: Any]? in
            guard let workout = try await self.bestWorkoutOverlapping(startMs: startMs, endMs: endMs) else {
                return nil
            }
            return try await self.routeSummary(for: workout)
        }
    }

    // MARK: - Helpers

    private func activityAuthorizationStatus() -> String {
        switch CMMotionActivityManager.authorizationStatus() {
        case .notDetermined: return "notDetermined"
        case .restricted: return "restricted"
        case .denied: return "denied"
        case .authorized: return "authorized"
        @unknown default: return "unknown"
        }
    }

    private func handleActivityDetectionSample(_ activity: CMMotionActivity) {
        guard activity.confidence != .low else { return }
        let now = Date()
        guard let kind = dominantActivityKind(activity) else {
            if activityCandidateKind != nil {
                activityCandidateKind = nil
                activityCandidateStartedAt = nil
                emittedActivityCandidateKey = nil
                emitActivityDetection([
                    "event": "cleared",
                    "detectedAt": ThalloHealthKitModule.iso(now),
                    "source": "core_motion",
                ])
            }
            return
        }

        let sampleStart = activity.startDate <= now ? activity.startDate : now
        if activityCandidateKind != kind {
            activityCandidateKind = kind
            activityCandidateStartedAt = sampleStart
            emittedActivityCandidateKey = nil
        } else if let existing = activityCandidateStartedAt, sampleStart < existing {
            activityCandidateStartedAt = sampleStart
        }

        let startedAt = activityCandidateStartedAt ?? sampleStart
        let elapsed = max(0, now.timeIntervalSince(startedAt))
        guard elapsed >= activityDetectionThresholdSeconds(for: kind) else { return }

        let candidateKey = "\(kind)-\(Int(startedAt.timeIntervalSince1970 / 60.0))"
        guard emittedActivityCandidateKey != candidateKey else { return }
        emittedActivityCandidateKey = candidateKey
        emitActivityDetection([
            "event": "detected",
            "activity": kind,
            "confidence": activityConfidenceName(activity.confidence),
            "startedAt": ThalloHealthKitModule.iso(startedAt),
            "detectedAt": ThalloHealthKitModule.iso(now),
            "elapsedSeconds": Int(elapsed.rounded()),
            "source": "core_motion",
        ])
    }

    private func dominantActivityKind(_ activity: CMMotionActivity) -> String? {
        if activity.automotive || activity.stationary { return nil }
        if activity.cycling { return "cycling" }
        if activity.running { return "running" }
        if activity.walking { return "walking" }
        return nil
    }

    private func activityDetectionThresholdSeconds(for kind: String) -> TimeInterval {
        switch kind {
        case "running": return 2 * 60
        case "cycling": return 3 * 60
        default: return 6 * 60
        }
    }

    private func activityConfidenceName(_ confidence: CMMotionActivityConfidence) -> String {
        switch confidence {
        case .low: return "low"
        case .medium: return "medium"
        case .high: return "high"
        @unknown default: return "unknown"
        }
    }

    private func emitActivityDetection(_ body: [String: Any]) {
        DispatchQueue.main.async {
            self.sendEvent("activityDetection", body)
        }
    }

    private func objectType(for name: String) -> HKObjectType? {
        if name == "TimeInDaylight" {
            if #available(iOS 17.0, *) {
                return HKQuantityType.quantityType(forIdentifier: .timeInDaylight)
            }
            return nil
        }
        if name == "AppleSleepingWristTemperature" {
            if #available(iOS 16.0, *) {
                return HKQuantityType.quantityType(forIdentifier: .appleSleepingWristTemperature)
            }
            return nil
        }
        if name == "AppleSleepingBreathingDisturbances" {
            if #available(iOS 18.0, *) {
                return HKQuantityType.quantityType(forIdentifier: .appleSleepingBreathingDisturbances)
            }
            return nil
        }
        let map: [String: HKObjectType] = [
            "HeartRate": HKQuantityType.quantityType(forIdentifier: .heartRate)!,
            "RestingHeartRate": HKQuantityType.quantityType(forIdentifier: .restingHeartRate)!,
            "StepCount": HKQuantityType.quantityType(forIdentifier: .stepCount)!,
            "SleepAnalysis": HKCategoryType.categoryType(forIdentifier: .sleepAnalysis)!,
            "ActiveEnergyBurned": HKQuantityType.quantityType(forIdentifier: .activeEnergyBurned)!,
            "Workout": HKObjectType.workoutType(),
            "WorkoutRoute": HKSeriesType.workoutRoute(),
            "Weight": HKQuantityType.quantityType(forIdentifier: .bodyMass)!,
            "HeartRateVariabilitySDNN": HKQuantityType.quantityType(forIdentifier: .heartRateVariabilitySDNN)!,
            "VO2Max": HKQuantityType.quantityType(forIdentifier: .vo2Max)!,
            "RespiratoryRate": HKQuantityType.quantityType(forIdentifier: .respiratoryRate)!,
            "OxygenSaturation": HKQuantityType.quantityType(forIdentifier: .oxygenSaturation)!,
            "StandHour": HKCategoryType.categoryType(forIdentifier: .appleStandHour)!,
            "MindfulSession": HKCategoryType.categoryType(forIdentifier: .mindfulSession)!,
            "BasalEnergyBurned": HKQuantityType.quantityType(forIdentifier: .basalEnergyBurned)!,
            "MenstrualFlow": HKCategoryType.categoryType(forIdentifier: .menstrualFlow)!,
            "DietaryEnergyConsumed": HKQuantityType.quantityType(forIdentifier: .dietaryEnergyConsumed)!,
            "DietaryProtein": HKQuantityType.quantityType(forIdentifier: .dietaryProtein)!,
            "DietaryCarbohydrates": HKQuantityType.quantityType(forIdentifier: .dietaryCarbohydrates)!,
            "DietaryFatTotal": HKQuantityType.quantityType(forIdentifier: .dietaryFatTotal)!,
        ]
        return map[name]
    }

    /// Map our activity tag strings (matching `manualActivity.subtype`
    /// / focus labels) to `HKWorkoutActivityType`. Falls back to
    /// `.functionalStrengthTraining` for unknown lifts and `.other`
    /// for unrecognised non-lift activities.
    private func activityTypeFromString(_ raw: String) -> HKWorkoutActivityType {
        let s = raw.lowercased()
        if isMixedStrengthCardioActivity(s) { return .traditionalStrengthTraining }
        if s.contains("run") { return .running }
        if s.contains("walk") { return .walking }
        if s.contains("hike") { return .hiking }
        if s.contains("bike") || s.contains("cycl") || s == "ride" || s.contains("spin") { return .cycling }
        if s.contains("swim") { return .swimming }
        if s.contains("row") { return .rowing }
        if s.contains("ellipt") { return .elliptical }
        if s.contains("hiit") || s.contains("bootcamp") || s.contains("boot camp") || s.contains("boot-camp") || s.contains("interval") || s.contains("tabata") { return .highIntensityIntervalTraining }
        if s.contains("zone") || s.contains("cardio") || s.contains("conditioning") || s.contains("tempo") { return .mixedCardio }
        // Stair climber (machine) before generic "climb" so "stair climbing"
        // routes to .stairClimbing instead of .climbing (rock/bouldering).
        if s.contains("stair") { return .stairClimbing }
        if s.contains("climb") || s.contains("boulder") { return .climbing }
        if s.contains("yoga") { return .yoga }
        if s.contains("pilates") { return .pilates }
        if s.contains("circuit") || s.contains("cross") { return .crossTraining }
        if s.contains("core") { return .coreTraining }
        if s.contains("mobility") || s.contains("stretch") || s.contains("flex") { return .flexibility }
        if s.contains("dance") { return .socialDance }
        if s.contains("boxing") || s.contains("kickbox") || s.contains("martial") || s.contains("mma") { return .boxing }
        if s.contains("basketball") { return .basketball }
        if s.contains("soccer") { return .soccer }
        if s.contains("tennis") { return .tennis }
        if s.contains("pickleball") { return .pickleball }
        if s.contains("volley") { return .volleyball }
        if s.contains("golf") { return .golf }
        // Strength-shaped fallbacks. "lift" / "weight" / generic lift
        // archetype labels (push / pull / legs / upper / lower / full
        // body) all route here.
        if s.contains("lift") || s.contains("weight") || s.contains("strength") { return .traditionalStrengthTraining }
        if ["push", "pull", "legs", "upper", "lower", "full body", "full_body"].contains(where: s.contains) {
            return .traditionalStrengthTraining
        }
        return .functionalStrengthTraining
    }

    private func isMixedStrengthCardioActivity(_ s: String) -> Bool {
        guard s.contains("+ cardio") || s.contains("+cardio") else { return false }
        return ["push", "pull", "legs", "upper", "lower", "full body", "full_body", "lift", "strength", "weight"].contains { s.contains($0) }
    }

    private func distanceQuantityType(for type: HKWorkoutActivityType) -> HKQuantityType? {
        switch type {
        case .cycling:
            return HKQuantityType.quantityType(forIdentifier: .distanceCycling)
        case .swimming:
            return HKQuantityType.quantityType(forIdentifier: .distanceSwimming)
        case .running, .walking, .hiking:
            return HKQuantityType.quantityType(forIdentifier: .distanceWalkingRunning)
        default:
            return HKQuantityType.quantityType(forIdentifier: .distanceWalkingRunning)
        }
    }

    private static func workoutName(_ type: HKWorkoutActivityType) -> String {
        switch type {
        case .running: return "Running"
        case .cycling: return "Cycling"
        case .swimming: return "Swimming"
        case .walking: return "Walking"
        case .hiking: return "Hiking"
        case .yoga: return "Yoga"
        case .functionalStrengthTraining: return "Strength Training"
        case .traditionalStrengthTraining: return "Weight Training"
        case .highIntensityIntervalTraining: return "HIIT"
        case .crossTraining: return "Cross Training"
        case .elliptical: return "Elliptical"
        case .rowing: return "Rowing"
        case .stairClimbing: return "Stair Climbing"
        case .climbing: return "Climbing"
        case .pilates: return "Pilates"
        case .cardioDance: return "Cardio Dance"
        case .socialDance: return "Dance"
        case .cooldown: return "Cooldown"
        case .coreTraining: return "Core Training"
        case .flexibility: return "Flexibility"
        case .mixedCardio: return "Mixed Cardio"
        case .soccer: return "Soccer"
        case .basketball: return "Basketball"
        case .tennis: return "Tennis"
        case .pickleball: return "Pickleball"
        case .volleyball: return "Volleyball"
        case .boxing: return "Boxing"
        default: return "Workout"
        }
    }

    private static func iso(_ d: Date) -> String {
        ISO8601DateFormatter().string(from: d)
    }

    private static func dates(_ startMs: Double, _ endMs: Double) -> (Date, Date) {
        (Date(timeIntervalSince1970: startMs / 1000), Date(timeIntervalSince1970: endMs / 1000))
    }

    private static func number(_ value: Any?) -> Double? {
        if let d = value as? Double { return d }
        if let n = value as? NSNumber { return n.doubleValue }
        if let s = value as? String { return Double(s) }
        return nil
    }

    private func querySamples<T>(
        type: HKQuantityType, start: Double, end: Double, limit: Int,
        transform: @escaping (HKQuantitySample) -> T
    ) async throws -> [T] {
        let (s, e) = ThalloHealthKitModule.dates(start, end)
        let pred = HKQuery.predicateForSamples(withStart: s, end: e, options: .strictStartDate)
        let sort = NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: false)
        return try await withCheckedThrowingContinuation { cont in
            let q = HKSampleQuery(sampleType: type, predicate: pred, limit: limit, sortDescriptors: [sort]) { _, results, err in
                if let err { cont.resume(throwing: err); return }
                cont.resume(returning: (results as? [HKQuantitySample] ?? []).map(transform))
            }
            self.store.execute(q)
        }
    }

    private func queryCategorySamples<T>(
        type: HKCategoryType, start: Double, end: Double,
        transform: @escaping (HKCategorySample) -> T
    ) async throws -> [T] {
        let (s, e) = ThalloHealthKitModule.dates(start, end)
        let pred = HKQuery.predicateForSamples(withStart: s, end: e, options: .strictStartDate)
        let sort = NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: false)
        return try await withCheckedThrowingContinuation { cont in
            let q = HKSampleQuery(sampleType: type, predicate: pred, limit: HKObjectQueryNoLimit, sortDescriptors: [sort]) { _, results, err in
                if let err { cont.resume(throwing: err); return }
                cont.resume(returning: (results as? [HKCategorySample] ?? []).map(transform))
            }
            self.store.execute(q)
        }
    }

    private func queryWorkouts(startMs: Double, endMs: Double, options: HKQueryOptions = []) async throws -> [HKWorkout] {
        let (s, e) = ThalloHealthKitModule.dates(startMs, endMs)
        let pred = HKQuery.predicateForSamples(withStart: s, end: e, options: options)
        let sort = NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: false)
        return try await withCheckedThrowingContinuation { cont in
            let q = HKSampleQuery(sampleType: .workoutType(), predicate: pred, limit: HKObjectQueryNoLimit, sortDescriptors: [sort]) { _, results, err in
                if let err { cont.resume(throwing: err); return }
                cont.resume(returning: (results as? [HKWorkout]) ?? [])
            }
            self.store.execute(q)
        }
    }

    private func bestWorkoutOverlapping(startMs: Double, endMs: Double) async throws -> HKWorkout? {
        let bufferedStartMs = startMs - 5 * 60_000
        let bufferedEndMs = endMs + 5 * 60_000
        let workouts = try await queryWorkouts(startMs: bufferedStartMs, endMs: bufferedEndMs, options: [])
        let start = Date(timeIntervalSince1970: startMs / 1000)
        let end = Date(timeIntervalSince1970: endMs / 1000)
        return workouts.max { a, b in
            Self.overlapSeconds(a, start: start, end: end) < Self.overlapSeconds(b, start: start, end: end)
        }
    }

    private static func overlapSeconds(_ workout: HKWorkout, start: Date, end: Date) -> TimeInterval {
        max(0, min(workout.endDate, end).timeIntervalSince(max(workout.startDate, start)))
    }

    private func routeSummary(for workout: HKWorkout) async throws -> [String: Any]? {
        let rawLocations = try await routeLocations(for: workout)
        let locations = rawLocations.sorted { $0.timestamp < $1.timestamp }
        guard !locations.isEmpty else { return nil }
        let sampled = ThalloHealthKitModule.downsample(locations, limit: 12_000)
        var result: [String: Any] = [
            "routeCoords": sampled.map { ThalloHealthKitModule.routeCoordDictionary($0) },
        ]
        if let elevationGainFt = ThalloHealthKitModule.elevationGainFeet(locations) {
            result["elevationGainFt"] = elevationGainFt
        }
        return result
    }

    private func routeLocations(for workout: HKWorkout) async throws -> [CLLocation] {
        let routeType = HKSeriesType.workoutRoute()
        let pred = HKQuery.predicateForObjects(from: workout)
        let routes: [HKWorkoutRoute] = try await withCheckedThrowingContinuation { cont in
            let q = HKSampleQuery(sampleType: routeType, predicate: pred, limit: HKObjectQueryNoLimit, sortDescriptors: nil) { _, results, err in
                if let err { cont.resume(throwing: err); return }
                cont.resume(returning: (results as? [HKWorkoutRoute]) ?? [])
            }
            self.store.execute(q)
        }
        var locations: [CLLocation] = []
        for route in routes {
            // `self.` is required — the local `locations` array shadows the
            // `locations(for:)` instance method, so an unqualified call
            // resolves to the array and fails to compile.
            locations.append(contentsOf: try await self.locations(for: route))
        }
        return locations
    }

    private func locations(for route: HKWorkoutRoute) async throws -> [CLLocation] {
        try await withCheckedThrowingContinuation { cont in
            var collected: [CLLocation] = []
            var resumed = false
            let q = HKWorkoutRouteQuery(route: route) { _, locationsOrNil, done, err in
                if resumed { return }
                if let err {
                    resumed = true
                    cont.resume(throwing: err)
                    return
                }
                if let locationsOrNil {
                    collected.append(contentsOf: locationsOrNil)
                }
                if done {
                    resumed = true
                    cont.resume(returning: collected)
                }
            }
            self.store.execute(q)
        }
    }

    private static func routeCoordDictionary(_ loc: CLLocation) -> [String: Any] {
        var dict: [String: Any] = [
            "lat": loc.coordinate.latitude,
            "lon": loc.coordinate.longitude,
            "t_ms": loc.timestamp.timeIntervalSince1970 * 1000,
        ]
        if loc.horizontalAccuracy >= 0 { dict["acc_m"] = loc.horizontalAccuracy }
        if loc.verticalAccuracy >= 0 {
            dict["alt_m"] = loc.altitude
            dict["v_acc_m"] = loc.verticalAccuracy
        }
        return dict
    }

    private static func elevationGainFeet(_ locations: [CLLocation]) -> Int? {
        var gainMeters = 0.0
        var lastAlt: Double?
        for loc in locations where loc.verticalAccuracy >= 0 && loc.verticalAccuracy <= 30 {
            if let prev = lastAlt {
                let delta = loc.altitude - prev
                if delta >= 1.5 { gainMeters += delta }
            }
            lastAlt = loc.altitude
        }
        guard gainMeters > 0 else { return nil }
        return Int((gainMeters * 3.280839895).rounded())
    }

    private static func downsample<T>(_ items: [T], limit: Int) -> [T] {
        guard items.count > limit, limit > 1 else { return items }
        let step = Double(items.count - 1) / Double(limit - 1)
        return (0..<limit).map { items[Int((Double($0) * step).rounded())] }
    }

    private func countSamples(type: HKSampleType, start: Double, end: Double) async throws -> Int {
        let (s, e) = ThalloHealthKitModule.dates(start, end)
        let pred = HKQuery.predicateForSamples(withStart: s, end: e, options: .strictStartDate)
        return try await withCheckedThrowingContinuation { cont in
            let q = HKSampleQuery(sampleType: type, predicate: pred, limit: HKObjectQueryNoLimit, sortDescriptors: nil) { _, results, err in
                if let err { cont.resume(throwing: err); return }
                cont.resume(returning: results?.count ?? 0)
            }
            self.store.execute(q)
        }
    }

    private func statisticsPerDay(type: HKQuantityType, unit: HKUnit, start: Double, end: Double) async throws -> [[String: Any]] {
        let (s, e) = ThalloHealthKitModule.dates(start, end)
        let pred = HKQuery.predicateForSamples(withStart: s, end: e, options: .strictStartDate)
        let interval = DateComponents(day: 1)
        return try await withCheckedThrowingContinuation { cont in
            let q = HKStatisticsCollectionQuery(quantityType: type, quantitySamplePredicate: pred, options: .cumulativeSum, anchorDate: s, intervalComponents: interval)
            q.initialResultsHandler = { _, collection, err in
                if let err { cont.resume(throwing: err); return }
                var out: [[String: Any]] = []
                collection?.enumerateStatistics(from: s, to: e) { stats, _ in
                    let val = stats.sumQuantity()?.doubleValue(for: unit) ?? 0
                    out.append(["value": val, "startDate": ThalloHealthKitModule.iso(stats.startDate), "endDate": ThalloHealthKitModule.iso(stats.endDate)])
                }
                cont.resume(returning: out)
            }
            self.store.execute(q)
        }
    }
}
