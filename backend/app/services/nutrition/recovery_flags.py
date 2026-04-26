"""Fueling & Recovery Signals — flag-based, NOT a score.

This module computes 3-4 trust-preserving "resilience" flags from
nutrition patterns. It is deliberately boring. We do NOT claim to
estimate hormone levels, we do NOT put numbers on cortisol or
testosterone, and every surface here carries a "this is not a medical
diagnosis" disclaimer on the client.

Flags:
  1. under_fueling     — energy availability (EA) sustained below 30 kcal/kg FFM
  2. low_fat           — total fat sustained below 20% of calories
  3. recovery_nutrients — magnesium/zinc/vitamin D/selenium adequacy
  4. thyroid_support   — (optional, profile-opt-in) selenium + fueling adequacy

Every flag is tri-state: green | amber | red | not_enough_data.

Why EA? The IOC RED-S consensus (2014, 2023 update) identifies EA <30
kcal/kg FFM as a threshold for hormonal and bone-health risk. This is
well-supported. We estimate FFM from bodyweight + a default body-fat
percentage when we don't know the user's actual body fat. That's not
precise enough to say "you're at 29.4 — exactly at risk" but it's good
enough to flag a sustained pattern of under-fueling.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any

from sqlmodel import select

from app.models import (
    Meal, MealItem, UserProfile, UserGoal,
    DailyNutritionMetrics, WorkoutCompletion,
)
from app.services.nutrition.nutrition_score import RDA


# ─── Constants ───────────────────────────────────────────────────────────────

EA_RED_THRESHOLD = 25.0        # kcal/kg FFM — sustained = red
EA_AMBER_THRESHOLD = 30.0      # kcal/kg FFM — sustained = amber
MIN_DAYS_FOR_FLAG = 5          # need >=5 days in window to flag
WINDOW_DAYS = 7
FAT_RED_PCT = 15.0             # <15% of cals sustained = red
FAT_AMBER_PCT = 20.0           # 15-20% = amber
# Default body-fat % when we don't know — used to estimate FFM for EA.
DEFAULT_BF_PCT_MALE = 0.18
DEFAULT_BF_PCT_FEMALE = 0.28
DEFAULT_BF_PCT_OTHER = 0.23


@dataclass
class FlagState:
    key: str
    state: str                 # green | amber | red | not_enough_data
    label: str
    detail: str
    action: str | None = None
    numbers: dict | None = None


def _sex_bf_default(sex: str | None) -> float:
    s = (sex or "").lower()
    if s == "male":
        return DEFAULT_BF_PCT_MALE
    if s == "female":
        return DEFAULT_BF_PCT_FEMALE
    return DEFAULT_BF_PCT_OTHER


def _get_profile_and_goal(db: Any, user_id: int) -> tuple[UserProfile | None, UserGoal | None]:
    profile = db.exec(select(UserProfile).where(UserProfile.user_id == user_id)).first()
    goal = db.exec(
        select(UserGoal).where(UserGoal.user_id == user_id).where(UserGoal.is_active == True)  # noqa: E712
    ).first()
    return profile, goal


def _estimate_ffm_kg(profile: UserProfile | None) -> float | None:
    if not profile:
        return None
    LBS_PER_KG = 2.2046226218
    weight_kg = profile.weight_lbs / LBS_PER_KG
    sex = profile.gender.value if profile.gender else None
    bf = _sex_bf_default(sex)
    return weight_kg * (1.0 - bf)


def compute_energy_availability(
    db: Any, user_id: int, *, end_date: date, days: int = WINDOW_DAYS,
) -> dict | None:
    """Estimate avg 7-day Energy Availability (kcal per kg FFM)."""
    profile, _ = _get_profile_and_goal(db, user_id)
    ffm_kg = _estimate_ffm_kg(profile)
    if not ffm_kg or ffm_kg <= 0:
        return None

    start = end_date - timedelta(days=days - 1)
    rows = db.exec(
        select(DailyNutritionMetrics)
        .where(DailyNutritionMetrics.user_id == user_id)
        .where(DailyNutritionMetrics.metric_date >= start)
        .where(DailyNutritionMetrics.metric_date <= end_date)
    ).all()
    comps = db.exec(
        select(WorkoutCompletion)
        .where(WorkoutCompletion.user_id == user_id)
        .where(WorkoutCompletion.workout_date >= start)
        .where(WorkoutCompletion.workout_date <= end_date)
    ).all()

    intake_by_day: dict[date, float] = {}
    for r in rows:
        if (r.calories_total or 0) > 0:
            intake_by_day[r.metric_date] = float(r.calories_total)
    exercise_by_day: dict[date, float] = {}
    for c in comps:
        if c.calories_burned:
            exercise_by_day[c.workout_date] = exercise_by_day.get(c.workout_date, 0.0) + float(c.calories_burned)

    if not intake_by_day:
        return None

    ea_values: list[float] = []
    per_day: list[dict] = []
    for offset in range(days - 1, -1, -1):
        d = end_date - timedelta(days=offset)
        intake = intake_by_day.get(d)
        if intake is None:
            per_day.append({"date": str(d), "ea": None, "logged": False})
            continue
        exercise = exercise_by_day.get(d, 0.0)
        ea = max(0.0, (intake - exercise) / ffm_kg)
        ea_values.append(ea)
        per_day.append({
            "date": str(d), "ea": round(ea, 1), "logged": True,
            "intake_kcal": round(intake), "exercise_kcal": round(exercise),
        })

    if not ea_values:
        return None
    avg_ea = sum(ea_values) / len(ea_values)
    return {
        "avg_ea_kcal_per_kg_ffm": round(avg_ea, 1),
        "ffm_kg": round(ffm_kg, 1),
        "days_with_data": len(ea_values),
        "daily": per_day,
    }


def compute_flags(
    db: Any, user_id: int, *, end_date: date | None = None, days: int = WINDOW_DAYS,
    thyroid_opt_in: bool = False,
) -> list[FlagState]:
    """Compute all resilience flags. Returns an ordered list."""
    if end_date is None:
        end_date = date.today()

    profile, goal = _get_profile_and_goal(db, user_id)
    sex = profile.gender.value if (profile and profile.gender) else None

    start = end_date - timedelta(days=days - 1)
    rows = db.exec(
        select(DailyNutritionMetrics)
        .where(DailyNutritionMetrics.user_id == user_id)
        .where(DailyNutritionMetrics.metric_date >= start)
        .where(DailyNutritionMetrics.metric_date <= end_date)
    ).all()

    logged_rows = [r for r in rows if (r.calories_total or 0) > 0]

    flags: list[FlagState] = []

    # ── 1. Under-fueling (EA) ─────────────────────────────────────────
    ea_ctx = compute_energy_availability(db, user_id, end_date=end_date, days=days)
    if not ea_ctx or ea_ctx["days_with_data"] < MIN_DAYS_FOR_FLAG:
        flags.append(FlagState(
            key="under_fueling",
            state="not_enough_data",
            label="Under-fueling risk",
            detail="Log at least 5 days to assess energy availability.",
            numbers=ea_ctx or {},
        ))
    else:
        ea = ea_ctx["avg_ea_kcal_per_kg_ffm"]
        if ea < EA_RED_THRESHOLD:
            state = "red"
            detail = f"Energy availability {ea:.0f} kcal/kg FFM — sustained under-fueling."
            action = "Add ~300 kcal on training days from whole-food sources."
        elif ea < EA_AMBER_THRESHOLD:
            state = "amber"
            detail = f"Energy availability {ea:.0f} kcal/kg FFM — near the adequate threshold."
            action = "Slightly increase intake on hard training days."
        else:
            state = "green"
            detail = f"Energy availability {ea:.0f} kcal/kg FFM — fueling adequate."
            action = None
        flags.append(FlagState(
            key="under_fueling", state=state,
            label="Under-fueling risk", detail=detail, action=action,
            numbers=ea_ctx,
        ))

    # ── 2. Low fat intake ────────────────────────────────────────────
    fat_pct_days: list[float] = []
    item_ids_by_day: dict[date, list[MealItem]] = {}
    meals_in_window = db.exec(
        select(Meal).where(Meal.user_id == user_id)
        .where(Meal.meal_date >= start).where(Meal.meal_date <= end_date)
    ).all()
    meal_ids = [m.id for m in meals_in_window]
    meal_dates_by_id = {m.id: m.meal_date for m in meals_in_window}
    if meal_ids:
        for item in db.exec(select(MealItem).where(MealItem.meal_id.in_(meal_ids))).all():
            d = meal_dates_by_id.get(item.meal_id)
            if d is not None:
                item_ids_by_day.setdefault(d, []).append(item)
    for d, items in item_ids_by_day.items():
        day_cals = sum(float(i.calories or 0) for i in items)
        day_fat_g = sum(float(i.fat_g or 0) for i in items)
        if day_cals >= 600:
            pct = (day_fat_g * 9.0) / day_cals * 100.0
            fat_pct_days.append(pct)

    if len(fat_pct_days) < MIN_DAYS_FOR_FLAG:
        flags.append(FlagState(
            key="low_fat", state="not_enough_data",
            label="Fat intake floor",
            detail="Log at least 5 days of meals to assess fat intake.",
        ))
    else:
        avg_fat_pct = sum(fat_pct_days) / len(fat_pct_days)
        low_days = sum(1 for p in fat_pct_days if p < FAT_AMBER_PCT)
        if avg_fat_pct < FAT_RED_PCT and low_days >= MIN_DAYS_FOR_FLAG:
            state = "red"
            detail = f"Fat {avg_fat_pct:.0f}% of calories — below recovery floor."
            action = "Add avocado, olive oil, nuts, or fatty fish to 1–2 meals/day."
        elif avg_fat_pct < FAT_AMBER_PCT and low_days >= MIN_DAYS_FOR_FLAG:
            state = "amber"
            detail = f"Fat {avg_fat_pct:.0f}% of calories — near the low end."
            action = "Include a fat source at each meal."
        else:
            state = "green"
            detail = f"Fat {avg_fat_pct:.0f}% of calories — adequate."
            action = None
        flags.append(FlagState(
            key="low_fat", state=state, label="Fat intake floor",
            detail=detail, action=action,
            numbers={"avg_fat_pct_cals": round(avg_fat_pct, 1)},
        ))

    # ── 3. Recovery nutrients ────────────────────────────────────────
    nutrient_state = _recovery_nutrients_flag(db, user_id=user_id, start=start, end_date=end_date, sex=sex)
    flags.append(nutrient_state)

    # ── 4. Metabolic support (cardiometabolic dietary pattern) ──────
    flags.append(_metabolic_support_flag(rows=logged_rows))

    # ── 5. Thyroid support (opt-in) ──────────────────────────────────
    if thyroid_opt_in:
        flags.append(_thyroid_support_flag(
            under_fueling_state=flags[0].state,
            nutrient_state=nutrient_state.state,
            sex=sex,
        ))

    return flags


def _metabolic_support_flag(*, rows: list) -> "FlagState":
    """Cardiometabolic dietary-pattern flag. Defensible inputs:
      - added sugar > 10% of calories sustained
      - saturated fat > 10% of calories sustained
      - fiber density < 8 g/1000 kcal sustained
      - calorie coefficient-of-variation elevated (>0.30)

    Two or more in-zone = amber; three or more = red. Literature base:
    WHO sugar guidance, AHA sat-fat guidance, IOM fiber, and general
    evidence on glycemic variability. Not a hormone claim — a dietary-
    pattern flag. Tri-state, never a score.
    """
    if len(rows) < MIN_DAYS_FOR_FLAG:
        return FlagState(
            key="metabolic_support", state="not_enough_data",
            label="Metabolic support",
            detail="Log at least 5 days to assess dietary-pattern metabolic risk signals.",
        )

    added_sugar_high_days = 0
    sat_fat_high_days = 0
    fiber_low_days = 0
    cal_values: list[float] = []

    for r in rows:
        cals = float(r.calories_total or 0)
        if cals <= 0:
            continue
        cal_values.append(cals)
    # Re-check after filtering zero-calorie placeholder rows. Without
    # this, a user with 10 placeholder rows (no actual food logged)
    # falls through to "green" — misleading, looks like the user is
    # eating well when they have no logged data at all.
    if len(cal_values) < MIN_DAYS_FOR_FLAG:
        return FlagState(
            key="metabolic_support", state="not_enough_data",
            label="Metabolic support",
            detail="Log at least 5 days of meals to assess dietary-pattern metabolic risk signals.",
        )

    # Re-iterate to count concern days (we need both passes — first
    # builds cal_values for the gate, second counts day-level concerns).
    for r in rows:
        cals = float(r.calories_total or 0)
        if cals <= 0:
            continue
        added = float(getattr(r, "added_sugar_g", 0) or 0)
        sat = float(r.saturated_fat_g or 0)
        fiber = float(r.fiber_total_g or 0)
        if cals > 0 and (added * 4.0 / cals) * 100.0 > 10.0:
            added_sugar_high_days += 1
        if cals > 0 and (sat * 9.0 / cals) * 100.0 > 10.0:
            sat_fat_high_days += 1
        if cals > 0 and (fiber / cals * 1000.0) < 8.0:
            fiber_low_days += 1

    cv = 0.0
    if len(cal_values) >= 2:
        mean_c = sum(cal_values) / len(cal_values)
        if mean_c > 0:
            var = sum((c - mean_c) ** 2 for c in cal_values) / len(cal_values)
            cv = (var ** 0.5) / mean_c

    concerns: list[str] = []
    if added_sugar_high_days >= MIN_DAYS_FOR_FLAG:
        concerns.append("added sugar")
    if sat_fat_high_days >= MIN_DAYS_FOR_FLAG:
        concerns.append("saturated fat")
    if fiber_low_days >= MIN_DAYS_FOR_FLAG:
        concerns.append("fiber density")
    if cv > 0.30:
        concerns.append("calorie swings")

    numbers = {
        "added_sugar_high_days": added_sugar_high_days,
        "sat_fat_high_days": sat_fat_high_days,
        "fiber_low_days": fiber_low_days,
        "calorie_stability_cv": round(cv, 3),
    }

    if len(concerns) >= 3:
        return FlagState(
            key="metabolic_support", state="red",
            label="Metabolic support",
            detail=f"Dietary pattern trending toward cardiometabolic risk — {', '.join(concerns)} elevated most days.",
            action="Add fiber-rich plants; reduce added-sugar sources; stabilize meal timing.",
            numbers=numbers,
        )
    if len(concerns) == 2:
        return FlagState(
            key="metabolic_support", state="amber",
            label="Metabolic support",
            detail=f"Two metabolic-risk signals elevated ({', '.join(concerns)}).",
            action="Focus on fiber + minimally processed foods; keep added sugar under 10% of calories.",
            numbers=numbers,
        )
    if len(concerns) == 1:
        return FlagState(
            key="metabolic_support", state="green",
            label="Metabolic support",
            detail=f"One mild concern ({concerns[0]}), but the broader pattern is healthy.",
            numbers=numbers,
        )
    return FlagState(
        key="metabolic_support", state="green",
        label="Metabolic support",
        detail="Dietary pattern supports metabolic health (fiber, sugar, fat, and calorie stability all on track).",
        numbers=numbers,
    )


def _recovery_nutrients_flag(
    db: Any, *, user_id: int, start: date, end_date: date, sex: str | None,
) -> FlagState:
    """Read magnesium, zinc, vitamin D, selenium from daily meal items over
    the window. Flag when multiple are chronically low."""
    from app.services.nutrition.score_builder import _aggregate_micros, _add_supplement_micros

    # For each day, aggregate micros and check adequacy.
    nutrients = ["magnesium_mg", "zinc_mg", "vitamin_d_mcg", "selenium_mcg"]
    days_analyzed = 0
    below_50_counts = {k: 0 for k in nutrients}
    below_70_counts = {k: 0 for k in nutrients}

    rda = dict(RDA)
    if sex and sex.lower() == "male":
        rda["iron_mg"] = 8

    current = start
    while current <= end_date:
        meals_d = db.exec(
            select(Meal).where(Meal.user_id == user_id).where(Meal.meal_date == current)
        ).all()
        meal_ids = [m.id for m in meals_d]
        items: list[MealItem] = []
        if meal_ids:
            items = db.exec(select(MealItem).where(MealItem.meal_id.in_(meal_ids))).all()
        if items:
            day_micros, _fc, _fwm = _aggregate_micros(db, items)
            _add_supplement_micros(db, user_id, current, day_micros)
            days_analyzed += 1
            for key in nutrients:
                rda_val = rda.get(key, 0)
                if rda_val <= 0:
                    continue
                got = day_micros.get(key, 0)
                ratio = got / rda_val if rda_val else 0
                if ratio < 0.5:
                    below_50_counts[key] += 1
                if ratio < 0.7:
                    below_70_counts[key] += 1
        current = current + timedelta(days=1)

    if days_analyzed < MIN_DAYS_FOR_FLAG:
        return FlagState(
            key="recovery_nutrients", state="not_enough_data",
            label="Recovery nutrient adequacy",
            detail="Log at least 5 days to estimate magnesium, zinc, vitamin D, and selenium intake.",
        )

    # Consider chronically low = below 50% RDA on >=5 of logged days
    chronic_low = [k for k, c in below_50_counts.items() if c >= MIN_DAYS_FOR_FLAG]
    persistent_low = [k for k, c in below_70_counts.items() if c >= MIN_DAYS_FOR_FLAG]

    pretty = {
        "magnesium_mg": "magnesium", "zinc_mg": "zinc",
        "vitamin_d_mcg": "vitamin D", "selenium_mcg": "selenium",
    }
    if len(chronic_low) >= 2:
        state = "red"
        names = ", ".join(pretty[k] for k in chronic_low)
        detail = f"Recovery nutrients trending low — {names} below 50% RDA most days."
        action = "Top gaps: " + _action_for(chronic_low)
    elif len(chronic_low) == 1 or len(persistent_low) >= 2:
        state = "amber"
        loose = chronic_low or persistent_low
        names = ", ".join(pretty[k] for k in loose)
        detail = f"Recovery nutrients mixed — {names} below target most days."
        action = "Top gaps: " + _action_for(loose)
    else:
        state = "green"
        detail = "Recovery nutrients at adequate levels."
        action = None

    return FlagState(
        key="recovery_nutrients", state=state,
        label="Recovery nutrient adequacy",
        detail=detail, action=action,
        numbers={
            "days_analyzed": days_analyzed,
            "below_50pct_rda_counts": below_50_counts,
            "below_70pct_rda_counts": below_70_counts,
        },
    )


def _action_for(keys: list[str]) -> str:
    """Short food-source suggestions for missing nutrients."""
    suggestions = {
        "magnesium_mg": "pumpkin seeds, dark leafy greens, almonds",
        "zinc_mg": "beef, shellfish, lentils, pumpkin seeds",
        "vitamin_d_mcg": "fatty fish, egg yolks, fortified dairy or sun exposure",
        "selenium_mcg": "brazil nuts (1–2/day), tuna, sardines, eggs",
    }
    parts = [suggestions.get(k, "") for k in keys if suggestions.get(k)]
    return "; ".join(p for p in parts if p)


def _thyroid_support_flag(*, under_fueling_state: str, nutrient_state: str, sex: str | None) -> FlagState:
    """Opt-in only. Greens when fueling + selenium + adequate; ambers when
    either under-fueling or selenium gap is active. Never diagnoses anything."""
    concerning = under_fueling_state in ("amber", "red") or nutrient_state in ("amber", "red")
    if under_fueling_state == "not_enough_data" or nutrient_state == "not_enough_data":
        return FlagState(
            key="thyroid_support", state="not_enough_data",
            label="Thyroid-support signals",
            detail="Log more days to assess fueling + recovery-nutrient adequacy.",
        )
    iodine_note = ("Iodine isn't reliably trackable from food logs — "
                   "use iodized salt or seafood 2x/week if you're concerned.")
    if concerning:
        return FlagState(
            key="thyroid_support", state="amber",
            label="Thyroid-support signals",
            detail=f"Selenium and calorie adequacy support thyroid function; one or both are trending low. {iodine_note}",
            action="Focus on brazil nuts, seafood, adequate fueling.",
        )
    return FlagState(
        key="thyroid_support", state="green",
        label="Thyroid-support signals",
        detail=f"Fueling + selenium + recovery nutrients adequate. {iodine_note}",
    )


def flags_to_dict(flags: list[FlagState]) -> dict:
    """Serialize for the API."""
    from dataclasses import asdict as _asdict
    return {"flags": [_asdict(f) for f in flags]}


def flags_to_map(flags: list[FlagState]) -> dict:
    """Compact state map — useful for DailyNutritionMetrics.recovery_flags JSON."""
    return {f.key: f.state for f in flags}
