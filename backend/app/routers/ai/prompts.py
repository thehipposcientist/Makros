from __future__ import annotations

from .models import PlanRequest
from .utils import compute_tdee_and_targets



def _meal_schema_and_targets(t: dict) -> tuple[str, str]:
    """
    Return (meal_target_summary, meal_json_schema_fragment) appropriate for
    the number of meals in this plan.
    """
    meals = t["meals"]

    def _meal_block(name: str, cal: int, prot: int, carb: int, fat_g: int) -> str:
        # IMPORTANT: the canonical field is now `items` — a structured list
        # where `name`, `quantity`, and `unit` are separate. Do NOT put the
        # quantity inside the food name (wrong: "2 eggs"; right:
        # {name: "eggs", quantity: 2, unit: "piece"}). The app edits each
        # item's quantity and unit independently of the name.
        return (
            f'    "{name}": {{\n'
            f'      "meal": "Short descriptive recipe name",\n'
            f'      "items": [\n'
            f'        {{"name": "plain food name, no quantity", "quantity": 1, "unit": "g|oz|lb|ml|fl_oz|cup|tbsp|tsp|piece|slice|scoop|serving", "calories": 0, "protein": 0, "carbs": 0, "fat": 0}}\n'
            f'      ],\n'
            f'      "calories": {cal},\n'
            f'      "protein": {prot},\n'
            f'      "carbs": {carb},\n'
            f'      "fat": {fat_g},\n'
            f'      "fiber": 0,\n'
            f'      "micronutrients": {{"fiber": 0, "sugar": 0, "sodium": 0, "cholesterol": 0, "vitaminA": 0, "vitaminC": 0, "vitaminD": 0, "calcium": 0, "iron": 0, "potassium": 0}},\n'
            f'      "estimated_alignment": "e.g. high protein, moderate carb",\n'
            f'      "isRoutine": false\n'
            f'    }}'
        )

    def _target_line(name: str, cal: int, prot: int, carb: int, fat_g: int) -> str:
        return f"  {name.capitalize()}: ~{cal} cal / ~{prot}g protein / ~{carb}g carbs / ~{fat_g}g fat"

    if meals == 2:
        summary = "\n".join([
            _target_line("lunch",  t["lunch_cal"],  t["lunch_prot"],  t["lunch_carbs"],  t["lunch_fat"]),
            _target_line("dinner", t["dinner_cal"], t["dinner_prot"], t["dinner_carbs"], t["dinner_fat"]),
        ])
        schema = ",\n".join([
            _meal_block("lunch",  t["lunch_cal"],  t["lunch_prot"],  t["lunch_carbs"],  t["lunch_fat"]),
            _meal_block("dinner", t["dinner_cal"], t["dinner_prot"], t["dinner_carbs"], t["dinner_fat"]),
        ])
    elif meals == 4:
        summary = "\n".join([
            _target_line("breakfast", t["breakfast_cal"], t["breakfast_prot"], t["breakfast_carbs"], t["breakfast_fat"]),
            _target_line("lunch",     t["lunch_cal"],     t["lunch_prot"],     t["lunch_carbs"],     t["lunch_fat"]),
            _target_line("dinner",    t["dinner_cal"],    t["dinner_prot"],    t["dinner_carbs"],    t["dinner_fat"]),
            _target_line("snack",     t["snack_cal"],     t["snack_prot"],     t["snack_carbs"],     t["snack_fat"]),
        ])
        schema = ",\n".join([
            _meal_block("breakfast", t["breakfast_cal"], t["breakfast_prot"], t["breakfast_carbs"], t["breakfast_fat"]),
            _meal_block("lunch",     t["lunch_cal"],     t["lunch_prot"],     t["lunch_carbs"],     t["lunch_fat"]),
            _meal_block("dinner",    t["dinner_cal"],    t["dinner_prot"],    t["dinner_carbs"],    t["dinner_fat"]),
            _meal_block("snack",     t["snack_cal"],     t["snack_prot"],     t["snack_carbs"],     t["snack_fat"]),
        ])
    else:  # 3
        summary = "\n".join([
            _target_line("breakfast", t["breakfast_cal"], t["breakfast_prot"], t["breakfast_carbs"], t["breakfast_fat"]),
            _target_line("lunch",     t["lunch_cal"],     t["lunch_prot"],     t["lunch_carbs"],     t["lunch_fat"]),
            _target_line("dinner",    t["dinner_cal"],    t["dinner_prot"],    t["dinner_carbs"],    t["dinner_fat"]),
        ])
        schema = ",\n".join([
            _meal_block("breakfast", t["breakfast_cal"], t["breakfast_prot"], t["breakfast_carbs"], t["breakfast_fat"]),
            _meal_block("lunch",     t["lunch_cal"],     t["lunch_prot"],     t["lunch_carbs"],     t["lunch_fat"]),
            _meal_block("dinner",    t["dinner_cal"],    t["dinner_prot"],    t["dinner_carbs"],    t["dinner_fat"]),
        ])

    return summary, schema


