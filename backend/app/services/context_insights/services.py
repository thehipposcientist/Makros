from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from statistics import mean
from typing import Any, Iterable, Mapping

from .privacy import is_sensitive_place_category
from .types import (
    Confidence,
    DailyFeatureSet,
    Insight,
    NextBestAction,
    OutdoorWindow,
    UserInsightPreferences,
)


BONE_SUPPORT_DISCLAIMER = "This reflects behavior patterns, not measured bone density."
SUN_SAFETY_MESSAGE = "Sun protection would be recommended if you were outside."

MEDICAL_DIAGNOSIS_WORDS = {
    "diagnose",
    "diagnosis",
    "osteopenia",
    "osteoporosis",
    "vitamin d dose",
    "vitamin d production",
}


def sun_exposure_source_label(source: str | None) -> str:
    labels = {
        "healthkit_daylight": "Apple Watch / HealthKit",
        "workout_route": "Workout route estimate",
        "activity_recognition": "Phone activity fallback",
        "coarse_location": "Phone coarse location fallback",
        "manual": "Manual correction",
    }
    return labels.get(str(source or "").strip().lower(), "Unavailable source")


def assert_context_insight_copy_is_safe(copy: str) -> bool:
    lowered = copy.lower()
    return "bone density score" not in lowered and not any(word in lowered for word in MEDICAL_DIAGNOSIS_WORDS)


def confidence_from_sources(source_count: int, coverage_days: int, window_days: int) -> Confidence:
    coverage = coverage_days / max(1, window_days)
    if source_count >= 3 and coverage >= 0.65:
        return "high"
    if source_count >= 2 and coverage >= 0.35:
        return "medium"
    return "low"


class BoneSupportInsightService:
    @staticmethod
    def analyze(user_id: int, features: Iterable[DailyFeatureSet], *, created_at: datetime | None = None) -> dict:
        days = list(features)
        strength_sessions = sum(day.strength_workout_count for day in days)
        weight_bearing_minutes = sum(day.weight_bearing_minutes for day in days)
        elevation_gain = sum(day.elevation_gain_meters for day in days)
        mobility_minutes = sum(day.mobility_minutes for day in days)
        daylight_minutes = sum(day.outdoor_daylight_minutes for day in days)
        recovery_scores = [day.recovery_score for day in days if day.recovery_score is not None]
        recovery_avg = mean(recovery_scores) if recovery_scores else None

        score = 0.0
        score += min(30, strength_sessions * 12)
        score += min(30, weight_bearing_minutes / 150 * 30)
        score += min(15, elevation_gain / 200 * 15)
        score += min(10, mobility_minutes / 60 * 10)
        score += min(10, daylight_minutes / 150 * 10)
        if recovery_avg is not None:
            score += 5 if recovery_avg >= 60 else max(0, recovery_avg / 60 * 5)
        score = round(max(0, min(100, score)))

        drivers = [
            ("strength training", strength_sessions * 12),
            ("walking, running, hiking, or stairs", weight_bearing_minutes / 150 * 30),
            ("elevation gain", elevation_gain / 200 * 15),
            ("balance and mobility", mobility_minutes / 60 * 10),
            ("outdoor daylight", daylight_minutes / 150 * 10),
        ]
        top_positive_driver = max(drivers, key=lambda item: item[1])[0] if days else "recent activity"
        opportunities = [
            ("Add one strength session", strength_sessions < 2),
            ("Add a 20-minute walk, run, hike, or stairs session", weight_bearing_minutes < 120),
            ("Add a short balance or mobility block", mobility_minutes < 40),
            ("Take one easy daylight walk", daylight_minutes < 90),
        ]
        biggest_opportunity = next((text for text, needed in opportunities if needed), "Keep your current mix consistent")
        recommended_action = biggest_opportunity
        confidence = confidence_from_sources(
            source_count=sum([
                strength_sessions > 0,
                weight_bearing_minutes > 0,
                mobility_minutes > 0,
                daylight_minutes > 0,
                bool(recovery_scores),
            ]),
            coverage_days=sum(1 for day in days if day.steps or day.strength_workout_count or day.sleep_duration_minutes),
            window_days=max(7, len(days)),
        )

        return {
            "weeklyScore": score,
            "topPositiveDriver": top_positive_driver,
            "biggestOpportunity": biggest_opportunity,
            "recommendedNextAction": recommended_action,
            "confidence": confidence,
            "dataSources": ["workouts", "activity", "elevation", "mobility", "daylight", "recovery"],
            "safetyNote": BONE_SUPPORT_DISCLAIMER,
        }

    @staticmethod
    def build_insight(user_id: int, features: Iterable[DailyFeatureSet], *, created_at: datetime | None = None) -> Insight:
        now = created_at or datetime.now(timezone.utc)
        result = BoneSupportInsightService.analyze(user_id, features, created_at=now)
        score = result["weeklyScore"]
        return Insight(
            id=f"bone_support:{user_id}:{now.date().isoformat()}",
            user_id=user_id,
            type="bone_supporting_behaviors",
            category="move",
            title="Bone-supporting behavior pattern",
            summary=f"Your weekly bone-supporting behavior score is estimated at {score}/100.",
            recommended_action=result["recommendedNextAction"],
            confidence=result["confidence"],
            data_sources=result["dataSources"],
            explanation=(
                f"This uses strength sessions, weight-bearing minutes, elevation, mobility, "
                f"daylight estimates, and available recovery data. The strongest driver was "
                f"{result['topPositiveDriver']}; the biggest opportunity is {result['biggestOpportunity'].lower()}."
            ),
            safety_note=result["safetyNote"],
            created_at=now,
            valid_until=now + timedelta(days=7),
            why="You enabled Move insights and have recent workout or activity signals.",
            priority=72 if score < 70 else 45,
            payload=result,
        )


