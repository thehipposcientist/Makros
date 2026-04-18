import re
from sqlmodel import Session, select, col
from app.models import Exercise, Food, FoodNutrition, FoodServing, FoodAlias, Equipment, ExerciseEquipment, GoalOption, PaceOption
from app.enums import FoodSource


def _normalize(name: str) -> str:
    """Lowercase, collapse whitespace, strip punctuation for dedup/search."""
    return re.sub(r"[^a-z0-9 ]", "", name.lower()).strip()


def _slugify(name: str) -> str:
    """Generate a slug from a display name: lowercase, underscores, alphanumeric only."""
    return re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")


# ─── Exercise + Equipment seed functions ─────────────────────────────────────


def seed_equipment(session: Session) -> None:
    """Upsert equipment by slug — updates name/category/icon on existing rows."""
    from app.seed_exercises_data import SEED_EQUIPMENT

    existing = {e.slug: e for e in session.exec(select(Equipment)).all() if e.slug}
    # Also index by name for backfilling slugs on pre-existing rows
    existing_by_name = {e.name: e for e in session.exec(select(Equipment)).all()}
    added = 0
    updated = 0

    for entry in SEED_EQUIPMENT:
        slug = entry["slug"]
        name = entry["name"]

        if slug in existing:
            eq = existing[slug]
            eq.name = name
            eq.category = entry["category"]
            eq.icon = entry["icon"]
            session.add(eq)
            updated += 1
        elif name in existing_by_name:
            # Backfill slug on pre-existing row matched by name
            eq = existing_by_name[name]
            eq.slug = slug
            eq.category = entry["category"]
            eq.icon = entry["icon"]
            session.add(eq)
            updated += 1
        else:
            session.add(Equipment(
                slug=slug,
                name=name,
                category=entry["category"],
                icon=entry["icon"],
                is_custom=False,
            ))
            added += 1

    session.commit()
    if added or updated:
        print(f"[seed] equipment: {added} new, {updated} updated")


def seed_exercises(session: Session) -> None:
    """
    Upsert exercises by slug, then sync ExerciseEquipment mappings.

    - Existing exercises (by slug or name): all fields updated.
    - New exercises: created.
    - ExerciseEquipment: replaced to match current seed data.
    """
    from app.seed_exercises_data import SEED_EXERCISES, SEED_EQUIPMENT
    from app.seed_exercises_validation import (
        validate_exercise_seed, validate_equipment_seed,
    )

    validate_equipment_seed(SEED_EQUIPMENT)
    validate_exercise_seed(
        SEED_EXERCISES,
        equipment_slugs={eq["slug"] for eq in SEED_EQUIPMENT},
    )

    # Build equipment slug -> id lookup
    equip_by_slug: dict[str, int] = {}
    for eq in session.exec(select(Equipment)).all():
        if eq.slug:
            equip_by_slug[eq.slug] = eq.id

    # Index existing exercises
    existing_by_slug: dict[str, Exercise] = {}
    existing_by_name: dict[str, Exercise] = {}
    for ex in session.exec(select(Exercise)).all():
        if ex.slug:
            existing_by_slug[ex.slug] = ex
        existing_by_name[ex.name] = ex

    added = 0
    updated = 0

    for entry in SEED_EXERCISES:
        slug = entry["slug"]
        name = entry["name"]

        # Find existing by slug first, then by name (backfill slug)
        ex = existing_by_slug.get(slug) or existing_by_name.get(name)

        if ex:
            # Update all fields
            ex.slug = slug
            ex.name = name
            ex.primary_muscle = entry["primary_muscle"]
            ex.secondary_muscles = entry["secondary_muscles"]
            ex.equipment = entry["equipment_bucket"]
            ex.is_compound = entry["is_compound"]
            ex.description = entry["description"]
            ex.movement_pattern = entry.get("movement_pattern")
            ex.exercise_type = entry.get("exercise_type", "strength")
            ex.is_machine = entry.get("is_machine", False)
            ex.is_unilateral = entry.get("is_unilateral", False)
            session.add(ex)
            updated += 1
        else:
            ex = Exercise(
                slug=slug,
                name=name,
                primary_muscle=entry["primary_muscle"],
                secondary_muscles=entry["secondary_muscles"],
                equipment=entry["equipment_bucket"],
                is_compound=entry["is_compound"],
                description=entry["description"],
                is_custom=False,
                movement_pattern=entry.get("movement_pattern"),
                exercise_type=entry.get("exercise_type", "strength"),
                is_machine=entry.get("is_machine", False),
                is_unilateral=entry.get("is_unilateral", False),
            )
            session.add(ex)
            added += 1

        session.flush()  # ensure ex.id is populated

        # ── Sync ExerciseEquipment mappings ──────────────────────────
        old_mappings = session.exec(
            select(ExerciseEquipment).where(ExerciseEquipment.exercise_id == ex.id)
        ).all()
        for m in old_mappings:
            session.delete(m)
        session.flush()

        for eq_entry in entry.get("equipment", []):
            eq_id = equip_by_slug.get(eq_entry["slug"])
            if not eq_id:
                continue  # equipment not seeded yet — skip silently
            session.add(ExerciseEquipment(
                exercise_id=ex.id,
                equipment_id=eq_id,
                required=eq_entry.get("required", True),
                role=eq_entry.get("role", "primary"),
            ))

    session.commit()
    if added or updated:
        print(f"[seed] exercises: {added} new, {updated} updated")