def _build_weekly_review_section(req: PlanRequest) -> str:
    """Format weekly review data into a prompt section the AI can use."""
    wr = req.weeklyReview
    if not wr:
        return ""
    adherence = wr.get("adherence", 3)
    energy = wr.get("energy", 3)
    notes = wr.get("notes", "")
    pending = wr.get("pendingChanges", [])
    adherence_labels = {1: "completed almost none", 2: "missed most sessions", 3: "did about half", 4: "completed most", 5: "completed all"}
    energy_labels = {1: "burned out / overtrained", 2: "tired and sluggish", 3: "okay / average", 4: "good energy", 5: "great / fully recovered"}
    lines = [
        "WEEKLY CHECK-IN (use this to adapt the next week's plan):",
        f"- Workout adherence: {adherence}/5 — {adherence_labels.get(adherence, 'unknown')}",
        f"- Energy / recovery: {energy}/5 — {energy_labels.get(energy, 'unknown')}",
    ]
    if notes:
        lines.append(f"- User notes: {notes}")
    if pending:
        changes = "; ".join(p.get("summary", "") for p in pending if p.get("summary"))
        if changes:
            lines.append(f"- Profile changes made this week: {changes}")
    lines.append("")
    lines.append(
        "ADAPTATION RULES based on the check-in above:\n"
        "- If adherence ≤ 2: simplify the plan — fewer exercises per session, or fewer training days.\n"
        "- If energy ≤ 2: reduce volume/intensity — this is a deload week. Lighter weights, fewer sets.\n"
        "- If adherence and energy are both ≥ 4: consider progressing — add volume, intensity, or a new exercise variation.\n"
        "- If profile changes mention new equipment or foods: incorporate them into the plan.\n"
        "- If user notes mention pain/injury: avoid those muscle groups or movements.\n"
        "- Always explain in the trainerNote why you made specific adaptations based on this check-in."
    )
    return "\n".join(lines)