class SunExposureInsightService:
    @staticmethod
    def analyze(user_id: int, segments: Iterable[Mapping[str, Any]], *, created_at: datetime | None = None) -> dict:
        rows = [row for row in segments if not is_sensitive_place_category(_get(row, "placeCategory", "place_category"))]
        likely_daylight = sum(_float(_get(row, "likelyOutdoorDaylightMinutes", "durationMinutes", "duration_minutes")) * _float(_get(row, "outdoorConfidence", "outdoor_confidence"), 1) for row in rows)
        open_sky = sum(_float(_get(row, "openSkyEquivalentMinutes", "open_sky_equivalent_minutes")) for row in rows)
        uv_weighted = uv_weight = 0.0
        lux_weighted = lux_weight = 0.0
        high_uv = sum(
            _float(_get(row, "durationMinutes", "duration_minutes")) * _float(_get(row, "outdoorConfidence", "outdoor_confidence"), 1)
            for row in rows
            if _float(_get(row, "uvIndexMax", "uv_index_max", "uvIndex", "uv_index")) >= 3
        )
        shaded_minutes = 0.0
        open_minutes = 0.0
        max_uv = 0.0
        source_names: set[str] = set()
        coverage_days: set[date] = set()
        for row in rows:
            max_uv = max(max_uv, _float(_get(row, "uvIndexMax", "uv_index_max", "uvIndex", "uv_index")))
            context = _get(row, "areaContext", "area_context") or {}
            sky = _float(_get(context, "skyExposureCoefficient", "sky_exposure_coefficient"), 0.5)
            minutes = _float(_get(row, "durationMinutes", "duration_minutes")) * _float(_get(row, "outdoorConfidence", "outdoor_confidence"), 1)
            uv_average = _float(_get(row, "uvIndexAverage", "uv_index_average", "uvIndex", "uv_index"))
            lux = _float(_get(row, "lightIntensityLux", "light_intensity_lux"))
            if minutes > 0 and uv_average > 0:
                uv_weighted += uv_average * minutes
                uv_weight += minutes
            if minutes > 0 and lux > 0:
                lux_weighted += lux * minutes
                lux_weight += minutes
            if sky >= 0.65:
                open_minutes += minutes
            else:
                shaded_minutes += minutes
            source = _get(row, "source")
            if source:
                source_names.add(str(source))
            start = _get(row, "startTime", "start_time")
            if isinstance(start, datetime):
                coverage_days.add(start.date())
            elif isinstance(start, str):
                try:
                    coverage_days.add(datetime.fromisoformat(start.replace("Z", "+00:00")).date())
                except ValueError:
                    pass

        confidence = confidence_from_sources(len(source_names), len(coverage_days) or len(rows), 7)
        source_labels = sorted({sun_exposure_source_label(source) for source in source_names})
        return {
            "likelyOutdoorDaylightMinutes": round(likely_daylight),
            "openSkyEquivalentMinutes": round(open_sky),
            "avgUvIndex": round(uv_weighted / uv_weight, 1) if uv_weight > 0 else 0,
            "avgLightIntensityLux": round(lux_weighted / lux_weight) if lux_weight > 0 else None,
            "highUvMinutes": round(high_uv),
            "shadeEstimate": "mostly bright" if open_minutes > shaded_minutes else "mostly shaded",
            "safetyMessage": SUN_SAFETY_MESSAGE if max_uv >= 3 else None,
            "confidence": confidence,
            "sourceLabels": source_labels or ["Unavailable source"],
        }

    @staticmethod
    def build_insight(user_id: int, segments: Iterable[Mapping[str, Any]], *, created_at: datetime | None = None) -> Insight:
        now = created_at or datetime.now(timezone.utc)
        result = SunExposureInsightService.analyze(user_id, segments, created_at=now)
        return Insight(
            id=f"sun_exposure:{user_id}:{now.date().isoformat()}",
            user_id=user_id,
            type="sun_exposure_context",
            category="environment",
            title="Estimated outdoor daylight context",
            summary=(
                f"You had about {result['likelyOutdoorDaylightMinutes']} minutes of daylight "
                f"with average UV Index {result['avgUvIndex']}."
            ),
            recommended_action=(
                "Use sun protection if you are outside during higher-UV windows."
                if result["safetyMessage"]
                else "Keep using logged outdoor activity to improve daylight estimates."
            ),
            confidence=result["confidence"],
            data_sources=list(result["sourceLabels"]) + ["UV Index", "light intensity"],
            explanation=(
                "This uses labeled daylight sources, optional Apple light-intensity metadata, "
                "and UV context for the same time ranges."
            ),
            safety_note="This does not estimate vitamin D or claim exact sun exposure.",
            created_at=now,
            valid_until=now + timedelta(days=1),
            why="You enabled Environment insights and permitted daylight/environment context.",
            priority=70 if result["highUvMinutes"] >= 20 else 40,
            payload=result,
        )