# ─── Legacy exercise data removed — see seed_exercises_data.py ───────────────

EXERCISES = []  # kept as empty list so any imports don't break


# ─── Food library seed data ───────────────────────────────────────────────────
# Format: (name, category, unit, calories, protein, carbs, fat)
#
# category must match FoodCategory enum:
#   proteins | plant_proteins | grains_carbs | vegetables | fruits | dairy | fats_oils

def _validate_macros(name: str, n: dict) -> None:
    """Warn if calories don't roughly match protein*4 + carbs*4 + fat*9."""
    expected = n.get("protein", 0) * 4 + n.get("carbs", 0) * 4 + n.get("fat", 0) * 9
    actual = n.get("calories", 0)
    if actual == 0 and expected == 0:
        return
    if expected == 0:
        return  # e.g. creatine has 0 macros
    diff_pct = abs(actual - expected) / expected * 100
    if diff_pct > 15:
        print(f"[seed] WARNING: {name} — calories={actual} but P*4+C*4+F*9={expected:.0f} (off by {diff_pct:.0f}%)")


def _compute_serving_macros(nutrition: dict, serving_grams: float, ref_grams: float) -> dict:
    """Scale per-100g nutrition to a given serving size."""
    if ref_grams <= 0:
        ratio = 1.0
    else:
        ratio = serving_grams / ref_grams
    return {
        "calories": round(nutrition["calories"] * ratio, 1),
        "protein": round(nutrition["protein"] * ratio, 1),
        "carbs": round(nutrition["carbs"] * ratio, 1),
        "fat": round(nutrition["fat"] * ratio, 1),
    }


