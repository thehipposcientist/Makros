import ExpoModulesCore
import HealthKit

public class ThalloHealthKitModule: Module {
    private let store = HKHealthStore()

    public func definition() -> ModuleDefinition {
        Name("ThalloHealthKitModule")

        Function("isAvailable") { () -> Bool in
            HKHealthStore.isHealthDataAvailable()
        }

        AsyncFunction("requestAuthorization") { (readTypes: [String]) -> Bool in
            guard HKHealthStore.isHealthDataAvailable() else { return false }
            var types = Set<HKObjectType>()
            for name in readTypes {
                if let t = self.objectType(for: name) { types.insert(t) }
            }
            return try await withCheckedThrowingContinuation { cont in
                self.store.requestAuthorization(toShare: nil, read: types) { ok, err in
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

        AsyncFunction("getBasalEnergyBurned") { (startMs: Double, endMs: Double) -> [[String: Any]] in
            guard let qt = HKQuantityType.quantityType(forIdentifier: .basalEnergyBurned) else { return [] }
            return try await self.statisticsPerDay(type: qt, unit: .kilocalorie(), start: startMs, end: endMs)
        }

        AsyncFunction("saveWorkout") { (
            startMs: Double,
            endMs: Double,
            activityType: String,
            kcal: Double?,
            distanceMiles: Double?,
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
            // Strength sessions are mostly indoor; runs/walks default
            // to indoor as a safe choice (we don't have GPS).
            config.locationType = .indoor

            let builder = HKWorkoutBuilder(healthStore: self.store, configuration: config, device: .local())
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
                        if let t = HKQuantityType.quantityType(forIdentifier: .distanceWalkingRunning) {
                            samples.append(HKQuantitySample(type: t, quantity: q, start: s, end: e))
                        }
                    }
                    let finishCollection: () -> Void = {
                        builder.endCollection(withEnd: e) { ok, err in
                            if let err { cont.resume(throwing: err); return }
                            guard ok else { cont.resume(returning: false); return }
                            builder.finishWorkout { workout, err in
                                if let err { cont.resume(throwing: err); return }
                                cont.resume(returning: workout != nil)
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
    }

    // MARK: - Helpers

    private func objectType(for name: String) -> HKObjectType? {
        let map: [String: HKObjectType] = [
            "HeartRate": HKQuantityType.quantityType(forIdentifier: .heartRate)!,
            "RestingHeartRate": HKQuantityType.quantityType(forIdentifier: .restingHeartRate)!,
            "StepCount": HKQuantityType.quantityType(forIdentifier: .stepCount)!,
            "SleepAnalysis": HKCategoryType.categoryType(forIdentifier: .sleepAnalysis)!,
            "ActiveEnergyBurned": HKQuantityType.quantityType(forIdentifier: .activeEnergyBurned)!,
            "Workout": HKObjectType.workoutType(),
            "Weight": HKQuantityType.quantityType(forIdentifier: .bodyMass)!,
            "HeartRateVariabilitySDNN": HKQuantityType.quantityType(forIdentifier: .heartRateVariabilitySDNN)!,
            "VO2Max": HKQuantityType.quantityType(forIdentifier: .vo2Max)!,
            "RespiratoryRate": HKQuantityType.quantityType(forIdentifier: .respiratoryRate)!,
            "OxygenSaturation": HKQuantityType.quantityType(forIdentifier: .oxygenSaturation)!,
            "StandHour": HKCategoryType.categoryType(forIdentifier: .appleStandHour)!,
            "MindfulSession": HKCategoryType.categoryType(forIdentifier: .mindfulSession)!,
            "BasalEnergyBurned": HKQuantityType.quantityType(forIdentifier: .basalEnergyBurned)!,
            "MenstrualFlow": HKCategoryType.categoryType(forIdentifier: .menstrualFlow)!,
        ]
        return map[name]
    }

    /// Map our activity tag strings (matching `manualActivity.subtype`
    /// / focus labels) to `HKWorkoutActivityType`. Falls back to
    /// `.functionalStrengthTraining` for unknown lifts and `.other`
    /// for unrecognised non-lift activities.
    private func activityTypeFromString(_ raw: String) -> HKWorkoutActivityType {
        let s = raw.lowercased()
        if s.contains("run") { return .running }
        if s.contains("walk") { return .walking }
        if s.contains("hike") { return .hiking }
        if s.contains("bike") || s.contains("cycl") || s == "ride" { return .cycling }
        if s.contains("swim") { return .swimming }
        if s.contains("row") { return .rowing }
        if s.contains("ellipt") { return .elliptical }
        if s.contains("zone") || s.contains("cardio") || s.contains("conditioning") || s.contains("tempo") { return .mixedCardio }
        // Stair climber (machine) before generic "climb" so "stair climbing"
        // routes to .stairClimbing instead of .climbing (rock/bouldering).
        if s.contains("stair") { return .stairClimbing }
        if s.contains("climb") || s.contains("boulder") { return .climbing }
        if s.contains("yoga") { return .yoga }
        if s.contains("pilates") { return .pilates }
        if s.contains("hiit") || s.contains("interval") { return .highIntensityIntervalTraining }
        if s.contains("circuit") || s.contains("cross") { return .crossTraining }
        if s.contains("core") { return .coreTraining }
        if s.contains("mobility") || s.contains("stretch") || s.contains("flex") { return .flexibility }
        if s.contains("spin") { return .cardioDance }
        if s.contains("dance") { return .socialDance }
        if s.contains("boxing") { return .boxing }
        if s.contains("basketball") { return .basketball }
        if s.contains("soccer") { return .soccer }
        if s.contains("tennis") { return .tennis }
        if s.contains("pickleball") { return .pickleball }
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
        default: return "Workout"
        }
    }

    private static func iso(_ d: Date) -> String {
        ISO8601DateFormatter().string(from: d)
    }

    private static func dates(_ startMs: Double, _ endMs: Double) -> (Date, Date) {
        (Date(timeIntervalSince1970: startMs / 1000), Date(timeIntervalSince1970: endMs / 1000))
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