class OutdoorWorkoutPlannerService:
    @staticmethod
    def plan(windows: Iterable[OutdoorWindow], *, preferred_workout_type: str | None = None, recovery_score: float | None = None) -> dict:
        window_list = list(windows)
        scored = []
        for window in window_list:
            flags = OutdoorWorkoutPlannerService.risk_flags(window, recovery_score=recovery_score)
            penalty = len(flags) * 20
            if "storm" in flags:
                penalty += 50
            if "heat" in flags or "poor_aqi" in flags:
                penalty += 35
            scored.append((100 - penalty, window, flags))
        if not scored:
            return {
                "bestWorkoutWindow": None,
                "riskFlags": ["no_data"],
                "recommendation": "indoor_recommended",
                "reason": "No outdoor window data is available.",
            }
        scored.sort(key=lambda item: item[0], reverse=True)
        best_score, best, flags = scored[0]
        all_windows_risky = all(score < 60 for score, _, _ in scored)
        if "low_recovery" in flags:
            recommendation = "recovery_suggested"
        elif all_windows_risky:
            recommendation = "indoor_recommended"
        elif window_list and scored[0][1] != window_list[0]:
            recommendation = "shift_time"
        else:
            recommendation = "outdoor_ok"
        return {
            "bestWorkoutWindow": {
                "startTime": best.start_time.isoformat(),
                "endTime": best.end_time.isoformat(),
            },
            "riskFlags": flags,
            "recommendation": recommendation,
            "reason": OutdoorWorkoutPlannerService._reason(flags, recommendation, preferred_workout_type),
        }

    @staticmethod
    def risk_flags(window: OutdoorWindow, *, recovery_score: float | None = None) -> list[str]:
        flags: list[str] = []
        if (window.uv_index or 0) >= 6:
            flags.append("high_uv")
        if (window.air_quality_index or 0) >= 101:
            flags.append("poor_aqi")
        if (window.temperature_f or 0) >= 92:
            flags.append("heat")
        if window.temperature_f is not None and window.temperature_f <= 32:
            flags.append("cold")
        if window.storm_risk or (window.precipitation_probability or 0) >= 0.7:
            flags.append("storm")
        score = recovery_score if recovery_score is not None else window.recovery_score
        if score is not None and score < 45:
            flags.append("low_recovery")
        return flags

    @staticmethod
    def _reason(flags: list[str], recommendation: str, preferred_workout_type: str | None) -> str:
        label = preferred_workout_type or "workout"
        if recommendation == "outdoor_ok":
            return f"The {label} window has no major environment flags from the available data."
        if recommendation == "shift_time":
            return f"A different {label} window has fewer weather, UV, AQI, or recovery flags."
        if recommendation == "recovery_suggested":
            return "Recovery is below baseline, so an easier session is a better fit today."
        return "Available outdoor windows carry elevated environment or recovery flags."