def build_workout_prompt(req: PlanRequest) -> str:
    """Prompt for workout plan only — runs in parallel with nutrition prompt."""
    ps  = req.physicalStats
    t   = compute_tdee_and_targets(req)

    height_str    = f"{ps.heightFeet}'{ps.heightInches}\""
    equipment_str = ", ".join(req.equipment) if req.equipment else "bodyweight only"
    foods_str     = ", ".join(req.foodsAvailable) if req.foodsAvailable else "general healthy foods"
    supps_str     = ", ".join(req.supplementsAvailable) if req.supplementsAvailable else None

    # ── Equipment-based forbidden list ───────────────────────────────────────
    has_barbell   = any(e in {"Barbell", "Squat rack", "Power rack", "Smith machine"} for e in req.equipment)
    has_dumbbells = any(e in {"Dumbbells", "Kettlebell"} for e in req.equipment)
    has_machines  = any(e in {
        "Cable machine", "Leg press", "Lat pulldown",
        "Chest press machine", "Seated row machine", "Leg extension", "Leg curl",
    } for e in req.equipment)
    has_pullupbar = "Pull-up bar" in req.equipment or has_barbell or has_machines
    has_bench     = any(e in {"Flat bench", "Incline bench"} for e in req.equipment)

    forbidden: list[str] = []
    if not has_barbell:   forbidden.append("barbells or barbell exercises (squat, deadlift, bench press with barbell)")
    if not has_dumbbells: forbidden.append("dumbbells or kettlebells")
    if not has_machines:  forbidden.append("cable machines, leg press, lat pulldown, or any gym machine")
    if not has_pullupbar: forbidden.append("pull-up bar exercises")
    if not has_bench:     forbidden.append("flat or incline bench exercises")
    forbidden_str = "; ".join(forbidden) if forbidden else "none"

    cardio_equipment = [e for e in req.equipment if e in {
        "Treadmill", "Stationary Bike", "Elliptical", "Rowing Machine",
        "Stair Climber", "Assault Bike", "Battle Ropes", "Jump rope", "Swimming Pool",
    }]

    # ── Goal-specific workout rule ────────────────────────────────────────────
    goal_workout_rules: dict[str, str] = {
        "muscle_gain": (
            "GOAL IS MUSCLE GAIN: Every session must be pure hypertrophy/strength lifting — "
            "compound and isolation exercises targeting specific muscle groups. "
            "DO NOT include cardio exercises. "
            "Focus: progressive overload, 3-5 sets, 6-15 reps, 60-120s rest."
        ),
        "strength": (
            "GOAL IS STRENGTH: Heavy compound movements — squat, deadlift, bench, row, overhead press. "
            "DO NOT include cardio. Low reps (3-6), high load, 2-5 min rest."
        ),
        "fat_loss": (
            "GOAL IS FAT LOSS: Strength training base (compound lifts) with ONE cardio finisher per session. "
            "Moderate rest (60-90s), higher rep ranges (10-15)."
        ),
        "toning": (
            "GOAL IS TONING: Circuit-style strength training with moderate weight, higher reps (12-20). "
            "Add one short cardio finisher (5-10 min). Short rest (45-60s)."
        ),
        "body_recomp": (
            "GOAL IS BODY RECOMPOSITION: Balanced strength training, moderate weight/reps (8-12). "
            "One optional cardio finisher. Mix compound and isolation."
        ),
        "endurance": (
            "GOAL IS ENDURANCE: Prioritise cardio sessions using available cardio equipment. "
            "Include 1-2 strength sessions per week. High reps (15-20), light weight."
        ),
        "athletic_performance": (
            "GOAL IS ATHLETIC PERFORMANCE: Mix of power-focused strength, cardio conditioning, and agility. "
            "Include explosive movements where equipment allows."
        ),
        "maintain": (
            "GOAL IS MAINTENANCE: Balanced mix of strength and cardio. Moderate volume, all rep ranges. "
            "Manageable effort — not a cut or bulk."
        ),
        "flexibility": (
            "GOAL IS FLEXIBILITY: Mobility work, dynamic stretching, yoga-style movements. "
            "Light bodyweight strength only. Avoid heavy loading."
        ),
        "stress_relief": (
            "GOAL IS STRESS RELIEF: Low-intensity, enjoyable movement. Light strength, easy cardio, yoga. "
            "Keep sessions feel-good, not exhausting."
        ),
        "longevity": (
            "GOAL IS LONGEVITY: Focus on joint-friendly compound movements, mobility work, and sustainable "
            "training. Moderate intensity, controlled tempo, emphasis on form and recovery. "
            "Avoid maximal loading or high-impact movements."
        ),
    }
    primary_rule = goal_workout_rules.get(req.goal, f"Goal is {req.goal} — choose appropriate exercise selection and intensity.")
    goal_rule = primary_rule

    # ── Hierarchical goal (new model) — overrides legacy secondaryGoal ─────
    gs = req.goalSelection
    if gs:
        modifier_lines = [f"- Modifier: {m.replace('_', ' ')}" for m in gs.modifiers] if gs.modifiers else []
        if modifier_lines:
            goal_rule += "\nGOAL MODIFIERS (apply these refinements to the plan):\n" + "\n".join(modifier_lines)
        target_focus = gs.targetFocus
    else:
        # Legacy fallback
        if req.secondaryGoal and req.secondaryGoal != req.goal:
            secondary_rule = goal_workout_rules.get(req.secondaryGoal, "")
            goal_rule = (
                f"PRIMARY GOAL: {primary_rule}\n"
                f"SECONDARY GOAL (blend into programming where possible): {secondary_rule}"
            )
        target_focus = req.focusedMuscleGroup

    focused_muscle_line = (
        f"TARGET FOCUS: The user wants to emphasise {target_focus} — "
        f"include extra volume and at least one dedicated session for {target_focus} per week."
        if target_focus else ""
    )

    # ── Experience / recovery / split context ────────────────────────────────
    exp_str      = req.experienceLevel or "intermediate"
    recovery_str = req.recoveryLevel or "normal"
    split_str    = req.preferredSplit or "auto (choose best split for the goal and days)"
    focus_str    = req.workoutFocus or "auto"

    # ── Preferred / disliked / injury lines ──────────────────────────────────
    preferred_str = (
        "Preferred exercises (use where suitable): " + ", ".join(req.preferredExercises)
        if req.preferredExercises else ""
    )
    disliked_str = (
        "Exercises to AVOID (user dislikes): " + ", ".join(req.dislikedExercises)
        if req.dislikedExercises else ""
    )
    injury_str = (
        "Injuries / limitations — avoid conflicting movements: " + ", ".join(req.injuriesOrLimitations)
        if req.injuriesOrLimitations else ""
    )

    # ── Exercise library constraint ───────────────────────────────────────────
    # The library is a closed set of exercises the user can actually do
    # given their owned equipment. Each line is `Name → Equipment` so the
    # AI can't invent generic names ("Squats") or hallucinate machines
    # ("Leg Press on the leg extension machine"). The post-processing pass
    # in `canonicalize_workout_exercises` matches the AI response back
    # against this list and rewrites any drift.
    if req.exerciseLibrary:
        lib_lines = []
        for ex in req.exerciseLibrary:
            name = ex.get("name", "")
            if not name:
                continue
            eq = ex.get("equipment", "")
            lib_lines.append(f"  - {name}" + (f" → {eq}" if eq else ""))
        # Lift-focused goals get an extra hard rule on top of the library
        # constraint. Without this the AI happily picks "Push-ups" for a
        # recomp user who owns a barbell + bench because it's "simpler",
        # which produces a circuit-style plan instead of a lifting plan.
        goal_lower = (req.goal or "").lower()
        is_lift_focused = any(t in goal_lower for t in ("muscle_gain", "muscle gain", "build_muscle", "recomp", "strength", "powerlifting", "1rm"))
        load_rule = (
            "\n\nLOAD PRIORITY (this user is training for size/strength):\n"
            "  - Primary and secondary slots MUST use loaded exercises "
            "(barbell, dumbbell, machine, or cable). Bodyweight is NOT "
            "acceptable for primary or secondary slots when a loaded "
            "alternative exists in the library above.\n"
            "  - Bodyweight exercises (push-ups, pull-ups, dips, etc.) are "
            "ONLY acceptable when (a) the user has no equipment for the "
            "movement at all, or (b) the slot is core/abs.\n"
            "  - Pull-ups and chin-ups DO count as loaded — they're a real "
            "vertical pull. Push-ups and dips do not.\n"
        ) if is_lift_focused else ""
        library_str = (
            "EXERCISE LIBRARY — you MUST choose exercises EXACTLY from this list. "
            "Use the name verbatim and do NOT invent variants. Each line shows the "
            "equipment that exercise requires:\n"
            + "\n".join(lib_lines)
            + load_rule
        )
    else:
        library_str = (
            "No exercise library provided — choose any exercises appropriate for the available equipment."
        )

    # ── Nutrition context ────────────────────────────────────────────────────
    diet_lines: list[str] = []
    if req.dietaryPreference:
        diet_lines.append(f"Dietary preference: {req.dietaryPreference}")
    if req.allergies:
        diet_lines.append(f"Allergies / intolerances (NEVER include these): {', '.join(req.allergies)}")
    if req.cookingSkill:
        diet_lines.append(f"Cooking skill: {req.cookingSkill}")
    if req.prepTimeMinutes:
        diet_lines.append(f"Max prep time per meal: {req.prepTimeMinutes} minutes")
    if req.budgetLevel:
        diet_lines.append(f"Budget: {req.budgetLevel}")
    diet_context = "\n".join(f"- {l}" for l in diet_lines) if diet_lines else "- No special dietary restrictions"

    # ── Per-meal targets and JSON schema ────────────────────────────────────
    meal_summary, meal_schema = _meal_schema_and_targets(t)

    # ── Workout prompt ────────────────────────────────────────────────────────
    return f"""You are an expert fitness coach.
Generate a personalised {req.daysPerWeek}-day weekly workout plan for this user.

USER PROFILE:
- Primary goal: {gs.primaryGoal if gs else req.goal} (category: {gs.category if gs else 'auto'}, pace: {req.goalDetails.pace}){f"  |  Modifiers: {', '.join(gs.modifiers)}" if gs and gs.modifiers else ""}{f"  |  Target focus: {gs.targetFocus}" if gs and gs.targetFocus else ""}
- Age: {ps.age}  Gender: {ps.gender}  Weight: {ps.weightLbs} lbs  Height: {height_str}
{f"- Target weight: {req.goalDetails.targetWeightLbs} lbs" if req.goalDetails.targetWeightLbs else ""}
- Training days/week: {req.daysPerWeek}  Session length: {req.workoutDurationMinutes} min
- Experience: {exp_str}  Recovery: {recovery_str}
- Preferred split: {split_str}  Focus: {focus_str}

EQUIPMENT:
Available: {equipment_str}
Cardio equipment: {', '.join(cardio_equipment) if cardio_equipment else 'none'}
FORBIDDEN (user does NOT own): {forbidden_str}

{library_str}
{preferred_str}
{disliked_str}
{injury_str}
{f"""TODAY'S CONTEXT — READ THIS CAREFULLY AND APPLY IT:
{req.userContext}