def seed_foods(session: Session) -> None:
    """
    Idempotent food seeder — upserts Food + FoodNutrition + FoodServings + FoodAliases.

    - New foods: created with all related rows.
    - Existing foods (by normalized_name, source=seed): nutrition updated,
      servings replaced, aliases synced.
    - Runs `validate_seed` at start to surface data-quality issues. Warnings
      are logged but do not block seeding.
    """
    from app.seed_foods_data import SEED_FOODS
    from app.seed_validation import validate_seed

    validate_seed(SEED_FOODS)

    # Index existing seed foods by normalized_name
    existing_foods: dict[str, Food] = {}
    for f in session.exec(select(Food).where(Food.source == FoodSource.SEED)).all():
        existing_foods[f.normalized_name] = f
    # Also check non-seed foods to avoid name collisions
    all_norms = {f.normalized_name for f in session.exec(select(Food)).all()}

    added = 0
    updated = 0

    for entry in SEED_FOODS:
        name = entry["name"]
        norm = _normalize(name)
        n = entry["nutrition"]
        category = entry["category"]
        servings_data = entry.get("servings", [{"label": "100g", "grams": 100, "is_default": True}])
        aliases_data = entry.get("aliases", [])

        _validate_macros(name, n)

        # Reference grams is 100 (all nutrition is per 100g)
        ref_grams = 100.0

        if norm in existing_foods:
            # ── Update existing seed food ────────────────────────────────
            food = existing_foods[norm]
            food.name = name
            food.category = category
            food.is_verified = True
            food.is_active = True
            # Legacy columns
            food.calories = n["calories"]
            food.protein = n["protein"]
            food.carbs = n["carbs"]
            food.fat = n["fat"]
            session.add(food)

            # Upsert FoodNutrition. Pull the canonical micronutrient panel
            # from `seed_micronutrients_data` so existing seeded foods get
            # backfilled on the next boot — no DB drop needed.
            from app.seed_micronutrients_data import (
                get_micronutrients_for, split_into_columns_and_extras,
            )
            micros_panel = get_micronutrients_for(name)
            if micros_panel:
                top_cols, extras = split_into_columns_and_extras(micros_panel)
                fiber_v   = top_cols.get("fiber",   n.get("fiber"))
                sugar_v   = top_cols.get("sugar",   n.get("sugar"))
                sodium_v  = top_cols.get("sodium_mg", n.get("sodium_mg"))
                extras_v  = extras or None
            else:
                fiber_v  = n.get("fiber")
                sugar_v  = n.get("sugar")
                sodium_v = n.get("sodium_mg")
                extras_v = None

            fn = session.exec(
                select(FoodNutrition).where(FoodNutrition.food_id == food.id)
            ).first()
            if fn:
                fn.reference_unit = "100g"
                fn.reference_grams = ref_grams
                fn.calories = n["calories"]
                fn.protein = n["protein"]
                fn.carbs = n["carbs"]
                fn.fat = n["fat"]
                fn.fiber = fiber_v
                fn.sugar = sugar_v
                fn.sodium_mg = sodium_v
                # Only overwrite extra_nutrients if the seed has data AND
                # the existing value is empty. AI enrichment populates
                # this with Layer 2 micros (omega-3, calcium, etc.) and
                # we must NOT wipe it on every container restart.
                if extras_v and not fn.extra_nutrients:
                    fn.extra_nutrients = extras_v
                session.add(fn)
            else:
                session.add(FoodNutrition(
                    food_id=food.id,
                    reference_unit="100g",
                    reference_grams=ref_grams,
                    calories=n["calories"], protein=n["protein"],
                    carbs=n["carbs"], fat=n["fat"],
                    fiber=fiber_v, sugar=sugar_v, sodium_mg=sodium_v,
                    extra_nutrients=extras_v,
                ))

            # Replace servings — delete old, insert new
            old_servings = session.exec(
                select(FoodServing).where(FoodServing.food_id == food.id)
            ).all()
            for s in old_servings:
                session.delete(s)
            session.flush()

            has_default = any(s.get("is_default") for s in servings_data)
            for i, s in enumerate(servings_data):
                macros = _compute_serving_macros(n, s["grams"], ref_grams)
                is_def = s.get("is_default", False) or (not has_default and i == 0)
                session.add(FoodServing(
                    food_id=food.id, label=s["label"], grams=s["grams"],
                    is_default=is_def, **macros,
                ))

            # Sync aliases — delete old seed aliases, insert new
            old_aliases = session.exec(
                select(FoodAlias).where(FoodAlias.food_id == food.id)
            ).all()
            for a in old_aliases:
                session.delete(a)
            session.flush()

            for alias in aliases_data:
                alias_norm = _normalize(alias)
                if alias_norm and alias_norm != norm:
                    session.add(FoodAlias(
                        food_id=food.id, alias=alias, alias_normalized=alias_norm,
                    ))

            updated += 1
            continue

        # ── Create new food ──────────────────────────────────────────────
        # Skip if a non-seed food already has this normalized name
        if norm in all_norms:
            continue

        # Find default serving for legacy columns
        default_serving = next(
            (s for s in servings_data if s.get("is_default")),
            servings_data[0],
        )

        food = Food(
            name=name,
            normalized_name=norm,
            category=category,
            source=FoodSource.SEED,
            is_verified=True,
            is_custom=False,
            # Legacy columns
            unit=default_serving["label"],
            calories=n["calories"],
            protein=n["protein"],
            carbs=n["carbs"],
            fat=n["fat"],
            fiber=n.get("fiber"),
            serving_grams=default_serving["grams"],
        )
        session.add(food)
        session.flush()  # get food.id

        # FoodNutrition (per 100g). Merge in the canonical micronutrient
        # panel from `seed_micronutrients_data.py` if one exists for this
        # food. The panel may override fiber/sugar/sodium_mg from the inline
        # seed (which is sparse) AND populates the JSON `extra_nutrients`
        # column with the full vitamin/mineral/fat panel. Foods without
        # an entry in the lookup keep whatever the inline seed had.
        from app.seed_micronutrients_data import (
            get_micronutrients_for, split_into_columns_and_extras,
        )
        micros_panel = get_micronutrients_for(name)
        if micros_panel:
            top_cols, extras = split_into_columns_and_extras(micros_panel)
            fiber_v   = top_cols.get("fiber",   n.get("fiber"))
            sugar_v   = top_cols.get("sugar",   n.get("sugar"))
            sodium_v  = top_cols.get("sodium_mg", n.get("sodium_mg"))
            extras_v  = extras or None
        else:
            fiber_v  = n.get("fiber")
            sugar_v  = n.get("sugar")
            sodium_v = n.get("sodium_mg")
            extras_v = None
        session.add(FoodNutrition(
            food_id=food.id,
            reference_unit="100g",
            reference_grams=ref_grams,
            calories=n["calories"], protein=n["protein"],
            carbs=n["carbs"], fat=n["fat"],
            fiber=fiber_v, sugar=sugar_v, sodium_mg=sodium_v,
            extra_nutrients=extras_v,
        ))

        # FoodServings with pre-calculated macros
        has_default = any(s.get("is_default") for s in servings_data)
        for i, s in enumerate(servings_data):
            macros = _compute_serving_macros(n, s["grams"], ref_grams)
            is_def = s.get("is_default", False) or (not has_default and i == 0)
            session.add(FoodServing(
                food_id=food.id, label=s["label"], grams=s["grams"],
                is_default=is_def, **macros,
            ))

        # FoodAliases
        for alias in aliases_data:
            alias_norm = _normalize(alias)
            if alias_norm and alias_norm != norm:
                session.add(FoodAlias(
                    food_id=food.id, alias=alias, alias_normalized=alias_norm,
                ))

        all_norms.add(norm)
        added += 1

    session.commit()
    if added or updated:
        print(f"[seed] foods: {added} new, {updated} updated")