class RecoveryInsightService:
    @staticmethod
    def analyze(
        *,
        sleep_duration_minutes: int | None = None,
        hrv: float | None = None,
        hrv_baseline: float | None = None,
        resting_hr: float | None = None,
        resting_hr_baseline: float | None = None,
        workout_load: float | None = None,
        baseline_workout_load: float | None = None,
        recent_activity_minutes: int = 0,
        travel_timezone_shift_hours: float | None = None,
    ) -> dict:
        score = 70.0
        drivers: list[tuple[str, float]] = []
        if sleep_duration_minutes is not None and sleep_duration_minutes < 390:
            penalty = 25 if sleep_duration_minutes < 330 else 15
            score -= penalty
            drivers.append(("short sleep", penalty))
        if hrv is not None and hrv_baseline and hrv < hrv_baseline * 0.85:
            score -= 15
            drivers.append(("HRV below baseline", 15))
        if resting_hr is not None and resting_hr_baseline and resting_hr > resting_hr_baseline + 6:
            score -= 15
            drivers.append(("resting heart rate above baseline", 15))
        if workout_load is not None and baseline_workout_load and workout_load > baseline_workout_load * 1.25:
            score -= 20
            drivers.append(("workout load above baseline", 20))
        if travel_timezone_shift_hours and abs(travel_timezone_shift_hours) >= 3:
            score -= 10
            drivers.append(("recent travel or time-zone shift", 10))
        if recent_activity_minutes < 20:
            score += 5
        score = max(0, min(100, score))
        top_driver = max(drivers, key=lambda item: item[1])[0] if drivers else "recent signals are near baseline"
        label = "ready" if score >= 70 else "cautious" if score >= 45 else "low"
        intensity = "normal" if label == "ready" else "moderate" if label == "cautious" else "light"
        suggestion = "Keep training flexible and prioritize a consistent bedtime tonight."
        if label == "low":
            suggestion = "Keep training light today; if unusual symptoms persist, consider rest or clinician discussion."
        source_count = sum([
            sleep_duration_minutes is not None,
            hrv is not None and hrv_baseline is not None,
            resting_hr is not None and resting_hr_baseline is not None,
            workout_load is not None and baseline_workout_load is not None,
            travel_timezone_shift_hours is not None,
        ])
        confidence: Confidence = "low"
        if len(drivers) >= 2 and source_count >= 3:
            confidence = "high"
        elif drivers or source_count >= 2:
            confidence = "medium"
        return {
            "recoveryLabel": label,
            "score": round(score),
            "topDriver": top_driver,
            "recommendedTrainingIntensity": intensity,
            "sleepRecoverySuggestion": suggestion,
            "confidence": confidence,
        }


class LifestyleInsightService:
    @staticmethod
    def analyze(
        *,
        lifestyle_logs: Iterable[Any],
        latest: DailyFeatureSet | None = None,
        baseline_days: Iterable[DailyFeatureSet] = (),
    ) -> dict | None:
        rows = sorted(
            list(lifestyle_logs),
            key=lambda row: _get(row, "localDate", "local_date", default=date.min),
        )
        if not rows:
            return None
        recent = rows[-1]
        factors: list[str] = []
        if _get(recent, "stressLevel", "stress_level") == "high":
            factors.append("high stress")
        illness = _get(recent, "illnessState", "illness_state")
        if illness in {"rundown", "sick"}:
            factors.append("feeling sick" if illness == "sick" else "feeling rundown")
        alcohol = _get(recent, "alcoholLevel", "alcohol_level")
        drinks = _float(_get(recent, "alcoholDrinks", "alcohol_drinks"))
        if alcohol not in {None, "", "none"} or drinks > 0:
            factors.append("alcohol")
        cannabis = _get(recent, "cannabisLevel", "cannabis_level")
        if cannabis not in {None, "", "none"}:
            factors.append("cannabis")
        if bool(_get(recent, "lateCaffeine", "late_caffeine")) or _get(recent, "caffeineTiming", "caffeine_timing") in {"evening", "late"}:
            factors.append("late caffeine")
        if _get(recent, "appetite") == "high":
            factors.append("high appetite")
        bowel_count = _get(recent, "bowelMovementCount", "bowel_movement_count")
        bowel_consistency = _get(recent, "bowelConsistency", "bowel_consistency")
        if bowel_count == 0 or bowel_consistency in {"loose", "hard", "mixed"}:
            factors.append("bowel pattern")
        if not factors:
            return None

        baseline = list(baseline_days)
        hrv_baseline = _avg([day.hrv for day in baseline if day.hrv is not None])
        rhr_baseline = _avg([day.resting_heart_rate for day in baseline if day.resting_heart_rate is not None])
        anomalies: list[str] = []
        if latest and latest.sleep_duration_minutes is not None and latest.sleep_duration_minutes < 390:
            anomalies.append("shorter sleep")
        if latest and latest.hrv is not None and hrv_baseline and latest.hrv < hrv_baseline * 0.85:
            anomalies.append("lower HRV")
        if latest and latest.resting_heart_rate is not None and rhr_baseline and latest.resting_heart_rate > rhr_baseline + 6:
            anomalies.append("higher resting heart rate")
        if latest and latest.recovery_score is not None and latest.recovery_score < 60:
            anomalies.append("lower readiness")

        context = ", ".join(factors[:3])
        target = ", ".join(anomalies[:3]) if anomalies else "today's recovery or nutrition pattern"
        return {
            "contextFactors": factors,
            "anomalies": anomalies,
            "summary": f"{context.capitalize()} may be contributing to {target}.",
            "confidence": "medium" if anomalies else "low",
        }

    @staticmethod
    def build_insight(
        user_id: int,
        *,
        lifestyle_logs: Iterable[Any],
        latest: DailyFeatureSet | None = None,
        baseline_days: Iterable[DailyFeatureSet] = (),
        created_at: datetime | None = None,
    ) -> Insight | None:
        now = created_at or datetime.now(timezone.utc)
        result = LifestyleInsightService.analyze(
            lifestyle_logs=lifestyle_logs,
            latest=latest,
            baseline_days=baseline_days,
        )
        if not result:
            return None
        return Insight(
            id=f"lifestyle_context:{user_id}:{now.date().isoformat()}",
            user_id=user_id,
            type="lifestyle_context",
            category="recover",
            title="Lifestyle context",
            summary=str(result["summary"]),
            recommended_action="Keep today flexible and watch whether the same factor repeats with similar signals.",
            confidence=result["confidence"],
            data_sources=["lifestyle factors", "sleep", "HRV", "resting heart rate", "nutrition"],
            explanation=(
                "This uses optional private logs as explanatory context only. "
                "It highlights possible contributors only."
            ),
            safety_note="This is wellness context, not medical advice.",
            created_at=now,
            valid_until=now + timedelta(days=1),
            why="You logged optional lifestyle context and enabled Recovery insights.",
            priority=70 if result["anomalies"] else 42,
            payload=result,
        )