CRITICAL: Day 1 of this plan is TODAY. If the user trained any muscle group today or yesterday (as described above), that muscle group MUST NOT appear as the primary focus of Day 1. Schedule Day 1 around muscles that have had adequate rest. Rearrange the split so recovered muscles come first.""" if req.userContext else ""}

{_build_weekly_review_section(req)}
GOAL RULE (follow strictly): {goal_rule}
{focused_muscle_line}

INSTRUCTIONS:
- Provide exactly {req.daysPerWeek} training day objects.
- Each exercise: sets (int), reps (string e.g. "8-10"), restSeconds (int), equipment (string).
- Sessions should fill ~{req.workoutDurationMinutes} minutes (roughly 8 min per exercise slot).
- ONLY use exercises requiring equipment from the available list.
- If an exercise library is provided, use ONLY exercises from that list.
- Apply the TODAY'S CONTEXT above — Day 1 must respect recent muscle training and any other user preferences stated.

Return ONLY valid JSON matching this schema exactly:
{{
  "trainerNote": "120-180 word explanation. Cover: (1) WHY this split structure fits the user's goal, training days, and recovery needs — reference specific muscle groups and frequency. (2) WHY the chosen exercises fit their equipment AND any injuries/limitations — name at least 2 exercises and why. (3) HOW the progression strategy will work over the next 4 weeks (sets/reps/load). (4) What the user should FEEL by the end of a session so they can self-assess. Speak directly to the user ('you'). No generic platitudes.",
  "workout_plan": {{
    "name": "string",
    "totalDays": {req.daysPerWeek},
    "days": [
      {{
        "day": "Day 1",
        "focus": "string",
        "exercises": [
          {{"name": "string", "sets": 3, "reps": "8-10", "restSeconds": 60, "equipment": "string"}}
        ]
      }}
    ]
  }}
}}

IMPORTANT: Each day must have exactly 5 exercises. No more, no fewer."""

