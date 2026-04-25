"""Deterministic supplement recommendation engine.

Composes signals from:
  - User profile (age, sex/gender, weight)
  - Goal (type + pace)
  - Training context (hard sessions, cardio minutes, days/wk)
  - Diet rollup (14d nutrition averages — fiber, omega-3, plants, sat-fat,
    micronutrient gaps, etc.)
  - Current stack (avoids duplicates + flags interactions)

into a tiered list of recommendations. Pure-ish (reads DB, no AI). Returns
typed `Rec` dicts ready to JSON.

Design rules:
  - Cautious language: "may support" / "consider" / "useful for".
    Never "fixes" / "boosts hormones" / "prevents disease".
  - Each rec has an explicit `signals` list so the UI can show the
    underlying evidence. ("Logged 2 omega-3 servings in 14 days; goal is
    body_recomp; you're 42 years old.")
  - `priority` ∈ {high, moderate, low} — UI can surface high first.
  - `evidence_tier` ∈ {strong, moderate, limited} — separate from priority.
    A high-evidence supp can still be low-priority if signals are weak.
  - Stack is checked: if user already takes the slug or category, we
    skip (e.g. don't recommend creatine_monohydrate if creatine_hcl is
    already in the stack).
"""
from __future__ import annotations

from typing import Any
from sqlmodel import Session, select