class RouteLoadInsightService:
    @staticmethod
    def analyze(
        *,
        distance_miles: float,
        elevation_gain_meters: float = 0.0,
        pace_min_per_mile: float | None = None,
        heart_rate_avg: float | None = None,
        temperature_f: float | None = None,
        terrain: str | None = None,
    ) -> dict:
        score = distance_miles * 10 + elevation_gain_meters * 0.08
        if pace_min_per_mile and pace_min_per_mile < 8:
            score += 10
        if heart_rate_avg and heart_rate_avg >= 150:
            score += 12
        if temperature_f and temperature_f >= 85:
            score += 8
        if terrain in {"trail", "hilly", "sand", "snow"}:
            score += 8
        score = round(max(0, min(100, score)))
        label = "easy" if score < 35 else "moderate" if score < 65 else "hard"
        supports = ["cardio"]
        if elevation_gain_meters >= 60 or terrain in {"trail", "hilly", "stairs"}:
            supports.append("bone-loading")
        if score < 35:
            supports.append("recovery")
        return {
            "routeLoadScore": score,
            "label": label,
            "why": f"This route looked {label} based on distance, elevation, pace, heart rate, weather, and terrain where available.",
            "supports": supports,
            "confidence": "high" if heart_rate_avg is not None else "medium",
        }


class CommuteHealthInsightService:
    @staticmethod
    def analyze(features: Iterable[DailyFeatureSet]) -> dict:
        days = list(features)
        active_commute = sum(day.active_commute_minutes or 0 for day in days)
        steps_with_commute = [day.steps for day in days if (day.active_commute_minutes or 0) > 0]
        steps_without_commute = [day.steps for day in days if not (day.active_commute_minutes or 0)]
        pattern = "No clear commute pattern yet."
        if steps_with_commute and steps_without_commute and mean(steps_with_commute) > mean(steps_without_commute) + 1000:
            pattern = "Active commute days are likely linked with higher step totals."
        tweak = "Try parking farther away or adding one transit stop of walking on one commute day."
        if active_commute >= 90:
            tweak = "Keep one active commute anchor this week and protect sleep on long commute days."
        return {
            "activeCommuteMinutes": active_commute,
            "commuteEffectPattern": pattern,
            "suggestedCommuteTweak": tweak,
            "confidence": "medium" if active_commute > 0 else "low",
        }


