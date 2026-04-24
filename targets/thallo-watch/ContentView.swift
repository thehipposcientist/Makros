// Root view.
//
// Top-level TabView (page style) has two primary pages:
//   • Today's workout (Start / Skip / Active-handoff) — default page
//   • Today's meals   (check-off list with macros) — swipe right
// Third page only while a workout is active — the rich
// ActiveWorkoutView with exercise, rest timer, and HR.
//
// The active-workout state is tracked on this view:
//   • `active` = true when the USER tapped Start on the watch OR the
//     phone pushed `status: active`. Either way, we show the active UI.
//   • `active` = false when the user taps End on the watch OR the
//     phone pushes a terminal status (completed/skipped/scheduled).
// That lets Start/Skip sync bidirectionally — phone and watch can each
// originate the action and the other side mirrors.

import SwiftUI

struct ContentView: View {
    @EnvironmentObject var conn: ConnectivityStore
    @EnvironmentObject var theme: ThemeStore

    @State private var active: Bool = false
    @StateObject private var heartRate: HeartRateStore = HeartRateStore()
    // Show a brief "← swipe →" hint on the first launch the user
    // sees, then never again (persisted in UserDefaults). Covers the
    // "I didn't know there were pages" discoverability gap.
    @State private var showSwipeHint: Bool = !UserDefaults.standard.bool(forKey: "watchSwipeHintShown")

    var body: some View {
        ZStack {
            theme.background.ignoresSafeArea()
            if active, let workout = conn.workout {
                ActiveWorkoutView(
                    workout: workout,
                    hr: heartRate,
                    onEndWorkout: {
                        // End workout — writes to Health AND tells the
                        // phone to finalize its workout state (logs
                        // completed sets, shows completion banner).
                        active = false
                        heartRate.end()
                        conn.sendCommand("end_workout")
                    },
                    onCancelWorkout: {
                        // Cancel — discard the session on both ends.
                        // Tear down HR without finishWorkout() so
                        // nothing lands in Health, and tell the phone
                        // to drop its in-progress state.
                        active = false
                        heartRate.discard()
                        conn.sendCommand("cancel_workout")
                    }
                )
            } else {
                TabView {
                    TodayView(workout: conn.workout, onStart: {
                        active = true
                        heartRate.start()
                        conn.sendCommand("start_workout")
                    }, onSkip: {
                        conn.sendCommand("skip_workout")
                    })
                    MealsView(meals: conn.meals)
                    SupplementsView()
                }
                .tabViewStyle(.page)
                // watchOS doesn't expose `.indexViewStyle(.page(backgroundDisplayMode:))`
                // (that API is iOS-only). The default page-style
                // TabView already shows page indicators on watchOS.
                // The swipe-hint pill below covers first-run
                // discoverability, which is the whole reason that
                // modifier was here in the first place.
                .overlay(alignment: .top) {
                    if showSwipeHint {
                        SwipeHintPill()
                            .transition(.opacity)
                            .onAppear {
                                // Auto-dismiss after 2.5 s so it doesn't
                                // linger on subsequent launches.
                                DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) {
                                    withAnimation(.easeOut(duration: 0.3)) {
                                        showSwipeHint = false
                                    }
                                    UserDefaults.standard.set(true, forKey: "watchSwipeHintShown")
                                }
                            }
                    }
                }
            }
        }
        .onReceive(conn.$theme) { palette in theme.palette = palette }
        // React to phone-pushed status changes so the watch mirrors
        // whatever the phone is doing. If phone starts the workout,
        // we flip into the active UI; if phone skips or completes,
        // we unwind any local active state.
        .onReceive(conn.$workout) { w in
            guard let w = w else { return }
            switch w.status {
            case .active:
                if !active {
                    active = true
                    heartRate.start()
                }
            case .completed, .skipped, .rest, .scheduled:
                if active {
                    active = false
                    heartRate.end()
                }
            }
        }
    }
}

// ─── Today's workout ────────────────────────────────────────────────

private struct TodayView: View {
    let workout: WatchWorkout?
    let onStart: () -> Void
    let onSkip: () -> Void

