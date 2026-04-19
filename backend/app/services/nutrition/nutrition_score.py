"""Daily nutrition scoring — deterministic, goal-aware, confidence-aware.

Produces a 0-100 Nutrition Score from three dimensions:
  1. Adherence (35-40%): calorie/protein alignment against targets
  2. Food Quality (35-40%): whole-food %, fiber, produce, processed penalty
  3. Micronutrient Coverage (20-30%): estimated coverage with confidence gating

Also produces:
  - user-facing tags (wins + improvements)
  - daily indicators (boolean/numeric)
  - confidence level (low/medium/high)
  - goal-aware weight adjustments

Design principles:
  - Missing data reduces confidence, not score
  - Incomplete logging is acknowledged, not punished as poor eating
  - Micronutrient estimates are presented as estimated, not precise
  - The score should feel fair, understandable, and motivating
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


# ─── RDA targets (adults, general) ───────────────────────────────────────────

RDA = {
    "fiber_g": 28,        # FDA daily value
    "calcium_mg": 1000,
    "iron_mg": 18,        # female RDA; male=8 — using higher to avoid false negatives
    "potassium_mg": 4700,
    "magnesium_mg": 420,
    "vitamin_d_mcg": 20,
    "vitamin_c_mg": 90,
    "vitamin_a_mcg": 900,
    "vitamin_b12_mcg": 2.4,
    "omega_3_g": 1.6,
    "zinc_mg": 11,
}

# Key micros checked for coverage gaps
KEY_MICROS = ["calcium_mg", "iron_mg", "potassium_mg", "magnesium_mg", "vitamin_d_mcg", "vitamin_c_mg"]


# ─── Food quality classification ─────────────────────────────────────────────

WHOLE_FOOD_CATEGORIES = {"proteins", "plant_proteins", "vegetables", "fruits", "grains_carbs", "dairy", "fats_oils"}
PROCESSED_INDICATORS = {"processed", "packaged", "canned"}
LOW_CONFIDENCE_SOURCES = {"ai", "user", "barcode"}


def classify_food_quality(food: dict) -> str:
    """Classify a food item as 'whole', 'processed', or 'unknown'.

    Single source of truth for food quality classification.
    Uses category + prep_state + source + name as signals.
    """
    category = (food.get("category") or "").lower()
    prep = (food.get("prep_state") or "").lower()
    source = (food.get("source") or "").lower()
    name = (food.get("name") or "").lower()

    if prep in PROCESSED_INDICATORS:
        return "processed"
    if any(w in name for w in (
        "protein bar", "granola bar", "energy bar", "cereal", "chips", "candy",
        "soda", "energy drink", "instant", "frozen dinner", "pizza", "hot dog",
        "nugget", "bacon", "sausage", "deli", "ham", "salami", "pepperoni",
        "granola", "rice cake", "bagel", "english muffin", "tortilla",
        "bread (white", "trail mix", "dark chocolate", "cracker", "pretzel",
    )):
        return "processed"

    if category == "supplements":
        return "supplement"

    if category in ("condiments", "beverages"):
        return "unknown"

    if source in LOW_CONFIDENCE_SOURCES and category not in WHOLE_FOOD_CATEGORIES:
        return "unknown"

    if category in WHOLE_FOOD_CATEGORIES:
        return "whole"

    return "unknown"


# ─── Daily nutrition indicators ──────────────────────────────────────────────

@dataclass
class NutritionIndicators:
    """Raw daily indicators before scoring."""
    calories_logged: float = 0
    calories_target: float = 0
    protein_logged: float = 0
    protein_target: float = 0
    fiber_logged: float = 0
    fruit_veg_servings: float = 0
    meals_logged: int = 0
    meals_expected: int = 3
    whole_food_pct: float = 0     # 0-100
    processed_food_pct: float = 0 # 0-100
    hydration_logged: bool = False
    micronutrients: dict[str, float] = field(default_factory=dict)
    food_count: int = 0
    foods_with_micros: int = 0

    @property
    def logging_completeness(self) -> float:
        if self.meals_expected <= 0:
            return 0.0
        return min(1.0, self.meals_logged / self.meals_expected)

    @property
    def calorie_alignment(self) -> float:
        """0.0 (way off) to 1.0 (on target).
        Within ±10% = perfect score. Degrades linearly to 0 at ±40%."""
        if self.calories_target <= 0:
            return 0.5
        ratio = self.calories_logged / self.calories_target
        deviation = abs(1.0 - ratio)
        if deviation <= 0.10:
            return 1.0
        return max(0.0, 1.0 - ((deviation - 0.10) / 0.30))

    @property
    def protein_alignment(self) -> float:
        """Full credit at 100%+ of target. Degrades below that."""
        if self.protein_target <= 0:
            return 0.5
        ratio = self.protein_logged / self.protein_target
        if ratio >= 1.0:
            return 1.0
        return max(0.0, ratio)

    @property
    def fiber_alignment(self) -> float:
        target = RDA["fiber_g"]
        if self.fiber_logged >= target:
            return 1.0
        return max(0.0, self.fiber_logged / target)

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


# ─── Scoring ─────────────────────────────────────────────────────────────────

@dataclass
class NutritionScore:
    total: int                    # 0-100
    adherence_score: int          # 0-100 (sub-score before weighting)
    quality_score: int            # 0-100
    micro_score: int              # 0-100
    confidence: str               # low / medium / high
    tags: list[str]               # user-facing indicator tags
    wins: list[str]               # positive highlights
    improvements: list[str]       # actionable suggestions
    likely_gaps: list[str]        # micronutrient gaps
    indicators: dict[str, Any]    # raw indicator values for UI
    # Structured flags for programmatic use (not display strings)
    flags: dict[str, bool] = field(default_factory=dict)


# Goal-aware weight adjustments
_GOAL_WEIGHTS: dict[str, tuple[float, float, float]] = {
    # (adherence_weight, quality_weight, micro_weight)
    "muscle_gain":          (0.40, 0.35, 0.25),
    "strength":             (0.40, 0.35, 0.25),
    "fat_loss":             (0.40, 0.40, 0.20),
    "body_recomp":          (0.38, 0.37, 0.25),
    "endurance":            (0.35, 0.35, 0.30),
    "athletic_performance": (0.35, 0.35, 0.30),
    "hyrox":                (0.35, 0.35, 0.30),
    "general_health":       (0.30, 0.35, 0.35),
    "maintain":             (0.30, 0.35, 0.35),
}
_DEFAULT_WEIGHTS = (0.35, 0.40, 0.25)


def compute_nutrition_score(
    indicators: NutritionIndicators,
    goal: str = "body_recomp",
    sex: str | None = None,
) -> NutritionScore:
    """Compute a daily nutrition score from indicators.

    Args:
        sex: "male" or "female". When "male", iron RDA is 8mg instead of 18mg.
             Defaults to 18mg (female RDA) when unknown to avoid false negatives.
    """

    w_adh, w_qual, w_micro = _GOAL_WEIGHTS.get(goal, _DEFAULT_WEIGHTS)

    # Sex-aware RDA overrides
    rda = dict(RDA)
    if sex and sex.lower() == "male":
        rda["iron_mg"] = 8

    # ── Adherence (0-100) ────────────────────────────────────────────
    # Logging completeness affects confidence, not the adherence score directly.
    # Someone who logs 1 meal should not look like they ate badly.
    cal_pts = indicators.calorie_alignment * 50       # 0-50
    pro_pts = indicators.protein_alignment * 50       # 0-50
    adherence = round(min(100, cal_pts + pro_pts))

    # ── Food Quality (0-100) ─────────────────────────────────────────
    whole_pts = min(35, indicators.whole_food_pct / 100 * 35)
    processed_penalty = min(20, indicators.processed_food_pct / 100 * 20)
    fiber_pts = indicators.fiber_alignment * 20                       # 0-20
    fv_pts = min(15, (indicators.fruit_veg_servings / 5) * 15)       # 5 servings = full
    hydration_pts = 10 if indicators.hydration_logged else 0          # 0-10
    quality = round(min(100, max(0, whole_pts - processed_penalty + fiber_pts + fv_pts + hydration_pts)))

    # ── Micronutrient Coverage (0-100) ────────────────────────────────
    micro_conf = indicators.micro_confidence
    if micro_conf == "none":
        micro = 50  # neutral when no data — no fake precision
    else:
        hits = 0
        checked = 0
        gaps = []
        for key in KEY_MICROS:
            rda_val = rda.get(key, 0)
            if rda_val <= 0:
                continue
            checked += 1
            logged = indicators.micronutrients.get(key, 0)
            ratio = logged / rda_val
            if ratio >= 0.7:
                hits += 1
            elif ratio < 0.4:
                gap_name = key.replace("_mg", "").replace("_mcg", "").replace("_g", "").replace("_", " ").title()
                gaps.append(gap_name)

        if checked > 0:
            micro = round((hits / checked) * 100)
        else:
            micro = 50

        # Low confidence: pull toward neutral to avoid false precision
        if micro_conf == "low":
            micro = round(micro * 0.5 + 25)  # compress range toward 50
        elif micro_conf == "medium":
            micro = round(micro * 0.75 + 12.5)  # mild pull toward neutral

    likely_gaps = gaps if micro_conf != "none" else []

    # ── Confidence (based on logging completeness + micro quality) ────
    if indicators.logging_completeness < 0.3:
        confidence = "low"
    elif indicators.logging_completeness < 0.7 or micro_conf == "low":
        confidence = "medium"
    else:
        confidence = "high"

    # ── Weighted total ───────────────────────────────────────────────
    # Scale sub-scores by confidence so partial data doesn't over-inflate
    confidence_factor = {"high": 1.0, "medium": 0.9, "low": 0.75}.get(confidence, 0.75)
    raw_total = adherence * w_adh + quality * w_qual + micro * w_micro
    total = round(min(100, max(0, raw_total * confidence_factor)))

    # ── Structured flags (for programmatic use) ──────────────────────
    flags = {
        "calorie_on_track": indicators.calorie_alignment >= 0.75,
        "protein_on_track": indicators.protein_alignment >= 0.85,
        "fiber_on_track": indicators.fiber_alignment >= 0.8,
        "produce_on_track": indicators.fruit_veg_servings >= 4,
        "mostly_whole_foods": indicators.whole_food_pct >= 70,
        "high_processed": indicators.processed_food_pct > 50,
        "micro_coverage_strong": micro >= 70,
    }

    # ── Tags + Wins + Improvements ───────────────────────────────────
    tags = []
    wins = []
    improvements = []

    if flags["calorie_on_track"]:
        tags.append("Calories on track")
        wins.append("Calories on track")
    elif indicators.calories_logged > 0:
        improvements.append("Calories off target")

    if flags["protein_on_track"]:
        tags.append("Protein on track")
        wins.append("Protein on track")
    elif indicators.protein_logged > 0:
        improvements.append("Protein below target")

    if flags["fiber_on_track"]:
        tags.append("Fiber on track")
        wins.append("Fiber on track")
    elif indicators.fiber_logged > 0 and indicators.fiber_logged < RDA["fiber_g"] * 0.5:
        improvements.append("Fiber low")

    if flags["produce_on_track"]:
        tags.append("Produce goal hit")
        wins.append("Good produce intake")
    elif indicators.fruit_veg_servings < 2:
        improvements.append("More fruits and vegetables")

    if flags["mostly_whole_foods"]:
        tags.append("Mostly whole foods")
        wins.append("Mostly whole foods")

    if flags["high_processed"]:
        tags.append("High processed-food day")
        improvements.append("High processed food intake")

    if indicators.hydration_logged:
        tags.append("Hydration logged")

    if micro_conf != "none":
        if flags["micro_coverage_strong"]:
            tags.append("Micronutrient coverage: strong (est.)")
        elif micro >= 45:
            tags.append("Micronutrient coverage: decent (est.)")
        else:
            tags.append("Micronutrient coverage: low (est.)")

    for gap in likely_gaps[:3]:
        tags.append(f"Likely low {gap.lower()}")
        improvements.append(f"Likely low {gap.lower()}")

    if confidence == "low":
        improvements.append("Log more meals for a better score")

    return NutritionScore(
        total=total,
        adherence_score=adherence,
        quality_score=quality,
        micro_score=micro,
        confidence=confidence,
        tags=tags,
        wins=wins[:3],
        improvements=improvements[:3],
        likely_gaps=likely_gaps,
        flags=flags,
        indicators={
            "calories_alignment": round(indicators.calorie_alignment, 2),
            "protein_alignment": round(indicators.protein_alignment, 2),
            "fiber_alignment": round(indicators.fiber_alignment, 2),
            "logging_completeness": round(indicators.logging_completeness, 2),
            "whole_food_pct": round(indicators.whole_food_pct),
            "processed_food_pct": round(indicators.processed_food_pct),
            "fruit_veg_servings": round(indicators.fruit_veg_servings, 1),
            "micro_confidence": micro_conf,
        },
    )


# ─── Overall health score ────────────────────────────────────────────────────

@dataclass
class OverallHealthScore:
    total: int              # 0-100
    nutrition: int          # 0-100 (nutrition score)
    activity: int           # 0-100 (fitness/workout score)
    sleep: int              # 0-100
    recovery: int           # 0-100
    available_domains: int  # how many of 4 domains have data
    confidence: str         # low / medium / high


def compute_overall_health_score(
    nutrition_score: int | None = None,
    activity_score: int | None = None,
    sleep_score: int | None = None,
    recovery_score: int | None = None,
) -> OverallHealthScore:
    """Combine available health domains into an overall score.

    Weights normalize across available domains so users without
    Apple Health aren't penalized vs users who have it.
    """
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


# ─── Weekly trend ─────────────────────────────────────────────────────────────

@dataclass
class WeeklyNutritionTrend:
    avg_score: int
    avg_adherence: int
    avg_quality: int
    day_count: int
    patterns: list[str]
    trend_direction: str       # "improving" / "stable" / "declining"


def compute_weekly_trend(daily_scores: list[NutritionScore]) -> WeeklyNutritionTrend:
    """Compute 7-day rolling trend from a list of daily scores."""
    if not daily_scores:
        return WeeklyNutritionTrend(avg_score=0, avg_adherence=0, avg_quality=0, day_count=0, patterns=[], trend_direction="stable")

    recent = daily_scores[-7:]
    avg_score = round(sum(s.total for s in recent) / len(recent))
    avg_adh = round(sum(s.adherence_score for s in recent) / len(recent))
    avg_qual = round(sum(s.quality_score for s in recent) / len(recent))

    patterns = []
    if len(recent) >= 5:
        first_half = sum(s.total for s in recent[:len(recent)//2]) / max(1, len(recent)//2)
        second_half = sum(s.total for s in recent[len(recent)//2:]) / max(1, len(recent) - len(recent)//2)
        diff = second_half - first_half
        if diff > 5:
            trend = "improving"
        elif diff < -5:
            trend = "declining"
        else:
            trend = "stable"
    else:
        trend = "stable"

    # Use structured flags instead of tag strings
    protein_hits = sum(1 for s in recent if s.flags.get("protein_on_track", False))
    fiber_hits = sum(1 for s in recent if s.flags.get("fiber_on_track", False))
    processed_days = sum(1 for s in recent if s.flags.get("high_processed", False))

    if protein_hits >= len(recent) * 0.7:
        patterns.append("Protein consistently on track")
    if fiber_hits < len(recent) * 0.3:
        patterns.append("Fiber intake inconsistent")
    if processed_days >= len(recent) * 0.5:
        patterns.append("Processed food intake elevated this week")

    return WeeklyNutritionTrend(
        avg_score=avg_score,
        avg_adherence=avg_adh,
        avg_quality=avg_qual,
        day_count=len(recent),
        patterns=patterns,
        trend_direction=trend,
    )


# ─── V2 Extensions (workout-aware) ──────────────────────────────────────────
#
# Planned lightweight extensions for workout-day nutrition:
#   1. Protein support: +5 adherence bonus if protein >= 100% on lifting days
#   2. Carb support: +5 quality bonus if carbs >= 55% of cals on endurance days
#   3. Hydration flag: surface "hydrate extra" tag on intense cardio days
#   4. Pre/post window: tag meals within 2h of workout as "peri-workout"
#
# These are additive bonuses, not penalties. A user who doesn't time their
# nutrition doesn't lose points — one who does gets a small boost.