class SocialWellnessInsightService:
    @staticmethod
    def analyze(
        *,
        opt_in: bool,
        mutual_opt_in: bool,
        group_workouts: int = 0,
        social_activity_count: int = 0,
        prior_social_activity_count: int | None = None,
        local_event_available: bool = False,
        friend_locations: list[str] | None = None,
    ) -> dict:
        if not opt_in or not mutual_opt_in:
            return {
                "socialActivityTrend": "Social insights are off until mutual opt-in is enabled.",
                "groupWorkoutConsistency": "unknown",
                "accountabilitySuggestion": "Invite a friend to opt in before using social context.",
                "localEventSuggestion": None,
                "confidence": "low",
            }
        trend = "social activity is steady"
        if prior_social_activity_count is not None and social_activity_count < prior_social_activity_count:
            trend = "social activity is lower than usual"
        elif prior_social_activity_count is not None and social_activity_count > prior_social_activity_count:
            trend = "social activity is higher than usual"
        consistency = "consistent" if group_workouts >= 2 else "building"
        event = "Consider a public local fitness event this week." if local_event_available else None
        return {
            "socialActivityTrend": trend,
            "groupWorkoutConsistency": consistency,
            "accountabilitySuggestion": "Schedule one shared workout or send one check-in this week.",
            "localEventSuggestion": event,
            "confidence": "medium" if social_activity_count or group_workouts else "low",
        }


class KeystoneHabitInsightService:
    @staticmethod
    def detect(features: Iterable[DailyFeatureSet]) -> dict:
        days = list(features)
        daylight_days = [day for day in days if day.outdoor_daylight_minutes >= 15]
        other_days = [day for day in days if day.outdoor_daylight_minutes < 15]
        habit = "No keystone habit detected yet"
        evidence = "More repeated daily feature sets are needed before pattern insights can be shown."
        experiment = "Log consistently for another week."
        confidence: Confidence = "low"
        if len(daylight_days) >= 3 and len(other_days) >= 3:
            sleep_with = mean([day.sleep_duration_minutes or 0 for day in daylight_days])
            sleep_without = mean([day.sleep_duration_minutes or 0 for day in other_days])
            steps_with = mean([day.steps for day in daylight_days])
            steps_without = mean([day.steps for day in other_days])
            if sleep_with >= sleep_without + 20 and steps_with >= steps_without + 800:
                habit = "Morning or daylight walks"
                evidence = (
                    "Daylight walking days appear linked with better sleep duration "
                    "and higher step consistency in your recent data."
                )
                experiment = "Try 3 daylight walks this week and watch sleep and step consistency."
                confidence = "medium"
        return {
            "detectedKeystoneHabit": habit,
            "supportingEvidence": evidence,
            "recommendedExperiment": experiment,
            "confidence": confidence,
        }


class NextBestActionService:
    @staticmethod
    def pick(
        insights: Iterable[Insight],
        *,
        user_goals: Iterable[str] | None = None,
        preferences: UserInsightPreferences | None = None,
    ) -> NextBestAction:
        active = [insight for insight in insights if insight.dismissed_at is None]
        if not active:
            return NextBestAction(
                primary_action="Keep logging today so Thallo can find useful patterns.",
                reason="No active context-aware insights are available.",
                expected_benefit="Better data coverage improves future confidence.",
            )
        ranked = sorted(active, key=NextBestActionService._rank, reverse=True)
        primary = ranked[0]
        secondary = ranked[1].recommended_action if len(ranked) > 1 else None
        return NextBestAction(
            primary_action=primary.recommended_action,
            reason=primary.summary,
            expected_benefit=primary.explanation,
            insight_id=primary.id,
            secondary_action=secondary,
        )

    @staticmethod
    def _rank(insight: Insight) -> tuple[int, int]:
        confidence_rank = {"low": 0, "medium": 8, "high": 14}[insight.confidence]
        return (insight.priority + confidence_rank, -len(insight.recommended_action))