def build_recommendations(
    db: Session,
    user_id: int,
) -> dict:
    """Return {recommendations: [...], warnings: {duplicate_ingredient_ids: [...]}}."""
    from datetime import date, timedelta
    from app.models import (
        SupplementIngredient, UserSupplementStack, UserGoal, UserProfile,
        WorkoutCompletion,
    )
    from app.services.nutrition.gut_health import compute_weekly_rollup

    # ── 1. Pull user profile ────────────────────────────────────────
    profile = db.exec(
        select(UserProfile).where(UserProfile.user_id == user_id)
    ).first()
    age = profile.age if profile else None
    weight_lbs = profile.weight_lbs if profile else None
    gender_value = (profile.gender.value if profile and profile.gender else "").lower()
    is_female = gender_value == "female"

    # ── 2. Pull active goal ─────────────────────────────────────────
    goal_row = db.exec(
        select(UserGoal)
        .where(UserGoal.user_id == user_id)
        .where(UserGoal.is_active == True)  # noqa: E712
        .order_by(UserGoal.created_at.desc())
    ).first()
    goal_type = goal_row.goal_type.value.lower() if goal_row and goal_row.goal_type else ""

    # ── 3. Pull current stack (slugs + categories) ──────────────────
    stack_rows = db.exec(
        select(UserSupplementStack).where(
            UserSupplementStack.user_id == user_id,
            UserSupplementStack.active == True,  # noqa: E712
        )
    ).all()
    stack_slugs: set[str] = set()
    stack_categories: set[str] = set()
    for item in stack_rows:
        if item.supplement_ingredient_id:
            ing = db.get(SupplementIngredient, item.supplement_ingredient_id)
            if ing:
                stack_slugs.add(ing.slug)
                if ing.category:
                    stack_categories.add(ing.category.lower())

    # Convenience helpers — treat the whole class as covered if the
    # user takes any variant. Avoids "you take creatine HCl, here's
    # creatine monohydrate" duplicates.
    def in_stack(slug: str, *aliases: str, category: str | None = None) -> bool:
        if slug in stack_slugs:
            return True
        for a in aliases:
            if a in stack_slugs:
                return True
        if category and category.lower() in stack_categories:
            return True
        return False

    # ── 4. Pull diet rollup (14d) ───────────────────────────────────
    try:
        rollup = compute_weekly_rollup(db, user_id=user_id, days=14)
    except Exception:
        rollup = {}

    omega3 = rollup.get("omega3_servings", 0) or 0
    seafood = rollup.get("seafood_servings", 0) or 0
    plants = rollup.get("distinct_plant_foods_week", 0) or 0
    avg_cals = rollup.get("avg_calories", 0) or 0
    avg_protein = rollup.get("avg_protein_g", 0) or 0
    fiber = rollup.get("avg_fiber_g", 0) or 0
    sat_fat = rollup.get("avg_saturated_fat_g", 0) or 0
    sodium_mg = rollup.get("avg_sodium_mg", 0) or 0
    plant_protein = rollup.get("avg_plant_protein_g", 0) or 0
    animal_protein = rollup.get("avg_animal_protein_g", 0) or 0
    fermented = rollup.get("fermented_servings", 0) or 0
    plant_protein_pct = (
        plant_protein / (plant_protein + animal_protein) * 100
        if (plant_protein + animal_protein) > 0 else 0
    )

    # ── 5. Pull workout context (14d) ───────────────────────────────
    cutoff = date.today() - timedelta(days=14)
    completions = db.exec(
        select(WorkoutCompletion)
        .where(WorkoutCompletion.user_id == user_id)
        .where(WorkoutCompletion.workout_date >= cutoff)
    ).all()
    sessions_14d = len(completions)
    hard_sessions_14d = sum(
        1 for c in completions
        if (c.duration_seconds or 0) >= 45 * 60
        and (c.intensity or "").lower() in ("hard", "moderate")
    )
    cardio_sessions_14d = sum(
        1 for c in completions
        if "cardio" in (c.focus_label or "").lower()
        or "zone" in (c.focus_label or "").lower()
        or "interval" in (c.focus_label or "").lower()
    )
    total_minutes = sum((c.duration_seconds or 0) for c in completions) / 60.0
    days_per_week_signal = sessions_14d / 2.0  # 14d → per-week

    # ── 6. Compute protein adequacy (vs. goal-aware target) ─────────
    # Rough target: muscle_gain/strength = 0.9g/lb, body_recomp = 0.8,
    # fat_loss = 1.0 (high to preserve LBM under deficit), default 0.7.
    protein_target_g = None
    if weight_lbs:
        if goal_type in ("muscle_gain", "strength", "athletic_performance"):
            protein_target_g = weight_lbs * 0.9
        elif goal_type == "body_recomp":
            protein_target_g = weight_lbs * 0.85
        elif goal_type in ("fat_loss", "toning"):
            protein_target_g = weight_lbs * 1.0  # protect LBM under deficit
        else:
            protein_target_g = weight_lbs * 0.7

    protein_gap_pct = (
        (protein_target_g - avg_protein) / protein_target_g * 100
        if protein_target_g and protein_target_g > 0 else 0
    )

    # ── 7. Build recs ────────────────────────────────────────────────
    rec: list[dict] = []

    def add(slug: str | None, *, title: str, reason: str, guidance: str,
            evidence: str, risk: str, priority: str, signals: list[str]):
        rec.append({
            "slug": slug,
            "title": title,
            "reason": reason,
            "cautious_guidance": guidance,
            "evidence_tier": evidence,
            "risk_tier": risk,
            "priority": priority,
            "signals": signals,
        })

    # Omega-3 — diet gap
    if omega3 < 1 and seafood < 1 and not in_stack("omega_3", "fish_oil", "epa_dha", "algae_oil"):
        sigs = [f"omega-3 servings 14d: {omega3:.1f}", f"seafood servings 14d: {seafood:.1f}"]
        priority = "high" if (age or 0) >= 40 else "moderate"
        if priority == "high":
            sigs.append(f"age {age} (cardiovascular emphasis after 40)")
        add(
            slug="omega_3",
            title="Omega-3 (EPA/DHA) may be worth considering",
            reason=f"Logged omega-3 food intake is low — {omega3:.0f} omega-3 + {seafood:.0f} seafood servings in 14 days.",
            guidance="Fatty fish 2x/week is the best first step. If unrealistic, a high-quality EPA/DHA supplement (1-2g combined) can help. Algae-derived for vegan diets. Discuss with a clinician if on blood thinners.",
            evidence="moderate", risk="low", priority=priority, signals=sigs,
        )

    # Vitamin D — bumped priority for older users + low sunlight regions
    if not in_stack("vitamin_d3", "vitamin_d", "vit_d"):
        priority = "high" if (age or 0) >= 50 else "moderate"
        sigs = []
        if age:
            sigs.append(f"age {age}")
            if age >= 50:
                sigs.append("vitamin D needs increase with age")
        add(
            slug="vitamin_d3",
            title="Vitamin D — bloodwork is the cleanest gauge",
            reason="Dietary vitamin D is hard to get from food alone; serum levels depend heavily on sun exposure and skin tone.",
            guidance="Bloodwork tells you where you actually stand. If you supplement, take D3 (1000-2000 IU) with a fat-containing meal. Discuss dosing with a clinician — high doses can interact with calcium.",
            evidence="moderate", risk="moderate", priority=priority, signals=sigs,
        )

    # Creatine — goal-aware priority
    if not in_stack("creatine_monohydrate", "creatine", "creatine_hcl", "creatine_ethyl_ester"):
        if goal_type in ("strength", "muscle_gain", "body_recomp", "athletic_performance"):
            priority = "high" if hard_sessions_14d >= 4 else "moderate"
            reason = (
                f"Strong evidence for your {goal_type.replace('_', ' ')} goal — "
                f"reliable strength + lean-mass gains in trained lifters."
            )
            sigs = [f"goal: {goal_type}", f"hard sessions 14d: {hard_sessions_14d}"]
        else:
            priority = "low"
            reason = "One of the most-studied supplements for strength and lean mass."
            sigs = []
        add(
            slug="creatine_monohydrate",
            title="Creatine may support training performance",
            reason=reason,
            guidance="5g daily. Consistency matters more than timing. Stay well-hydrated. Discuss with a clinician if you have kidney disease.",
            evidence="strong", risk="low", priority=priority, signals=sigs,
        )

    # Protein — gap + goal aware
    if (
        protein_target_g and protein_gap_pct > 15
        and goal_type in ("muscle_gain", "body_recomp", "strength", "fat_loss", "toning")
        and not in_stack("whey_protein", "whey", "protein_powder", "casein", "plant_protein", category="protein")
    ):
        priority = "high" if protein_gap_pct > 25 else "moderate"
        sigs = [
            f"goal: {goal_type}",
            f"avg protein 14d: {avg_protein:.0f}g (target ~{protein_target_g:.0f}g)",
            f"gap: {protein_gap_pct:.0f}% below target",
        ]
        # Vegan/vegetarian users get plant-based variant
        suggest_plant = plant_protein_pct >= 60
        title = (
            "Plant protein for closing your protein gap" if suggest_plant
            else "Whey protein for closing your protein gap"
        )
        product_guidance = (
            "Pea or pea+rice blend hits a complete amino-acid profile. 25-40g per serving."
            if suggest_plant
            else "Whey isolate if lactose-sensitive. 20-40g per shake post-workout or with a meal."
        )
        add(
            slug="plant_protein" if suggest_plant else "whey_protein",
            title=title,
            reason=f"Your {goal_type.replace('_', ' ')} goal needs ~{protein_target_g:.0f}g protein/day; you're averaging {avg_protein:.0f}g.",
            guidance=product_guidance,
            evidence="strong", risk="low", priority=priority, signals=sigs,
        )

    # Magnesium — heavy training weeks OR older users (poor sleep often correlates)
    if not in_stack("magnesium_glycinate", "magnesium", "magnesium_citrate", "magnesium_oxide", category="magnesium"):
        signals_present = []
        priority = None
        if hard_sessions_14d >= 5:
            signals_present.append(f"hard sessions 14d: {hard_sessions_14d}")
            priority = "moderate"
        if (age or 0) >= 50:
            signals_present.append(f"age {age} (magnesium absorption declines)")
            priority = priority or "moderate"
        if signals_present:
            add(
                slug="magnesium_glycinate",
                title="Magnesium may support recovery + sleep",
                reason="Magnesium aids muscle relaxation and sleep quality. Common subclinical shortfall in heavy trainers and older adults.",
                guidance="200-400mg glycinate or citrate in the evening. Avoid oxide — poorly absorbed. If you take blood-pressure or diuretic meds, discuss with a clinician.",
                evidence="moderate", risk="low", priority=priority, signals=signals_present,
            )

    # B12 — flagged for high plant-protein ratio (likely low animal-source intake)
    if (
        plant_protein_pct >= 70 and (plant_protein + animal_protein) > 0
        and not in_stack("vitamin_b12", "b12", "methylcobalamin", "cyanocobalamin", category="b_complex")
    ):
        sigs = [f"plant protein share: {plant_protein_pct:.0f}%"]
        add(
            slug="vitamin_b12",
            title="Vitamin B12 — diet pattern may not provide enough",
            reason=f"Your protein is {plant_protein_pct:.0f}% plant-sourced — B12 is found almost exclusively in animal products.",
            guidance="500-1000mcg methylcobalamin sublingual works well. Get serum B12 + MMA tested if you've been plant-based for 1+ year.",
            evidence="strong", risk="low", priority="moderate", signals=sigs,
        )

    # Iron — female-specific signal, especially with low animal protein
    if (
        is_female and animal_protein < 30 and (avg_protein > 0)
        and not in_stack("iron", "ferrous_sulfate", "ferrous_bisglycinate", category="iron")
    ):
        sigs = ["female biological sex (higher iron needs)", f"animal protein 14d: {animal_protein:.0f}g/day"]
        add(
            slug="iron_bisglycinate",
            title="Iron — get bloodwork before supplementing",
            reason="Premenopausal women have higher iron needs and lower animal-source intake correlates with deficiency risk.",
            guidance="DON'T supplement iron without bloodwork (ferritin + iron + TIBC). Iron overload is a real risk. Pair with vitamin C if levels are low. Discuss with a clinician.",
            evidence="moderate", risk="moderate", priority="moderate", signals=sigs,
        )

    # Calcium — older female users with low calcium-rich foods. Heuristic
    # placeholder; better to surface "discuss with clinician" than to push.
    if (
        is_female and (age or 0) >= 50
        and not in_stack("calcium", "calcium_citrate", "calcium_carbonate", category="calcium")
    ):
        sigs = [f"age {age}", "female biological sex (postmenopausal bone-health window)"]
        add(
            slug=None,
            title="Calcium + Vitamin D — discuss bone-health screening",
            reason="Bone-density loss accelerates after menopause. Diet first (dairy, leafy greens), bloodwork second.",
            guidance="500-1000mg calcium from food is ideal. If supplementing, citrate is better absorbed than carbonate. Don't co-take with iron — they compete. DEXA scan recommendation comes from a clinician.",
            evidence="strong", risk="low", priority="moderate", signals=sigs,
        )

    # Beta-alanine — endurance/athletic goals
    if (
        goal_type in ("endurance", "athletic_performance", "hyrox")
        and not in_stack("beta_alanine", "beta-alanine", category="endurance")
    ):
        sigs = [f"goal: {goal_type}", f"cardio sessions 14d: {cardio_sessions_14d}"]
        add(
            slug="beta_alanine",
            title="Beta-alanine for sustained-effort cardio",
            reason=f"Your {goal_type.replace('_', ' ')} goal benefits from carnosine buffering — useful for 1-4 min interval work.",
            guidance="3-6g daily, split across the day to reduce paresthesia (skin tingling — harmless). Effects accumulate over 4 weeks.",
            evidence="strong", risk="low", priority="moderate", signals=sigs,
        )

    # Caffeine — fat-loss goal, NOT recommended for users with already-high stim use
    if (
        goal_type == "fat_loss" and not in_stack("caffeine", "caffeine_anhydrous")
        and "stimulants" not in stack_categories
    ):
        sigs = ["goal: fat_loss", "preserves training output under caloric deficit"]
        add(
            slug="caffeine",
            title="Caffeine pre-workout for performance under a deficit",
            reason="Caffeine reliably preserves output when calories are restricted.",
            guidance="200mg ~30min before training. Cap total daily at 400mg. Avoid within 8h of bedtime — sleep quality matters more than the workout boost.",
            evidence="strong", risk="low", priority="low", signals=sigs,
        )

    # Electrolytes — high cardio volume OR high training minutes
    if (
        (cardio_sessions_14d >= 4 or total_minutes >= 600)
        and not in_stack("electrolytes", "sodium", "lmnt", category="electrolytes")
    ):
        sigs = [
            f"cardio sessions 14d: {cardio_sessions_14d}",
            f"total training minutes 14d: {total_minutes:.0f}",
        ]
        add(
            slug="electrolytes",
            title="Electrolytes for high training volume",
            reason="High cardio + total minutes mean meaningful sweat losses. Plain water alone can leave you sodium-deficient.",
            guidance="500-1000mg sodium during long sessions (60+ min). Plus potassium + magnesium. Skip sugar-loaded sport drinks unless racing.",
            evidence="moderate", risk="low", priority="moderate", signals=sigs,
        )

    # Probiotic — low fermented + low fiber (gut-health signal)
    if (
        fermented < 2 and fiber < 18
        and not in_stack("probiotic", "probiotics", category="probiotic")
    ):
        sigs = [f"fermented servings 14d: {fermented:.0f}", f"avg fiber 14d: {fiber:.0f}g"]
        add(
            slug="probiotic",
            title="Probiotic — but food-first matters more",
            reason="Low logged fermented foods + low fiber. Targeted probiotic supplements work for specific conditions; otherwise food beats pills.",
            guidance="Yogurt, kefir, sauerkraut, kimchi, kombucha — daily. If supplementing for IBS or post-antibiotic, ask a clinician for a strain-specific recommendation, not a generic blend.",
            evidence="limited", risk="low", priority="low", signals=sigs,
        )

    # Fiber gap — food first
    if fiber and fiber < 18 and plants < 15:
        sigs = [f"avg fiber 14d: {fiber:.0f}g", f"plant variety 14d: {plants:.0f}"]
        add(
            slug=None,
            title="Dietary fiber is low — prioritize food first",
            reason=f"14-day average fiber is {fiber:.0f}g/day (target is typically 25-35g).",
            guidance="Before a fiber supplement: add oats, beans, chia, raspberries, or a daily serving of cooked greens. Whole-food fiber brings micronutrients too.",
            evidence="strong", risk="low", priority="high", signals=sigs,
        )

    # Saturated fat alert — shifted to "consider plant sterols / red yeast rice"
    # for cardiovascular emphasis users, but only as a "discuss with clinician"
    # since RYR has interactions with statins.
    if (
        sat_fat > 0 and avg_cals > 0
        and (sat_fat * 9 / avg_cals) > 0.10
        and (age or 0) >= 45
    ):
        sat_fat_pct = sat_fat * 9 / avg_cals * 100
        sigs = [f"saturated fat: {sat_fat_pct:.0f}% of calories (target ≤10%)", f"age {age}"]
        add(
            slug=None,
            title="Saturated fat is high — consider lipid bloodwork",
            reason=f"Saturated fat is averaging {sat_fat_pct:.0f}% of calories. Combined with age, lipid panel is worth a check.",
            guidance="Diet swaps first: replace some butter/red meat with olive oil + fish + nuts. Talk to a clinician about a lipid panel before adding cholesterol-targeting supplements.",
            evidence="strong", risk="low", priority="moderate", signals=sigs,
        )

    # ── 8. Stack-interaction warnings ───────────────────────────────
    seen: dict[int, int] = {}
    for item in stack_rows:
        if item.supplement_ingredient_id:
            seen[item.supplement_ingredient_id] = seen.get(item.supplement_ingredient_id, 0) + 1
    duplicates = [ing_id for ing_id, n in seen.items() if n > 1]

    # Sort: high → moderate → low; tie-break by evidence (strong > moderate > limited)
    _PRIO = {"high": 0, "moderate": 1, "low": 2}
    _EVID = {"strong": 0, "moderate": 1, "limited": 2}
    rec.sort(key=lambda r: (_PRIO.get(r["priority"], 3), _EVID.get(r["evidence_tier"], 3)))

    return {
        "recommendations": rec,
        "warnings": {
            "duplicate_ingredient_ids": duplicates,
        },
    }