    @EnvironmentObject var theme: ThemeStore
    // Pull meals from the same store so we can render a nutrition
    // score chip below the readiness chip without needing another
    // payload. The meals day carries a `score: Int?` populated by
    // the phone's /meals/score endpoint.
    @EnvironmentObject var conn: ConnectivityStore

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                logoHeader
                if let workout = workout {
                    workoutBody(workout)
                } else {
                    emptyPrompt
                }
            }
            .padding(10)
        }
    }

    // Small Thallo wordmark at the top — anchors the view and
    // matches the phone's brand. Simple text treatment with the
    // theme primary color so it tints per palette.
    private var logoHeader: some View {
        HStack(spacing: 6) {
            Image(systemName: "sparkles")
                .font(.system(size: 11, weight: .bold))
                .foregroundColor(theme.primary)
            Text("THALLO")
                .font(.system(size: 11, weight: .heavy))
                .tracking(2.2)
                .foregroundColor(theme.primary)
            Spacer()
        }
        .padding(.bottom, 2)
    }

    private var emptyPrompt: some View {
        VStack(spacing: 10) {
            Image(systemName: "iphone")
                .font(.system(size: 28))
                .foregroundColor(theme.textMuted)
            Text("Open Thallo")
                .font(.headline)
                .foregroundColor(theme.textPrimary)
            Text("Launch the iPhone app once so your workout syncs over.")
                .font(.caption2)
                .foregroundColor(theme.textMuted)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 10)
        }
        .padding(.vertical, 20)
    }

    @ViewBuilder
    private func workoutBody(_ workout: WatchWorkout) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            statusHeader(workout)

            // Skipped / rest / completed days don't need the exercise
            // list or the Start button — show only the status card.
            if workout.status == .scheduled || workout.status == .active {
                exerciseList(workout)
                actionButtons(workout)
            } else {
                terminalMessage(workout)
            }
        }
    }

    private func statusHeader(_ workout: WatchWorkout) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Text(topLabel(for: workout.status))
                    .font(.system(size: 9, weight: .bold))
                    .tracking(1.2)
                    .foregroundColor(statusColor(for: workout.status))
                if workout.status != .scheduled {
                    statusPill(workout.status)
                }
            }
            Text(workout.focus)
                .font(.system(size: 22, weight: .heavy))
                .foregroundColor(theme.textPrimary)
                .lineLimit(2)
            if workout.status == .scheduled || workout.status == .active {
                HStack(spacing: 6) {
                    Image(systemName: "clock")
                        .font(.system(size: 10))
                    Text("\(workout.durationMinutes) min · \(workout.exercises.count) exercises")
                        .font(.system(size: 11))
                }
                .foregroundColor(theme.textSecondary)
                // Readiness + Nutrition chips — side-by-side compact
                // row. Each is color-coded by tier so a glance tells
                // the user whether to push training / how their
                // nutrition is trending today. Both are optional —
                // chips hide when data isn't available.
                HStack(spacing: 6) {
                    if let r = workout.readiness {
                        let color = r >= 70 ? theme.success
                            : r >= 40 ? theme.warning : theme.error
                        HStack(spacing: 4) {
                            Image(systemName: "bolt.fill")
                                .font(.system(size: 9))
                            Text("\(r) READY")
                                .font(.system(size: 10, weight: .heavy))
                                .tracking(0.3)
                        }
                        .foregroundColor(color)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 3)
                        .background(color.opacity(0.15))
                        .cornerRadius(6)
                    }
                    if let n = conn.meals?.score {
                        let color = n >= 70 ? theme.success
                            : n >= 45 ? theme.warning : theme.error
                        HStack(spacing: 4) {
                            Image(systemName: "fork.knife")
                                .font(.system(size: 9))
                            Text("\(n) FUEL")
                                .font(.system(size: 10, weight: .heavy))
                                .tracking(0.3)
                        }
                        .foregroundColor(color)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 3)
                        .background(color.opacity(0.15))
                        .cornerRadius(6)
                    }
                }
                .padding(.top, 2)
            }
        }
    }

    private func statusPill(_ status: WatchWorkoutStatus) -> some View {
        Text(statusPillLabel(status))
            .font(.system(size: 9, weight: .heavy))
            .tracking(0.5)
            .foregroundColor(statusColor(for: status))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(statusColor(for: status).opacity(0.18))
            .cornerRadius(6)
    }

    private func topLabel(for status: WatchWorkoutStatus) -> String {
        switch status {
        case .scheduled: return "TODAY"
        case .active:    return "IN PROGRESS"
        case .completed: return "TODAY"
        case .skipped:   return "TODAY"
        case .rest:      return "REST DAY"
        }
    }

    private func statusPillLabel(_ status: WatchWorkoutStatus) -> String {
        switch status {
        case .scheduled: return ""
        case .active:    return "ACTIVE"
        case .completed: return "DONE"
        case .skipped:   return "SKIPPED"
        case .rest:      return "REST"
        }
    }

    private func statusColor(for status: WatchWorkoutStatus) -> Color {
        switch status {
        case .scheduled, .active: return theme.primary
        case .completed:          return theme.success
        case .skipped, .rest:     return theme.textMuted
        }
    }

    private func exerciseList(_ workout: WatchWorkout) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(workout.exercises.enumerated()), id: \.element.id) { idx, ex in
                HStack(alignment: .top, spacing: 8) {
                    Text("\(idx + 1)")
                        .font(.system(size: 10, weight: .heavy, design: .rounded))
                        .foregroundColor(theme.primary)
                        .frame(width: 18, height: 18)
                        .background(theme.primary.opacity(0.18))
                        .clipShape(Circle())
                    VStack(alignment: .leading, spacing: 2) {
                        Text(ex.name)
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundColor(theme.textPrimary)
                            .lineLimit(2)
                        detailLine(for: ex)
                    }
                }
                .padding(.vertical, 4)
                .padding(.horizontal, 6)
                .background(theme.surface.opacity(0.6))
                .cornerRadius(8)
            }
        }
        .padding(.top, 4)
    }

    private func actionButtons(_ workout: WatchWorkout) -> some View {
        VStack(spacing: 6) {
            if workout.status == .scheduled {
                Button(action: onStart) {
                    HStack {
                        Image(systemName: "play.circle.fill")
                        Text("Start").fontWeight(.bold)
                    }
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(.plain)
                .padding(.vertical, 9)
                .background(theme.primary)
                .foregroundColor(theme.background)
                .cornerRadius(10)
                Button(action: onSkip) {
                    HStack {
                        Image(systemName: "forward.fill")
                        Text("Skip today")
                    }
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(.plain)
                .padding(.vertical, 9)
                .background(theme.surfaceRaised)
                .foregroundColor(theme.textSecondary)
                .cornerRadius(10)
            } else if workout.status == .active {
                Button(action: onStart) {
                    HStack {
                        Image(systemName: "arrow.right.circle.fill")
                        Text("Rejoin workout").fontWeight(.bold)
                    }
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(.plain)
                .padding(.vertical, 9)
                .background(theme.primary)
                .foregroundColor(theme.background)
                .cornerRadius(10)
            }
        }
        .padding(.top, 4)
    }

    @ViewBuilder
    private func terminalMessage(_ workout: WatchWorkout) -> some View {
        VStack(spacing: 8) {
            Image(systemName: workout.status == .completed ? "checkmark.seal.fill"
                  : workout.status == .skipped ? "moon.fill"
                  : "bed.double.fill")
                .font(.system(size: 28))
                .foregroundColor(statusColor(for: workout.status))
            Text(terminalCaption(workout.status))
                .font(.system(size: 12, weight: .semibold))
                .foregroundColor(theme.textSecondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 24)
    }

    private func terminalCaption(_ status: WatchWorkoutStatus) -> String {
        switch status {
        case .completed: return "Workout done for today"
        case .skipped:   return "You skipped today"
        case .rest:      return "Rest day — take it easy"
        default:         return ""
        }
    }

    @ViewBuilder
    private func detailLine(for ex: WatchExercise) -> some View {
        let parts: [String] = {
            var p: [String] = ["\(ex.sets) × \(ex.reps)"]
            if let eq = ex.equipment, !eq.isEmpty {
                let pretty = eq
                    .split(separator: ",")
                    .map { $0.trimmingCharacters(in: .whitespaces)
                            .replacingOccurrences(of: "_", with: " ")
                            .capitalized }
                    .joined(separator: ", ")
                p.append(pretty)
            }
            if let w = ex.plannedTargetWeightLbs, w > 0 {
                p.append("\(Int(w)) lb")
            }
            return p
        }()
        Text(parts.joined(separator: " · "))
            .font(.system(size: 10))
            .foregroundColor(theme.textMuted)
            .lineLimit(2)
    }
}

// ─── Meals ──────────────────────────────────────────────────────────

private struct MealsView: View {
    let meals: WatchMealsDay?
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var conn: ConnectivityStore

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 6) {
                    Image(systemName: "fork.knife")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundColor(theme.primary)
                    Text("TODAY'S MEALS")
                        .font(.system(size: 11, weight: .heavy))
                        .tracking(1.8)
                        .foregroundColor(theme.primary)
                    Spacer()
                }
                if let meals = meals {
                    macroSummary(meals)
                    if meals.meals.isEmpty {
                        emptyMeals
                    } else {
                        mealList(meals)
                    }
                } else {
                    emptyPrompt
                }
            }
            .padding(10)
        }
    }

    private func macroSummary(_ meals: WatchMealsDay) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .lastTextBaseline, spacing: 4) {
                Text("\(meals.actual.calories)")
                    .font(.system(size: 26, weight: .heavy, design: .rounded))
                    .foregroundColor(theme.textPrimary)
                Text("/ \(meals.targets.calories) kcal")
                    .font(.system(size: 10))
                    .foregroundColor(theme.textMuted)
                Spacer()
                // Nutrition Score chip — same tier thresholds as the
                // phone's NutritionCard: 70+/45+/else.
                if let s = meals.score {
                    let color = s >= 70 ? theme.success
                        : s >= 45 ? theme.warning : theme.error
                    Text("\(s)")
                        .font(.system(size: 13, weight: .heavy))
                        .foregroundColor(color)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 3)
                        .background(color.opacity(0.18))
                        .cornerRadius(6)
                }
            }
            HStack(spacing: 10) {
                macroLine(label: "P", actual: meals.actual.proteinG, target: meals.targets.proteinG, color: theme.primary)
                macroLine(label: "C", actual: meals.actual.carbsG,   target: meals.targets.carbsG,   color: theme.warning)
                macroLine(label: "F", actual: meals.actual.fatG,     target: meals.targets.fatG,     color: theme.success)
            }
        }
        .padding(10)
        .background(theme.surface)
        .cornerRadius(10)
    }

    private func macroLine(label: String, actual: Int, target: Int, color: Color) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label)
                .font(.system(size: 9, weight: .heavy))
                .foregroundColor(color)
            Text("\(actual)")
                .font(.system(size: 12, weight: .bold))
                .foregroundColor(theme.textPrimary)
            Text("/\(target)g")
                .font(.system(size: 9))
                .foregroundColor(theme.textMuted)
        }
    }

    private func mealList(_ meals: WatchMealsDay) -> some View {
        VStack(spacing: 6) {
            ForEach(meals.meals) { m in
                Button {
                    // Optimistic: flip the check locally so the tick
                    // + macro totals update instantly. Phone authors
                    // the next push and overrides if needed.
                    conn.toggleMealLocal(mealType: m.mealType)
                    conn.sendCommand("toggle_meal", payload: [
                        "mealType": m.mealType,
                        "check": !m.checked,
                    ])
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: m.checked ? "checkmark.circle.fill" : "circle")
                            .font(.system(size: 18))
                            .foregroundColor(m.checked ? theme.success : theme.textMuted)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(m.name)
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundColor(theme.textPrimary)
                                .lineLimit(1)
                            Text("\(m.calories) cal · \(m.proteinG)g P")
                                .font(.system(size: 10))
                                .foregroundColor(theme.textMuted)
                        }
                        Spacer()
                    }
                    .padding(10)
                    .background(theme.surface)
                    .cornerRadius(10)
                }
                .buttonStyle(.plain)
            }
        }
    }

    private var emptyMeals: some View {
        Text("No meals logged yet today")
            .font(.system(size: 11))
            .foregroundColor(theme.textMuted)
            .padding(.vertical, 14)
    }

    private var emptyPrompt: some View {
        Text("Open Thallo on your iPhone to sync today's meals.")
            .font(.system(size: 11))
            .foregroundColor(theme.textMuted)
            .multilineTextAlignment(.center)
            .padding(.vertical, 24)
    }
}