# ─── Goal & Pace seed data ────────────────────────────────────────────────────

# Canonical goal list exposed to users. Sourced from
# `app.services.workout.goals` so the registry (planner buckets +
# aliases + support flags) and the seed UI metadata can never drift.
# Add / remove / rename goals in `goals.py`, not here.
from app.services.workout.goals import ui_goal_rows as _ui_goal_rows

GOAL_OPTIONS_DATA = _ui_goal_rows()

PACE_OPTIONS_DATA = [
    # Fat loss
    ("fat_loss", "conservative", "Slow & Steady",   "leaf-outline", "~0.5 lbs/week",  "Sustainable pace — preserves muscle, easiest to stick to"),
    ("fat_loss", "moderate",     "Balanced",         "walk-outline", "~1 lb/week",     "Recommended for most — good results without feeling deprived"),
    ("fat_loss", "aggressive",   "Aggressive",       "rocket-outline", "~1.5 lbs/week",  "Fastest fat loss — requires high adherence and discipline"),

    # Muscle gain
    ("muscle_gain", "conservative", "Lean Bulk",       "leaf-outline", "~0.25 lbs/week", "Minimal fat gain — slow, clean muscle accumulation"),
    ("muscle_gain", "moderate",     "Standard Bulk",   "barbell-outline", "~0.5 lbs/week",  "Best balance of muscle gain vs fat — most popular approach"),
    ("muscle_gain", "aggressive",   "Aggressive Bulk", "trending-up-outline", "~1 lb/week",     "Maximum muscle gain — expect some added body fat"),

    # Body recomposition
    ("body_recomp", "conservative", "Gradual Recomp",   "leaf-outline", "Slow shift",    "High protein + slight deficit — very sustainable, slower visual change"),
    ("body_recomp", "moderate",     "Steady Recomp",    "swap-horizontal-outline", "Steady effort", "Balanced nutrition and consistent training for noticeable changes over months"),
    ("body_recomp", "aggressive",   "Intensive Recomp", "flame-outline", "High effort",   "Strict calorie cycling and high training volume — best results fastest"),

    # Toning
    ("toning", "conservative", "Gentle Tone",   "leaf-outline", "~0.5 lbs/week",  "Slow lean-out — very sustainable, no crash dieting"),
    ("toning", "moderate",     "Steady Tone",   "walk-outline", "~0.75 lbs/week", "Good balance of speed and comfort for visible definition"),
    ("toning", "aggressive",   "Fast Tone",     "rocket-outline", "~1 lb/week",     "Quicker definition — stricter diet and more training required"),

    # Strength
    ("strength", "conservative", "Skill Focus",        "book-outline", "Technique first",   "Master movement patterns, light and gradual load increases"),
    ("strength", "moderate",     "Progressive Overload","barbell-outline", "Weekly PR gains",   "Steady linear or wave-load progression — most reliable approach"),
    ("strength", "aggressive",   "Peaking",            "trophy-outline", "Max effort blocks",  "High-intensity training cycles, frequent heavy days, competition prep"),

    # Endurance
    ("endurance", "conservative", "Easy Base",    "leaf-outline", "+10% vol/week",  "Build your aerobic base at easy, conversational pace"),
    ("endurance", "moderate",     "Steady Build", "walk-outline", "+15% vol/week",  "Mix of easy, tempo, and moderate sessions for well-rounded fitness"),
    ("endurance", "aggressive",   "Race Prep",    "bicycle-outline", "+20% vol/week",  "High weekly volume with quality speed work — training for events"),

    # Athletic performance
    ("athletic_performance", "conservative", "Foundation",       "leaf-outline", "Base building",    "Develop strength, movement quality, and aerobic base"),
    ("athletic_performance", "moderate",     "Sport-Ready",      "flash-outline", "Balanced output",  "Well-rounded mix of strength, speed, power, and conditioning"),
    ("athletic_performance", "aggressive",   "Peak Performance", "trophy-outline", "Competition prep", "Maximum effort across all physical attributes — for serious athletes"),

    # Maintain
    ("maintain", "conservative", "Light Active",   "leaf-outline", "2-3x/week", "Casual, low-effort sessions to stay mobile and healthy"),
    ("maintain", "moderate",     "Steady Active",  "checkmark-circle-outline", "3-4x/week", "Consistent training to hold your current fitness and physique"),
    ("maintain", "aggressive",   "Active Lifestyle","flame-outline", "5x/week",   "Stay highly active, keep challenging yourself without major goals"),

    # flexibility and stress_relief pace rows were removed alongside
    # their goal entries in the goal-honesty pass. They stay resolvable
    # in `goals.py` (unsupported=True) for stale user profiles but
    # aren't seeded as new pace options.
]


def seed_goals(session: Session) -> None:
    """Upsert goal and pace options by value — inserts new, skips existing."""
    existing_goals = set(r.value for r in session.exec(select(GoalOption)).all())
    added_goals = 0
    for value, label, icon, description in GOAL_OPTIONS_DATA:
        if value not in existing_goals:
            session.add(GoalOption(
                value=value,
                label=label,
                icon=icon,
                description=description,
            ))
            added_goals += 1
    session.commit()
    if added_goals:
        print(f"[seed] inserted {added_goals} goal options")

    existing_paces = set(
        (r.goal_value, r.value) for r in session.exec(select(PaceOption)).all()
    )
    added_paces = 0
    for goal_value, pace_value, label, icon, rate, description in PACE_OPTIONS_DATA:
        if (goal_value, pace_value) not in existing_paces:
            session.add(PaceOption(
                goal_value=goal_value,
                value=pace_value,
                label=label,
                icon=icon,
                rate=rate,
                description=description,
            ))
            added_paces += 1
    session.commit()
    if added_paces:
        print(f"[seed] inserted {added_paces} pace options")
