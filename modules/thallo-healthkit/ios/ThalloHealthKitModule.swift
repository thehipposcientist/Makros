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
                 "startDate": self.iso(sample.startDate), "endDate": self.iso(sample.endDate)]
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
                    val = sample.value == HKCategoryValueSleepAnalysis.asleepUnspecified.rawValue ? "ASLEEP" : "INBED"
                }
                return ["value": val, "startDate": self.iso(sample.startDate), "endDate": self.iso(sample.endDate)]
            }
        }

        AsyncFunction("getActiveEnergyBurned") { (startMs: Double, endMs: Double) -> [[String: Any]] in
            guard let qt = HKQuantityType.quantityType(forIdentifier: .activeEnergyBurned) else { return [] }
            return try await self.statisticsPerDay(type: qt, unit: .kilocalorie(), start: startMs, end: endMs)
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
        ]
        return map[name]
    }

    private func iso(_ d: Date) -> String {
        ISO8601DateFormatter().string(from: d)
    }

    private func dates(_ startMs: Double, _ endMs: Double) -> (Date, Date) {
        (Date(timeIntervalSince1970: startMs / 1000), Date(timeIntervalSince1970: endMs / 1000))
    }

    private func querySamples<T>(
        type: HKQuantityType, start: Double, end: Double, limit: Int,
        transform: @escaping (HKQuantitySample) -> T
    ) async throws -> [T] {
        let (s, e) = dates(start, end)
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
        let (s, e) = dates(start, end)
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
        let (s, e) = dates(start, end)
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
        let (s, e) = dates(start, end)
        let pred = HKQuery.predicateForSamples(withStart: s, end: e, options: .strictStartDate)
        let interval = DateComponents(day: 1)
        return try await withCheckedThrowingContinuation { cont in
            let q = HKStatisticsCollectionQuery(quantityType: type, quantitySamplePredicate: pred, options: .cumulativeSum, anchorDate: s, intervalComponents: interval)
            q.initialResultsHandler = { _, collection, err in
                if let err { cont.resume(throwing: err); return }
                var out: [[String: Any]] = []
                collection?.enumerateStatistics(from: s, to: e) { stats, _ in
                    let val = stats.sumQuantity()?.doubleValue(for: unit) ?? 0
                    out.append(["value": val, "startDate": self.iso(stats.startDate), "endDate": self.iso(stats.endDate)])
                }
                cont.resume(returning: out)
            }
            self.store.execute(q)
        }
    }
}