def generate_context_insights(
    user_id: int,
    *,
    preferences: UserInsightPreferences,
    features: Iterable[DailyFeatureSet],
    sun_segments: Iterable[Mapping[str, Any]] = (),
    lifestyle_logs: Iterable[Any] = (),
    social_summary: Mapping[str, Any] | None = None,
    created_at: datetime | None = None,
) -> list[Insight]:
    now = created_at or datetime.now(timezone.utc)
    days = list(features)
    insights: list[Insight] = []
    if preferences.enable_move_insights:
        insights.append(BoneSupportInsightService.build_insight(user_id, days[-7:] or days, created_at=now))
    if preferences.enable_environment_insights and preferences.use_weather_environment_data:
        segments = list(sun_segments)
        if segments:
            insights.append(SunExposureInsightService.build_insight(user_id, segments, created_at=now))
    if preferences.enable_recovery_insights:
        latest = days[-1] if days else None
        baseline_days = days[:-1] if latest else days
        recovery = RecoveryInsightService.analyze(
            sleep_duration_minutes=latest.sleep_duration_minutes if latest else None,
            hrv=latest.hrv if latest else None,
            hrv_baseline=_avg([day.hrv for day in baseline_days if day.hrv is not None]),
            resting_hr=latest.resting_heart_rate if latest else None,
            resting_hr_baseline=_avg([day.resting_heart_rate for day in baseline_days if day.resting_heart_rate is not None]),
            workout_load=latest.workout_load if latest else None,
            baseline_workout_load=_avg([day.workout_load for day in baseline_days if day.workout_load is not None]),
            recent_activity_minutes=sum(day.active_minutes for day in days[-3:]),
        )
        insights.append(_recovery_to_insight(user_id, recovery, now))
        lifestyle = LifestyleInsightService.build_insight(
            user_id,
            lifestyle_logs=lifestyle_logs,
            latest=latest,
            baseline_days=baseline_days,
            created_at=now,
        )
        if lifestyle:
            insights.append(lifestyle)
    if preferences.enable_social_insights and preferences.use_social_context and social_summary:
        social = SocialWellnessInsightService.analyze(
            opt_in=True,
            mutual_opt_in=bool(social_summary.get("mutualOptIn", True)),
            group_workouts=int(social_summary.get("groupWorkouts", 0) or 0),
            social_activity_count=int(social_summary.get("socialActivityCount", 0) or 0),
            prior_social_activity_count=social_summary.get("priorSocialActivityCount"),
            local_event_available=bool(social_summary.get("localEventAvailable", False)),
        )
        insights.append(_social_to_insight(user_id, social, now))
    if preferences.enable_pattern_insights and len(days) >= 14:
        habit = KeystoneHabitInsightService.detect(days)
        insights.append(_habit_to_insight(user_id, habit, now))
    return [insight for insight in insights if assert_context_insight_copy_is_safe(_insight_text(insight))]


def rollup_daily_features(
    *,
    user_id: int,
    start_date: date,
    end_date: date,
    health_rows: Iterable[Any] = (),
    sleep_rows: Iterable[Any] = (),
    workout_rows: Iterable[Any] = (),
    sun_rows: Iterable[Any] = (),
) -> list[DailyFeatureSet]:
    by_day: dict[date, dict[str, Any]] = defaultdict(lambda: {
        "steps": 0,
        "active_minutes": 0,
        "strength_workout_count": 0,
        "weight_bearing_minutes": 0,
        "mobility_minutes": 0,
        "elevation_gain_meters": 0.0,
        "outdoor_daylight_minutes": 0,
        "open_sky_equivalent_minutes": 0,
        "high_uv_minutes": 0,
        "sleep_duration_minutes": None,
        "sleep_consistency_score": None,
        "resting_heart_rate": None,
        "hrv": None,
        "workout_load": None,
        "recovery_score": None,
        "social_activity_count": None,
        "active_commute_minutes": None,
        "sedentary_block_minutes": None,
    })
    cursor = start_date
    while cursor <= end_date:
        by_day[cursor]
        cursor += timedelta(days=1)

    for row in health_rows:
        day = getattr(row, "snapshot_date", None)
        if day not in by_day:
            continue
        by_day[day]["steps"] = int(getattr(row, "steps", None) or 0)
        by_day[day]["active_minutes"] = int(getattr(row, "workout_minutes", None) or 0)
        by_day[day]["resting_heart_rate"] = getattr(row, "resting_hr", None)
        by_day[day]["hrv"] = getattr(row, "hrv_ms", None)
        by_day[day]["recovery_score"] = getattr(row, "readiness_score", None)

    for row in sleep_rows:
        day = getattr(row, "night_date", None)
        if day not in by_day:
            continue
        hours = getattr(row, "total_hours", None)
        by_day[day]["sleep_duration_minutes"] = int(hours * 60) if hours is not None else None
        by_day[day]["sleep_consistency_score"] = getattr(row, "score", None)
        by_day[day]["resting_heart_rate"] = by_day[day]["resting_heart_rate"] or getattr(row, "resting_hr", None)
        by_day[day]["hrv"] = by_day[day]["hrv"] or getattr(row, "hrv_ms", None)

    for row in workout_rows:
        day = getattr(row, "workout_date", None)
        if day not in by_day:
            continue
        category = str(getattr(row, "activity_category", None) or "").lower()
        subtype = str(getattr(row, "activity_subtype", None) or "").lower()
        focus = str(getattr(row, "focus_label", "") or "").lower()
        minutes = int((getattr(row, "duration_seconds", None) or 0) / 60)
        if category == "strength" or focus in {"push", "pull", "legs", "full body", "upper body", "lower body"}:
            by_day[day]["strength_workout_count"] += 1
        if category in {"cardio", "active", "sport"} or subtype in {"walk", "run", "hike", "stair"}:
            by_day[day]["weight_bearing_minutes"] += minutes
        if category in {"mobility", "recovery"} or subtype in {"yoga", "stretching", "pilates"}:
            by_day[day]["mobility_minutes"] += minutes
        details = getattr(row, "activity_details", None) or {}
        gain_ft = _float(details.get("elevationGainFt"))
        by_day[day]["elevation_gain_meters"] += gain_ft * 0.3048
        load = minutes
        if str(getattr(row, "activity_intensity", "") or "").lower() == "hard":
            load *= 1.35
        by_day[day]["workout_load"] = (by_day[day]["workout_load"] or 0) + load

    for row in sun_rows:
        start = getattr(row, "start_time", None)
        day = start.date() if isinstance(start, datetime) else None
        if day not in by_day:
            continue
        minutes = _float(getattr(row, "duration_minutes", 0)) * _float(getattr(row, "outdoor_confidence", 0), 0)
        by_day[day]["outdoor_daylight_minutes"] += round(minutes)
        by_day[day]["open_sky_equivalent_minutes"] += round(_float(getattr(row, "open_sky_equivalent_minutes", 0)))
        if _float(getattr(row, "uv_index_max", 0)) >= 3:
            by_day[day]["high_uv_minutes"] += round(minutes)

    return [
        DailyFeatureSet(user_id=user_id, date=day, **values)
        for day, values in sorted(by_day.items())
    ]


