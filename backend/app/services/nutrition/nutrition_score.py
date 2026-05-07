"""Daily Nutrition Score — unified scoring pipeline.

Produces a single 0-100 Nutrition Score from three sub-scores:
  1. Adherence (30-45%): calorie + protein alignment against targets
  2. Food Quality (30-40%): fiber, added sugar, sat fat, sodium, processing,
     plant diversity, omega-3 signal
  3. Micronutrient Coverage (20-30%): priority-6 micros (D, calcium, iron,
     potassium, magnesium, B12)

Design principles:
  - Missing data reduces confidence, not score
  - Incomplete logging is acknowledged, not punished as poor eating
  - Micronutrient estimates are presented as estimated, not precise
  - Reads precomputed gut-derived signals (processing mix, plant diversity,
    omega-3 servings) from DailyNutritionMetrics instead of recomputing —
    so Food Quality never contradicts the Gut & Plants insight card

Bump SCORE_VERSION when the formula changes so the client can invalidate
cached scores.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

SCORE_VERSION = 4   # v4 scores projected plans instead of logged meal totals


# ─── RDA targets (adults, general) ───────────────────────────────────────────

RDA = {
    "fiber_g": 28,
    "calcium_mg": 1000,
    "iron_mg": 18,           # female RDA; male=8 via sex override
    "potassium_mg": 4700,
    "magnesium_mg": 420,
    "vitamin_d_mcg": 20,
    "vitamin_b12_mcg": 2.4,
    "omega_3_g": 1.6,
    "zinc_mg": 11,
    "selenium_mcg": 55,
    "folate_mcg": 400,
    # Kept for display only — not in priority-6
    "vitamin_c_mg": 90,
    "vitamin_a_mcg": 900,
}

# Priority-6 micros checked for the coverage score. Vitamin C dropped because
# it's trivially hit and tells us nothing actionable.
KEY_MICROS = [
    "calcium_mg", "iron_mg", "potassium_mg", "magnesium_mg",
    "vitamin_d_mcg", "vitamin_b12_mcg",
]

# Resilience-flag micros — surfaced via the recovery_flags service, not the
# main Nutrition Score. Listed here so RDA lookups stay in one place.
RESILIENCE_MICROS = ["magnesium_mg", "zinc_mg", "vitamin_d_mcg", "selenium_mcg"]


# ─── Daily nutrition indicators ──────────────────────────────────────────────

@dataclass
class NutritionIndicators:
    """Raw daily indicators before scoring.

    Macro + logging fields come from meal totals; the processing/diversity
    /omega-3 signals come pre-computed from DailyNutritionMetrics. Any value
    left at its default is treated as "missing" by the scorer, which pulls
    that sub-pillar toward neutral rather than penalizing.
    """
    # Macros
    calories_logged: float = 0
    calories_target: float = 0
    protein_logged: float = 0
    protein_target: float = 0
    # Food Quality inputs
    fiber_g: float = 0
    added_sugar_g: float = 0
    saturated_fat_g: float = 0
    sodium_mg: float = 0
    minimally_processed_pct: float = 0      # 0-100
    ultra_processed_pct: float = 0          # 0-100
    distinct_plant_foods: int = 0
    omega3_servings: float = 0
    seafood_servings_weekly: float = 0      # rolled in from 7d window
    # Logging + micro coverage
    meals_logged: int = 0
    meals_expected: int = 3
    micronutrients: dict[str, float] = field(default_factory=dict)
    food_count: int = 0
    foods_with_micros: int = 0
    hydration_logged: bool = False

    @property
    def logging_completeness(self) -> float:
        if self.meals_expected <= 0:
            return 0.0
        return min(1.0, self.meals_logged / self.meals_expected)

    @property
    def calorie_alignment(self) -> float:
        """0.0 to 1.0. Within +/-10% = perfect, degrades to 0 at +/-40%."""
        if self.calories_target <= 0:
            return 0.5
        ratio = self.calories_logged / self.calories_target
        deviation = abs(1.0 - ratio)
        if deviation <= 0.10:
            return 1.0
        return max(0.0, 1.0 - ((deviation - 0.10) / 0.30))

    @property
    def protein_alignment(self) -> float:
        """Full credit at >=95% of target (relaxed from 100% to avoid
        false penalties when the user is 5g under). Below that, linear."""
        if self.protein_target <= 0:
            return 0.5
        ratio = self.protein_logged / self.protein_target
        if ratio >= 0.95:
            return 1.0
        return max(0.0, ratio / 0.95)

    @property
    def fiber_density(self) -> float:
        """Fiber g per 1000 kcal. 14 g/1000 kcal is the clinical target."""
        if self.calories_logged <= 0:
            return 0.0
        return self.fiber_g / self.calories_logged * 1000.0

    @property
    def added_sugar_pct_cals(self) -> float:
        if self.calories_logged <= 0:
            return 0.0
        return (self.added_sugar_g * 4.0) / self.calories_logged * 100.0

    @property
    def saturated_fat_pct_cals(self) -> float:
        if self.calories_logged <= 0:
            return 0.0
        return (self.saturated_fat_g * 9.0) / self.calories_logged * 100.0

    @property
    def micro_confidence(self) -> str:
        if self.food_count == 0:
            return "none"
        coverage = self.foods_with_micros / max(1, self.food_count)
        if coverage >= 0.7:
            return "high"
        if coverage >= 0.4:
            return "medium"
        return "low"


# ─── Score output ────────────────────────────────────────────────────────────

@dataclass
class SubscoreBreakdown:
    """Per-input contribution for a sub-score — used to render the Score
    Breakdown modal. Each input carries the 0-100 scaled value, the raw
    measurement, and the target so the UI can show a bar + a number."""
    label: str
    value_pct: int          # 0-100 for bar rendering
    raw: float              # actual measurement
    target: float | None    # target for context (None when not applicable)
    unit: str               # "g", "mg", "%", "servings", ""
    on_track: bool


@dataclass
class NutritionScore:
    total: int                         # 0-100 overall Nutrition Score
    adherence_score: int               # 0-100 sub-score
    quality_score: int                 # 0-100 sub-score
    micro_score: int                   # 0-100 sub-score
    confidence: str                    # low / medium / high
    tags: list[str]
    wins: list[str]
    improvements: list[str]
    likely_gaps: list[str]
    indicators: dict[str, Any]
    flags: dict[str, bool] = field(default_factory=dict)
    # Rendered-ready breakdown for the Score Breakdown modal
    adherence_breakdown: list[dict] = field(default_factory=list)
    quality_breakdown: list[dict] = field(default_factory=list)
    micro_breakdown: list[dict] = field(default_factory=list)
    # Non-empty when one or more score caps applied — UI renders these
    # below the headline number so users see *why* their 85 isn't a 92.
    cap_reasons: list[str] = field(default_factory=list)
    score_version: int = SCORE_VERSION


# Goal-aware weight adjustments for the unified score.
# (adherence, quality, micro) — sums to 1.0
_GOAL_WEIGHTS: dict[str, tuple[float, float, float]] = {
    "fat_loss":             (0.45, 0.35, 0.20),
    "muscle_gain":          (0.45, 0.30, 0.25),
    "strength":             (0.45, 0.30, 0.25),
    "body_recomp":          (0.40, 0.35, 0.25),
    "endurance":            (0.40, 0.35, 0.25),
    "athletic_performance": (0.40, 0.35, 0.25),
    "hyrox":                (0.40, 0.35, 0.25),
    "general_health":       (0.30, 0.40, 0.30),
    "maintain":             (0.30, 0.40, 0.30),
    "longevity":            (0.30, 0.40, 0.30),   # aliased via goal mapping
    "healthy_aging":        (0.30, 0.40, 0.30),
    "heart_health":         (0.30, 0.40, 0.30),
    "toning":               (0.45, 0.35, 0.20),
}
_DEFAULT_WEIGHTS = (0.40, 0.35, 0.25)


def _bd(label: str, value_pct: int, raw: float, target: float | None, unit: str, on_track: bool) -> dict:
    return {
        "label": label,
        "value_pct": int(max(0, min(100, round(value_pct)))),
        "raw": round(raw, 1),
        "target": target,
        "unit": unit,
        "on_track": on_track,
    }


def compute_nutrition_score(
    indicators: NutritionIndicators,
    goal: str = "body_recomp",
    sex: str | None = None,
) -> NutritionScore:
    """Compute the unified daily Nutrition Score."""

    w_adh, w_qual, w_micro = _GOAL_WEIGHTS.get(goal, _DEFAULT_WEIGHTS)

    # Sex-aware RDA overrides
    rda = dict(RDA)
    if sex and sex.lower() == "male":
        rda["iron_mg"] = 8

    has_calories = indicators.calories_logged > 0

    # ── Adherence (0-100) ────────────────────────────────────────────
    cal_align = indicators.calorie_alignment
    pro_align = indicators.protein_alignment
    cal_pts = cal_align * 50
    pro_pts = pro_align * 50
    adherence = round(min(100, cal_pts + pro_pts))

    adherence_breakdown = [
        _bd(
            "Calories",
            int(cal_align * 100),
            indicators.calories_logged,
            indicators.calories_target,
            "kcal",
            cal_align >= 0.9,
        ),
        _bd(
            "Protein",
            int(pro_align * 100),
            indicators.protein_logged,
            indicators.protein_target,
            "g",
            pro_align >= 0.95,
        ),
    ]

    # ── Food Quality (0-100) ─────────────────────────────────────────
    # 7-input model. Each input contributes its own max points.
    # No input double-counts — processing ≠ plant diversity ≠ fiber.
    fiber_density = indicators.fiber_density
    fiber_pts = _curve(fiber_density, low=6, mid=10, target=14.0, out_of=20)

    added_sugar_pct = indicators.added_sugar_pct_cals
    if added_sugar_pct <= 5:      added_sugar_pts = 15.0
    elif added_sugar_pct <= 10:   added_sugar_pts = 15.0 - (added_sugar_pct - 5) * 0.6   # linear to 12
    elif added_sugar_pct <= 15:   added_sugar_pts = 12.0 - (added_sugar_pct - 10) * 1.2  # 12→6
    else:                          added_sugar_pts = max(0.0, 6.0 - (added_sugar_pct - 15) * 0.4)

    sat_fat_pct = indicators.saturated_fat_pct_cals
    if sat_fat_pct <= 7:          sat_fat_pts = 15.0
    elif sat_fat_pct <= 10:       sat_fat_pts = 15.0 - (sat_fat_pct - 7) * 1.0         # 15→12
    elif sat_fat_pct <= 14:       sat_fat_pts = 12.0 - (sat_fat_pct - 10) * 1.5        # 12→6
    else:                          sat_fat_pts = max(0.0, 6.0 - (sat_fat_pct - 14) * 0.5)

    # Sodium: target <2300 mg/day. Athletes benefit from more, so we use a
    # generous curve — <=2300 full, 2300-3500 graded, >=4500 zero.
    sodium = indicators.sodium_mg
    if sodium <= 0:               sodium_pts = 5.0   # no data → neutral
    elif sodium <= 2300:          sodium_pts = 10.0
    elif sodium <= 3500:          sodium_pts = 10.0 - (sodium - 2300) / 1200.0 * 4.0   # 10→6
    elif sodium <= 4500:          sodium_pts = 6.0 - (sodium - 3500) / 1000.0 * 6.0    # 6→0
    else:                          sodium_pts = 0.0

    # Minimally-processed % (from daily metrics, not recomputed)
    min_proc = indicators.minimally_processed_pct / 100.0
    upf = indicators.ultra_processed_pct / 100.0
    processed_pts = max(0.0, 20.0 * (min_proc - 0.5 * upf))

    # Plant diversity: 5 distinct plants today = full credit
    plants = indicators.distinct_plant_foods
    if plants <= 0:      plant_pts = 0.0
    elif plants >= 5:    plant_pts = 10.0
    else:                plant_pts = (plants / 5.0) * 10.0

    # Omega-3 signal: daily omega-3 food OR seafood 2x/wk rolling
    omega_pts = 0.0
    if indicators.omega3_servings >= 1.0:
        omega_pts = 10.0
    elif indicators.seafood_servings_weekly >= 2.0:
        omega_pts = 10.0
    elif indicators.omega3_servings > 0 or indicators.seafood_servings_weekly > 0:
        omega_pts = 5.0

    quality_raw = fiber_pts + added_sugar_pts + sat_fat_pts + sodium_pts + processed_pts + plant_pts + omega_pts
    quality = round(min(100, max(0, quality_raw)))

    quality_breakdown = [
        _bd("Fiber density", int(fiber_pts / 20 * 100), fiber_density, 14.0, "g/1000kcal", fiber_pts >= 14),
        _bd("Added sugar", int(added_sugar_pts / 15 * 100), added_sugar_pct, 10.0, "% cals", added_sugar_pts >= 12),
        _bd("Saturated fat", int(sat_fat_pts / 15 * 100), sat_fat_pct, 10.0, "% cals", sat_fat_pts >= 12),
        _bd("Sodium", int(sodium_pts / 10 * 100), sodium, 2300.0, "mg", sodium_pts >= 8),
        _bd("Minimally processed", int(processed_pts / 20 * 100), indicators.minimally_processed_pct, 70.0, "%", processed_pts >= 14),
        _bd("Plant diversity", int(plant_pts / 10 * 100), float(plants), 5.0, "foods", plant_pts >= 8),
        _bd("Omega-3", int(omega_pts / 10 * 100), indicators.omega3_servings, 1.0, "servings", omega_pts >= 8),
    ]

    # ── Micronutrient Coverage (0-100) ──────────────────────────────
    micro_conf = indicators.micro_confidence
    gaps: list[str] = []
    micro_breakdown: list[dict] = []
    if micro_conf == "none":
        micro = 50
    else:
        hits = 0
        checked = 0
        for key in KEY_MICROS:
            rda_val = rda.get(key, 0)
            if rda_val <= 0:
                continue
            checked += 1
            logged = indicators.micronutrients.get(key, 0)
            ratio = logged / rda_val if rda_val else 0
            pct = int(min(100, ratio * 100))
            on_track = ratio >= 0.7
            gap_name = _display_name(key)
            if on_track:
                hits += 1
            elif ratio < 0.4:
                gaps.append(gap_name)
            micro_breakdown.append(
                _bd(gap_name, pct, logged, rda_val, _display_unit(key), on_track)
            )
        micro = round((hits / checked) * 100) if checked > 0 else 50
        if micro_conf == "low":
            micro = round(micro * 0.5 + 25)
        elif micro_conf == "medium":
            micro = round(micro * 0.75 + 12.5)

    # ── Confidence ───────────────────────────────────────────────────
    if indicators.logging_completeness < 0.3:
        confidence = "low"
    elif indicators.logging_completeness < 0.7 or micro_conf == "low":
        confidence = "medium"
    else:
        confidence = "high"

    confidence_factor = {"high": 1.0, "medium": 0.9, "low": 0.75}.get(confidence, 0.75)
    raw_total = adherence * w_adh + quality * w_qual + micro * w_micro
    total = round(min(100, max(0, raw_total * confidence_factor)))

    # ── Score caps — meaningful-gap guardrails ───────────────────────
    # The weighted blend alone can surface 90+ scores when macros land
    # perfectly even though quality/micros are clearly poor. Users hate
    # seeing a green 92 while an orange "added sugar high" banner sits
    # right below it. These caps make the headline score honest:
    #   • 3+ meaningful gaps ceiling 78
    #   • 2+ meaningful gaps ceiling 85
    #   • High sugar + high sat fat simultaneously ceiling 82
    #   • High-adherence (macros on target) but poor food quality
    #     ceiling 85 — prevents "I ate pop-tarts perfectly" 95s
    cap_reasons: list[str] = []
    meaningful_gaps = 0
    if added_sugar_pct > 15:
        meaningful_gaps += 1
    if sat_fat_pct > 12:
        meaningful_gaps += 1
    if sodium > 3500:
        meaningful_gaps += 1
    if fiber_density < 8 and has_calories:
        meaningful_gaps += 1
    if plants < 2 and has_calories:
        meaningful_gaps += 1
    if indicators.ultra_processed_pct >= 35:
        meaningful_gaps += 1
    if omega_pts < 5 and has_calories:
        meaningful_gaps += 1

    if meaningful_gaps >= 3:
        if total > 78:
            cap_reasons.append(f"{meaningful_gaps} meaningful nutrition gaps")
            total = 78
    elif meaningful_gaps >= 2:
        if total > 85:
            cap_reasons.append(f"{meaningful_gaps} meaningful nutrition gaps")
            total = 85

    # Specific pair-caps — the combo patterns that always read as
    # misleading when the blend lets them through.
    if added_sugar_pct > 12 and sat_fat_pct > 12 and total > 82:
        cap_reasons.append("High added sugar + saturated fat")
        total = 82
    if fiber_density < 8 and has_calories and total > 80:
        cap_reasons.append("Fiber density low")
        total = 80
    # Macros-OK-but-quality-poor: adherence is perfect but quality sub-60.
    if adherence >= 85 and quality < 60 and total > 85:
        cap_reasons.append("Quality score low despite hitting macros")
        total = 85

    # ── Structured flags ─────────────────────────────────────────────
    flags = {
        "calorie_on_track": cal_align >= 0.75,
        "protein_on_track": pro_align >= 0.85,
        "fiber_on_track": fiber_pts >= 14,
        "added_sugar_on_track": added_sugar_pts >= 12,
        "sat_fat_on_track": sat_fat_pts >= 12,
        "sodium_on_track": sodium_pts >= 8,
        "mostly_whole_foods": indicators.minimally_processed_pct >= 70,
        "high_upf": indicators.ultra_processed_pct >= 35,
        "plant_diverse": plants >= 5,
        "omega3_present": omega_pts >= 8,
        "micro_coverage_strong": micro >= 70,
    }

    # ── Tags + Wins + Improvements ───────────────────────────────────
    tags: list[str] = []
    wins: list[str] = []
    improvements: list[str] = []

    if flags["calorie_on_track"]:
        tags.append("Calories on track"); wins.append("Calories on track")
    elif has_calories:
        improvements.append("Calories off target")

    if flags["protein_on_track"]:
        tags.append("Protein on track"); wins.append("Protein on track")
    elif indicators.protein_logged > 0:
        gap = int(round(indicators.protein_target - indicators.protein_logged))
        if gap > 0:
            improvements.append(f"Protein {gap}g below target")

    if flags["fiber_on_track"]:
        tags.append("Fiber on track"); wins.append("Fiber on track")
    elif has_calories and fiber_density < 8:
        improvements.append("Fiber low")

    if flags["mostly_whole_foods"]:
        tags.append("Mostly whole foods"); wins.append("Mostly whole foods")
    if flags["high_upf"]:
        improvements.append("Ultra-processed food intake high")

    if not flags["added_sugar_on_track"] and added_sugar_pct > 10:
        improvements.append(f"Added sugar {added_sugar_pct:.0f}% of calories")
    if not flags["sat_fat_on_track"] and sat_fat_pct > 10:
        improvements.append(f"Saturated fat {sat_fat_pct:.0f}% of calories")

    if flags["plant_diverse"]:
        wins.append(f"{plants} distinct plants")
    elif has_calories and plants < 3:
        improvements.append("Add more plant variety")

    if flags["omega3_present"]:
        wins.append("Omega-3 source included")

    if indicators.hydration_logged:
        tags.append("Hydration logged")

    if micro_conf != "none":
        if flags["micro_coverage_strong"]:
            tags.append("Micronutrient coverage: strong (est.)")
        elif micro >= 45:
            tags.append("Micronutrient coverage: decent (est.)")
        else:
            tags.append("Micronutrient coverage: low (est.)")

    for gap in gaps[:3]:
        improvements.append(f"Low {gap.lower()}")

    if confidence == "low":
        improvements.append("Log more meals for a better score")

    return NutritionScore(
        total=total,
        adherence_score=adherence,
        quality_score=quality,
        micro_score=micro,
        confidence=confidence,
        tags=tags,
        wins=wins[:4],
        improvements=improvements[:4],
        likely_gaps=gaps,
        flags=flags,
        adherence_breakdown=adherence_breakdown,
        quality_breakdown=quality_breakdown,
        micro_breakdown=micro_breakdown,
        cap_reasons=cap_reasons,
        indicators={
            "calories_alignment": round(cal_align, 2),
            "protein_alignment": round(pro_align, 2),
            "fiber_density": round(fiber_density, 1),
            "added_sugar_pct_cals": round(added_sugar_pct, 1),
            "sat_fat_pct_cals": round(sat_fat_pct, 1),
            "sodium_mg": round(indicators.sodium_mg),
            "minimally_processed_pct": round(indicators.minimally_processed_pct),
            "ultra_processed_pct": round(indicators.ultra_processed_pct),
            "distinct_plant_foods": plants,
            "omega3_servings": round(indicators.omega3_servings, 1),
            "seafood_servings_weekly": round(indicators.seafood_servings_weekly, 1),
            "logging_completeness": round(indicators.logging_completeness, 2),
            "micro_confidence": micro_conf,
        },
    )


# ─── Helpers ─────────────────────────────────────────────────────────────────

def _curve(value: float, *, low: float, mid: float, target: float, out_of: float) -> float:
    """Piecewise linear: 0 at low, out_of*0.6 at mid, out_of at target."""
    if value <= low:
        return 0.0
    if value >= target:
        return out_of
    if value <= mid:
        return out_of * 0.6 * (value - low) / (mid - low)
    return out_of * 0.6 + (out_of * 0.4) * (value - mid) / (target - mid)


_MICRO_DISPLAY_NAMES = {
    "calcium_mg": "Calcium",
    "iron_mg": "Iron",
    "potassium_mg": "Potassium",
    "magnesium_mg": "Magnesium",
    "vitamin_d_mcg": "Vitamin D",
    "vitamin_c_mg": "Vitamin C",
    "vitamin_a_mcg": "Vitamin A",
    "vitamin_b12_mcg": "Vitamin B12",
    "zinc_mg": "Zinc",
    "selenium_mcg": "Selenium",
    "folate_mcg": "Folate",
    "fiber_g": "Fiber",
}


def _display_name(key: str) -> str:
    return _MICRO_DISPLAY_NAMES.get(key, key.replace("_", " ").title())


def _display_unit(key: str) -> str:
    if key.endswith("_mg"): return "mg"
    if key.endswith("_mcg"): return "mcg"
    if key.endswith("_g"): return "g"
    return ""


# ─── Overall health score ────────────────────────────────────────────────────

@dataclass
class OverallHealthScore:
    total: int
    nutrition: int
    activity: int
    sleep: int
    recovery: int
    available_domains: int
    confidence: str


def compute_overall_health_score(
    nutrition_score: int | None = None,
    activity_score: int | None = None,
    sleep_score: int | None = None,
    recovery_score: int | None = None,
) -> OverallHealthScore:
    domains: list[tuple[str, int, float]] = []
    if nutrition_score is not None:
        domains.append(("nutrition", nutrition_score, 0.30))
    if activity_score is not None:
        domains.append(("activity", activity_score, 0.25))
    if sleep_score is not None:
        domains.append(("sleep", sleep_score, 0.25))
    if recovery_score is not None:
        domains.append(("recovery", recovery_score, 0.20))

    if not domains:
        return OverallHealthScore(total=50, nutrition=0, activity=0, sleep=0, recovery=0, available_domains=0, confidence="low")

    total_weight = sum(w for _, _, w in domains)
    total = round(sum(s * (w / total_weight) for _, s, w in domains))

    available = len(domains)
    confidence = "high" if available >= 3 else ("medium" if available >= 2 else "low")

    return OverallHealthScore(
        total=min(100, max(0, total)),
        nutrition=nutrition_score or 0,
        activity=activity_score or 0,
        sleep=sleep_score or 0,
        recovery=recovery_score or 0,
        available_domains=available,
        confidence=confidence,
    )


# ─── Weekly trend ────────────────────────────────────────────────────────────

@dataclass
class WeeklyNutritionTrend:
    avg_score: int
    avg_adherence: int
    avg_quality: int
    day_count: int
    patterns: list[str]
    trend_direction: str


def compute_weekly_trend(daily_scores: list[NutritionScore]) -> WeeklyNutritionTrend:
    if not daily_scores:
        return WeeklyNutritionTrend(avg_score=0, avg_adherence=0, avg_quality=0, day_count=0, patterns=[], trend_direction="stable")

    recent = daily_scores[-7:]
    avg_score = round(sum(s.total for s in recent) / len(recent))
    avg_adh = round(sum(s.adherence_score for s in recent) / len(recent))
    avg_qual = round(sum(s.quality_score for s in recent) / len(recent))

    if len(recent) >= 5:
        mid = len(recent) // 2
        first_half = sum(s.total for s in recent[:mid]) / max(1, mid)
        second_half = sum(s.total for s in recent[mid:]) / max(1, len(recent) - mid)
        diff = second_half - first_half
        trend = "improving" if diff > 5 else "declining" if diff < -5 else "stable"
    else:
        trend = "stable"

    patterns: list[str] = []
    protein_hits = sum(1 for s in recent if s.flags.get("protein_on_track", False))
    fiber_hits = sum(1 for s in recent if s.flags.get("fiber_on_track", False))
    upf_days = sum(1 for s in recent if s.flags.get("high_upf", False))

    if protein_hits >= len(recent) * 0.7:
        patterns.append("Protein consistently on track")
    if fiber_hits < len(recent) * 0.3:
        patterns.append("Fiber intake inconsistent")
    if upf_days >= len(recent) * 0.5:
        patterns.append("Ultra-processed food intake elevated")

    return WeeklyNutritionTrend(
        avg_score=avg_score,
        avg_adherence=avg_adh,
        avg_quality=avg_qual,
        day_count=len(recent),
        patterns=patterns,
        trend_direction=trend,
    )