// ─── Swipe hint pill ────────────────────────────────────────────────

/// Small primary-tinted hint that appears once per install at the top
/// of the root TabView to teach the swipe gesture. Auto-dismisses
/// after a few seconds and is persisted so it won't re-appear.
private struct SwipeHintPill: View {
    @EnvironmentObject var theme: ThemeStore
    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "arrow.left.and.right")
                .font(.system(size: 9, weight: .heavy))
            Text("SWIPE FOR MORE")
                .font(.system(size: 9, weight: .heavy))
                .tracking(0.8)
        }
        .foregroundColor(theme.background)
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(theme.primary)
        .cornerRadius(8)
        .padding(.top, 4)
    }
}

// ─── Supplements tab ────────────────────────────────────────────────

private struct SupplementsView: View {
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var conn: ConnectivityStore

    var body: some View {
        ZStack {
            theme.background.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Text("SUPPLEMENTS")
                            .font(.system(size: 10, weight: .heavy))
                            .tracking(1.0)
                            .foregroundColor(theme.primary)
                        Spacer()
                        Text("today")
                            .font(.system(size: 9))
                            .foregroundColor(theme.textMuted)
                    }

                    if let list = conn.supplements?.items, !list.isEmpty {
                        let pending = list.filter { !$0.taken && !$0.skipped }
                        if pending.count >= 2 {
                            Button {
                                conn.takeAllSupplementsLocal()
                                conn.sendCommand("take_all_supplements")
                            } label: {
                                HStack(spacing: 4) {
                                    Image(systemName: "checkmark.circle.fill")
                                        .font(.system(size: 12))
                                    Text("Take all (\(pending.count))")
                                        .font(.system(size: 12, weight: .heavy))
                                }
                                .foregroundColor(theme.background)
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 8)
                                .background(theme.primary)
                                .cornerRadius(9)
                            }
                            .buttonStyle(.plain)
                        }
                        ForEach(list) { s in
                            Button {
                                conn.toggleSupplementLocal(id: s.id)
                                conn.sendCommand(
                                    "toggle_supplement",
                                    payload: ["id": s.id, "taken": !s.taken],
                                )
                            } label: {
                                HStack(spacing: 8) {
                                    Image(systemName: s.taken
                                        ? "checkmark.circle.fill"
                                        : (s.skipped ? "xmark.circle" : "circle"))
                                        .font(.system(size: 18))
                                        .foregroundColor(s.taken ? theme.success : theme.textMuted)
                                    VStack(alignment: .leading, spacing: 1) {
                                        Text(s.name)
                                            .font(.system(size: 12, weight: .semibold))
                                            .foregroundColor(theme.textPrimary)
                                            .lineLimit(1)
                                        if let dose = s.dose, !dose.isEmpty {
                                            Text(dose)
                                                .font(.system(size: 10))
                                                .foregroundColor(theme.textMuted)
                                        }
                                    }
                                    Spacer()
                                }
                                .padding(10)
                                .background(theme.surface)
                                .cornerRadius(10)
                            }
                            .buttonStyle(.plain)
                        }
                    } else {
                        Text("Nothing scheduled today.")
                            .font(.system(size: 11))
                            .foregroundColor(theme.textMuted)
                            .padding(.vertical, 24)
                    }
                }
                .padding(10)
            }
        }
    }
}