def _recovery_to_insight(user_id: int, recovery: Mapping[str, Any], now: datetime) -> Insight:
    label = recovery["recoveryLabel"]
    return Insight(
        id=f"recovery_context:{user_id}:{now.date().isoformat()}",
        user_id=user_id,
        type="recovery_context",
        category="recover",
        title="Recovery context",
        summary=f"Recovery looks {label} based on available sleep, HRV, resting heart rate, and load signals.",
        recommended_action=(
            "Keep training light; recovery is below baseline."
            if label == "low"
            else "Use moderate intensity and stop short of max-effort sets."
            if label == "cautious"
            else "Train as planned and keep your normal sleep routine."
        ),
        confidence=recovery["confidence"],
        data_sources=["sleep", "HRV", "resting heart rate", "workout load"],
        explanation=f"The top driver was {recovery['topDriver']}. This is wellness guidance, not medical advice.",
        safety_note="If unusual symptoms are persistent or concerning, consider rest or clinician discussion.",
        created_at=now,
        valid_until=now + timedelta(days=1),
        why="You enabled Recovery insights and have recent recovery or load signals.",
        priority=85 if label == "low" else 62 if label == "cautious" else 35,
        payload=dict(recovery),
    )


def _social_to_insight(user_id: int, social: Mapping[str, Any], now: datetime) -> Insight:
    return Insight(
        id=f"social_wellness:{user_id}:{now.date().isoformat()}",
        user_id=user_id,
        type="social_wellness",
        category="connect",
        title="Social activity pattern",
        summary=str(social["socialActivityTrend"]),
        recommended_action=str(social["accountabilitySuggestion"]),
        confidence=social["confidence"],
        data_sources=["mutual opt-in friend activity", "group workouts"],
        explanation="This uses opt-in social activity counts only and never exact friend locations.",
        created_at=now,
        valid_until=now + timedelta(days=7),
        why="You enabled Social insights and mutual opt-in social context is available.",
        priority=50,
        payload=dict(social),
    )


def _habit_to_insight(user_id: int, habit: Mapping[str, Any], now: datetime) -> Insight:
    return Insight(
        id=f"keystone_habit:{user_id}:{now.date().isoformat()}",
        user_id=user_id,
        type="keystone_habit",
        category="improve",
        title="Possible keystone habit",
        summary=str(habit["supportingEvidence"]),
        recommended_action=str(habit["recommendedExperiment"]),
        confidence=habit["confidence"],
        data_sources=["daily feature sets", "sleep", "steps", "daylight"],
        explanation="This uses correlation language from repeated daily patterns and does not claim causation.",
        created_at=now,
        valid_until=now + timedelta(days=7),
        why="You enabled Pattern insights and have multiple weeks of daily feature sets.",
        priority=54 if habit["detectedKeystoneHabit"] != "No keystone habit detected yet" else 25,
        payload=dict(habit),
    )


def _insight_text(insight: Insight) -> str:
    return " ".join([
        insight.title,
        insight.summary,
        insight.recommended_action,
        insight.explanation,
        insight.safety_note or "",
    ])


def _avg(values: Iterable[float | None]) -> float | None:
    clean = [float(value) for value in values if value is not None]
    return mean(clean) if clean else None


def _float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except Exception:
        return default


def _get(mapping: Any, *keys: str, default: Any = None) -> Any:
    for key in keys:
        if isinstance(mapping, Mapping) and key in mapping:
            return mapping[key]
        if hasattr(mapping, key):
            return getattr(mapping, key)
    return default
