import re
from sqlmodel import Session, select, col
from app.models import Exercise, Food, FoodNutrition, FoodServing, FoodAlias, Equipment, GoalOption, PaceOption
from app.enums import FoodSource


def _normalize(name: str) -> str:
    """Lowercase, collapse whitespace, strip punctuation for dedup/search."""
    return re.sub(r"[^a-z0-9 ]", "", name.lower()).strip()

# ─── Exercise library seed data ───────────────────────────────────────────────
# Format: (name, primary_muscle, secondary_muscles, equipment, is_compound, description)
#
# equipment values must match EquipmentType enum:
#   "gym"        – barbell, cable, or machine exercises requiring a full gym
#   "dumbbells"  – dumbbell-based (home or gym)
#   "bodyweight" – no equipment required
#   "home"       – pull-up bar, resistance bands, or other home-gym gear
#   "cardio"     – treadmill, stationary bike, elliptical, etc.
#   "other"      – kettlebell, sled, medicine ball, landmine, etc.
#
# primary_muscle must match MuscleGroup enum:
#   chest | back | shoulders | biceps | triceps | quads | hamstrings
#   glutes | calves | core | full_body | cardio

EXERCISES = [
    # ── Chest ────────────────────────────────────────────────────────────────
    ("Barbell Bench Press",       "chest",      ["triceps", "shoulders"],        "gym",        True,  "Classic horizontal press — primary chest builder"),
    ("Incline Barbell Press",     "chest",      ["triceps", "shoulders"],        "gym",        True,  "Upper chest focus with inclined barbell press"),
    ("Decline Bench Press",       "chest",      ["triceps", "shoulders"],        "gym",        True,  "Lower chest press variation"),
    ("Dumbbell Bench Press",      "chest",      ["triceps", "shoulders"],        "dumbbells",  True,  "Greater range of motion than barbell"),
    ("Incline Dumbbell Press",    "chest",      ["triceps", "shoulders"],        "dumbbells",  True,  "Upper chest dumbbell pressing"),
    ("Decline Push-ups",          "chest",      ["triceps", "shoulders"],        "bodyweight", True,  "Harder push-up variation emphasizing upper chest"),
    ("Push-ups",                  "chest",      ["triceps", "shoulders"],        "bodyweight", True,  "Foundational bodyweight chest exercise"),
    ("Wide Push-ups",             "chest",      ["shoulders"],                   "bodyweight", True,  "Wider hand placement for extra chest emphasis"),
    ("Diamond Push-ups",          "triceps",    ["chest", "shoulders"],          "bodyweight", True,  "Close-hand push-up emphasizing triceps"),
    ("Chest Dips",                "chest",      ["triceps"],                     "home",       True,  "Forward-lean dip for chest emphasis — needs dip bars"),
    ("Dumbbell Fly",              "chest",      [],                              "dumbbells",  False, "Isolation stretch for the chest"),
    ("Cable Fly",                 "chest",      [],                              "gym",        False, "Constant tension chest isolation on cable"),
    ("Machine Chest Press",       "chest",      ["triceps", "shoulders"],        "gym",        True,  "Stable machine-based chest press"),
    ("Pec Deck",                  "chest",      [],                              "gym",        False, "Machine chest fly isolation"),
    ("Scap Push-up",              "back",       ["shoulders"],                   "bodyweight", False, "Protract and retract the scapula at the bottom of a push-up position — improves shoulder health"),

    # ── Back ─────────────────────────────────────────────────────────────────
    ("Deadlift",                  "back",       ["hamstrings", "glutes", "core"], "gym",       True,  "King of compound lifts — full posterior chain"),
    ("Romanian Deadlift",         "hamstrings", ["glutes", "back"],              "gym",        True,  "Hip-hinge pattern targeting hamstrings"),
    ("Rack Pull",                 "back",       ["glutes", "hamstrings"],        "gym",        True,  "Partial deadlift emphasizing upper posterior chain"),
    ("Barbell Row",               "back",       ["biceps"],                      "gym",        True,  "Horizontal pull — lat and mid-back thickness"),
    ("Pendlay Row",               "back",       ["biceps"],                      "gym",        True,  "Explosive strict row from the floor"),
    ("T-Bar Row",                 "back",       ["biceps"],                      "gym",        True,  "Heavy rowing variation for back thickness"),
    ("Dumbbell Row",              "back",       ["biceps"],                      "dumbbells",  True,  "Unilateral back builder with good stretch"),
    ("Chest Supported Row",       "back",       ["biceps"],                      "dumbbells",  True,  "Lower-back-friendly incline dumbbell row"),
    ("Pull-ups",                  "back",       ["biceps"],                      "home",       True,  "Best bodyweight back exercise — requires pull-up bar"),
    ("Chin-ups",                  "back",       ["biceps"],                      "home",       True,  "Supinated pull-up — more biceps involvement"),
    ("Assisted Pull-up",          "back",       ["biceps"],                      "gym",        True,  "Machine-assisted pull-up for beginners building lat strength"),
    ("Lat Pulldown",              "back",       ["biceps"],                      "gym",        True,  "Cable pull-down for lat width"),
    ("Seated Cable Row",          "back",       ["biceps"],                      "gym",        True,  "Horizontal cable pull for mid-back thickness"),
    ("Straight-arm Pulldown",     "back",       [],                              "gym",        False, "Lat isolation keeping arms straight on cable"),
    ("Face Pull",                 "shoulders",  ["back"],                        "gym",        False, "Rear delt and rotator cuff health with cable rope"),
    ("Inverted Row",              "back",       ["biceps"],                      "home",       True,  "Horizontal bodyweight pull from a low bar"),
    ("Superman Hold",             "back",       ["glutes"],                      "bodyweight", False, "Posterior chain and spinal erector isometric hold"),
    ("Thoracic Rotation",         "back",       ["core"],                        "bodyweight", False, "Controlled rotation drill for thoracic spine mobility"),
    ("Back Extension (Back Focused)",  "back",  ["glutes", "hamstrings"],        "gym",        False, "45° hyperextension bench — neutral spine targets spinal erectors"),
    ("Back Extension (Glute Focused)", "glutes", ["hamstrings", "back"],         "gym",        False, "45° hyperextension bench — posterior pelvic tilt maximises glute activation"),

    # ── Shoulders ─────────────────────────────────────────────────────────────
    ("Overhead Press",            "shoulders",  ["triceps"],                     "gym",        True,  "Standing or seated barbell shoulder press"),
    ("Push Press",                "shoulders",  ["triceps", "quads"],            "gym",        True,  "Explosive overhead press using leg drive"),
    ("Dumbbell Shoulder Press",   "shoulders",  ["triceps"],                     "dumbbells",  True,  "Seated or standing dumbbell press for shoulders"),
    ("Arnold Press",              "shoulders",  ["triceps"],                     "dumbbells",  True,  "Rotational press hitting all three delt heads"),
    ("Machine Shoulder Press",    "shoulders",  ["triceps"],                     "gym",        True,  "Stable overhead press on shoulder machine"),
    ("Lateral Raise",             "shoulders",  [],                              "dumbbells",  False, "Side delt isolation — shoulder width"),
    ("Front Raise",               "shoulders",  [],                              "dumbbells",  False, "Anterior delt isolation"),
    ("Rear Delt Fly",             "shoulders",  ["back"],                        "dumbbells",  False, "Rear shoulder isolation — posture and balance"),
    ("Cable Lateral Raise",       "shoulders",  [],                              "gym",        False, "Constant-tension side delt work on cable"),
    ("Upright Row",               "shoulders",  ["traps"],                       "gym",        True,  "Vertical pull for shoulders and upper traps"),
    ("Pike Push-ups",             "shoulders",  ["triceps"],                     "bodyweight", True,  "Bodyweight overhead press progression"),
    ("Landmine Press",            "shoulders",  ["chest", "triceps"],            "gym",        True,  "Angled press from landmine attachment — shoulder-friendly"),
    ("Band Pull-Apart",           "shoulders",  ["back"],                        "home",       False, "Resistance band pull for rear delts and scapular health"),
    ("Wall Slide",                "shoulders",  ["back"],                        "bodyweight", False, "Overhead wall slide drill for shoulder mobility and stability"),

    # ── Biceps ───────────────────────────────────────────────────────────────
    ("Barbell Curl",              "biceps",     [],                              "gym",        False, "Classic barbell bicep curl"),
    ("EZ Bar Curl",               "biceps",     [],                              "gym",        False, "More wrist-friendly curling variation"),
    ("Dumbbell Curl",             "biceps",     [],                              "dumbbells",  False, "Alternating or simultaneous dumbbell curl"),
    ("Hammer Curl",               "biceps",     ["forearms"],                    "dumbbells",  False, "Neutral grip curl for brachialis and forearm thickness"),
    ("Incline Dumbbell Curl",     "biceps",     [],                              "dumbbells",  False, "Long-head focused curl on incline bench"),
    ("Concentration Curl",        "biceps",     [],                              "dumbbells",  False, "Strict unilateral bicep isolation"),
    ("Preacher Curl",             "biceps",     [],                              "gym",        False, "Isolates biceps with preacher bench support"),
    ("Cable Curl",                "biceps",     [],                              "gym",        False, "Constant tension curl on cable machine"),

    # ── Triceps ──────────────────────────────────────────────────────────────
    ("Skull Crusher",             "triceps",    [],                              "gym",        False, "Lying tricep extension with barbell or EZ bar"),
    ("Tricep Pushdown",           "triceps",    [],                              "gym",        False, "Cable pushdown for tricep isolation"),
    ("Rope Pushdown",             "triceps",    [],                              "gym",        False, "Cable rope pushdown for full lockout and flare"),
    ("Close-grip Bench Press",    "triceps",    ["chest"],                       "gym",        True,  "Bench press variation with close grip for triceps"),
    ("Overhead Tricep Extension", "triceps",    [],                              "dumbbells",  False, "Long head stretch with overhead dumbbell position"),
    ("Bench Dips",                "triceps",    ["chest"],                       "bodyweight", True,  "Bodyweight tricep dip using a bench or chair"),
    ("Kickbacks",                 "triceps",    [],                              "dumbbells",  False, "Strict tricep lockout with dumbbell"),

    # ── Quads ────────────────────────────────────────────────────────────────
    ("Barbell Squat",             "quads",      ["glutes", "hamstrings"],        "gym",        True,  "Foundational lower body compound movement"),
    ("Front Squat",               "quads",      ["core", "glutes"],              "gym",        True,  "Quad-dominant squat with very upright torso"),
    ("Leg Press",                 "quads",      ["glutes", "hamstrings"],        "gym",        True,  "Machine squat variation — high volume friendly"),
    ("Leg Extension",             "quads",      [],                              "gym",        False, "Quad isolation on leg extension machine"),
    ("Hack Squat",                "quads",      ["glutes"],                      "gym",        True,  "Machine squat with upright torso and loaded back pad"),
    ("Smith Machine Squat",       "quads",      ["glutes", "hamstrings"],        "gym",        True,  "Guided barbell squat for beginners or heavy volume"),
    ("Bulgarian Split Squat",     "quads",      ["glutes", "hamstrings"],        "dumbbells",  True,  "Unilateral leg exercise with rear foot elevated"),
    ("Walking Lunges",            "quads",      ["glutes", "hamstrings"],        "bodyweight", True,  "Dynamic forward lunge for strength and coordination"),
    ("Reverse Lunges",            "quads",      ["glutes", "hamstrings"],        "bodyweight", True,  "Knee-friendly lunge variation stepping backward"),
    ("Goblet Squat",              "quads",      ["glutes", "core"],              "dumbbells",  True,  "Beginner-friendly squat holding a dumbbell at chest"),
    ("Step-ups",                  "quads",      ["glutes", "hamstrings"],        "dumbbells",  True,  "Single-leg step-up with dumbbells for strength"),
    ("Bodyweight Squat",          "quads",      ["glutes"],                      "bodyweight", True,  "Air squat with no added weight"),
    ("Wall Sit",                  "quads",      [],                              "bodyweight", False, "Isometric quad endurance hold against a wall"),
    ("Landmine Squat",            "quads",      ["glutes", "core"],              "gym",        True,  "Goblet-style squat holding a landmine — very beginner-friendly"),
    ("Couch Stretch",             "quads",      ["hip_flexors"],                 "bodyweight", False, "Deep hip flexor and quad stretch with rear foot elevated"),

    # ── Hamstrings ───────────────────────────────────────────────────────────
    ("Leg Curl",                  "hamstrings", [],                              "gym",        False, "Lying hamstring curl on machine"),
    ("Seated Hamstring Curl",     "hamstrings", [],                              "gym",        False, "Seated leg curl machine — constant tension at peak contraction"),
    ("Good Morning",              "hamstrings", ["back", "glutes"],              "gym",        True,  "Hip hinge with barbell on upper back — posterior chain"),
    ("Nordic Curl",               "hamstrings", [],                              "bodyweight", True,  "Advanced eccentric hamstring curl — injury prevention staple"),
    ("Single-leg Romanian Deadlift", "hamstrings", ["glutes", "core"],          "dumbbells",  True,  "Balance-demanding unilateral hinge for hamstrings"),
    ("Smith Machine Romanian Deadlift", "hamstrings", ["glutes", "back"],       "gym",        True,  "Guided RDL for beginners or heavy loading without balance demand"),

    # ── Glutes ───────────────────────────────────────────────────────────────
    ("Hip Thrust",                "glutes",     ["hamstrings"],                  "gym",        True,  "Barbell hip thrust — most effective glute builder"),
    ("Glute Bridge",              "glutes",     ["hamstrings"],                  "bodyweight", True,  "Bodyweight hip extension on the floor"),
    ("Single-leg Glute Bridge",   "glutes",     ["hamstrings"],                  "bodyweight", True,  "Unilateral glute bridge progression"),
    ("Cable Glute Kickback",      "glutes",     [],                              "gym",        False, "Cable kickback for isolated glute contraction"),
    ("Donkey Kicks",              "glutes",     [],                              "bodyweight", False, "Quadruped bodyweight glute isolation"),
    ("Fire Hydrants",             "glutes",     [],                              "bodyweight", False, "Quadruped glute medius and external rotation work"),
    ("Hip Abduction Machine",     "glutes",     [],                              "gym",        False, "Seated machine for glute medius and abductor isolation"),

    # ── Adductors ────────────────────────────────────────────────────────────
    ("Hip Adduction Machine",     "quads",      ["adductors"],                   "gym",        False, "Seated machine for inner thigh and adductor isolation"),
    ("Copenhagen Plank",          "core",       ["adductors"],                   "bodyweight", False, "Side plank with top leg elevated — heavy adductor and core load"),
    ("Sumo Squat",                "quads",      ["glutes", "adductors"],         "dumbbells",  True,  "Wide-stance squat with toes flared — inner thigh and glutes"),

    # ── Calves ───────────────────────────────────────────────────────────────
    ("Standing Calf Raise",       "calves",     [],                              "gym",        False, "Bilateral calf raise on machine or loaded step"),
    ("Seated Calf Raise",         "calves",     [],                              "gym",        False, "Soleus focus with knee bent on seated calf machine"),
    ("Single-leg Calf Raise",     "calves",     [],                              "bodyweight", False, "Bodyweight single-leg calf raise on a step"),
    ("Jump Rope (Calf Focus)",    "calves",     ["cardio"],                      "home",       False, "Jump rope with emphasis on plantar flexion at bottom"),

    # ── Tibialis / Shin ──────────────────────────────────────────────────────
    ("Tibialis Raise",            "calves",     [],                              "bodyweight", False, "Stand against a wall and raise toes — strengthens tibialis anterior and shin"),
    ("Ankle Mobility Drill",      "calves",     [],                              "bodyweight", False, "Controlled ankle circles and wall ankle flexion for joint health"),

    # ── Core ─────────────────────────────────────────────────────────────────
    ("Plank",                     "core",       [],                              "bodyweight", False, "Isometric core stabilisation hold"),
    ("Side Plank",                "core",       [],                              "bodyweight", False, "Oblique and anti-lateral flexion isometric work"),
    ("Dead Bug",                  "core",       [],                              "bodyweight", False, "Beginner-friendly anti-extension core coordination move"),
    ("Bird Dog",                  "core",       ["back"],                        "bodyweight", False, "Core stability and contralateral coordination drill"),
    ("Cable Crunch",              "core",       [],                              "gym",        False, "Weighted kneeling crunch using cable machine"),
    ("Hanging Leg Raise",         "core",       [],                              "home",       False, "Lower ab focus hanging from pull-up bar"),
    ("Russian Twist",             "core",       [],                              "bodyweight", False, "Rotational core exercise with or without weight"),
    ("Ab Wheel Rollout",          "core",       ["shoulders"],                   "home",       False, "Challenging anti-extension core exercise with ab wheel"),
    ("Mountain Climbers",         "core",       ["cardio"],                      "bodyweight", True,  "Dynamic core and cardiovascular conditioning drill"),
    ("Cable Woodchop",            "core",       ["shoulders"],                   "gym",        True,  "Rotational cable pull for anti-rotation and oblique strength"),
    ("Pallof Press",              "core",       [],                              "gym",        False, "Anti-rotation cable press — builds lateral core stability"),

    # ── Rotator Cuff / Shoulder Health ───────────────────────────────────────
    ("External Rotation (Band)",  "shoulders",  [],                              "home",       False, "Band external rotation for rotator cuff health"),
    ("Internal Rotation (Band)",  "shoulders",  [],                              "home",       False, "Band internal rotation drill for shoulder balance"),
    ("Prone Y-T-W",               "back",       ["shoulders"],                   "bodyweight", False, "Prone scapular control drill — Y, T, and W positions"),
    ("Cuban Press",               "shoulders",  [],                              "dumbbells",  False, "External rotation to overhead press combo for shoulder prehab"),

    # ── Mobility / Warmup ────────────────────────────────────────────────────
    ("World's Greatest Stretch",  "full_body",  [],                              "bodyweight", False, "Lunge to thoracic rotation — total mobility warmup"),
    ("Hip 90-90 Stretch",         "glutes",     ["hamstrings"],                  "bodyweight", False, "Hip internal and external rotation mobility drill"),
    ("Leg Swings",                "hamstrings", ["glutes"],                      "bodyweight", False, "Dynamic hip flexor and hamstring warmup swing"),
    ("Arm Circles",               "shoulders",  [],                              "bodyweight", False, "Dynamic shoulder warmup and mobility drill"),
    ("Cat-Cow",                   "back",       ["core"],                        "bodyweight", False, "Spinal flexion and extension mobility flow"),
    ("Inchworm",                  "full_body",  ["core", "shoulders"],           "bodyweight", True,  "Walk-out warmup targeting hamstrings, core, and shoulders"),

    # ── Cardio — machine ─────────────────────────────────────────────────────
    ("Treadmill Run",             "cardio",     [],                              "cardio",     False, "Steady-state or interval treadmill run"),
    ("Treadmill Intervals",       "cardio",     [],                              "cardio",     True,  "Alternating sprint and recovery on treadmill"),
    ("Incline Walk",              "cardio",     ["glutes", "calves"],            "cardio",     False, "Low-impact incline treadmill walk for conditioning"),
    ("Stationary Bike",           "cardio",     ["quads", "calves"],             "cardio",     False, "Low-impact cycling cardio on stationary bike"),
    ("Stationary Bike Intervals", "cardio",     ["quads"],                       "cardio",     True,  "High-intensity cycling sprints on stationary bike"),
    ("Assault Bike",              "cardio",     ["full_body"],                   "cardio",     True,  "Fan bike — brutal full-body cardiovascular effort"),
    ("Elliptical",                "cardio",     [],                              "cardio",     False, "Joint-friendly low-impact cardio"),
    ("Stair Climber",             "cardio",     ["glutes", "quads"],             "cardio",     False, "Lower-body-focused cardio stair climbing machine"),
    ("Rowing Machine",            "full_body",  ["back", "legs"],                "cardio",     True,  "Full-body cardio with strong back and leg activation"),
    ("Rowing Machine Intervals",  "full_body",  ["back", "legs"],                "cardio",     True,  "High-intensity rowing sprints with recovery periods"),

    # ── Cardio — outdoor / bodyweight ────────────────────────────────────────
    ("Running (Outdoor)",         "cardio",     [],                              "bodyweight", False, "Steady-state outdoor run"),
    ("Jogging",                   "cardio",     [],                              "bodyweight", False, "Easy-pace endurance jogging outdoors"),
    ("Sprint Intervals",          "cardio",     ["quads", "glutes"],             "bodyweight", True,  "All-out sprints with walking recovery"),
    ("Hill Sprints",              "cardio",     ["glutes", "calves"],            "bodyweight", True,  "Uphill sprint repeats for power and conditioning"),
    ("Swimming Laps",             "cardio",     ["back", "shoulders"],           "bodyweight", True,  "Full-body low-impact cardio in pool"),
    ("Cycling (Outdoor)",         "cardio",     ["quads", "calves"],             "bodyweight", False, "Steady outdoor bike ride"),
    ("Jump Rope",                 "cardio",     ["calves"],                      "home",       False, "Jump rope cardiovascular conditioning"),
    ("Jump Rope HIIT",            "cardio",     ["calves", "shoulders"],         "home",       True,  "High-intensity jump rope intervals"),
    ("HIIT Circuit",              "full_body",  [],                              "bodyweight", True,  "High-intensity interval circuit — no equipment needed"),
    ("Battle Ropes",              "full_body",  ["shoulders", "core"],           "gym",        True,  "Wave and slam conditioning with battle ropes"),

    # ── Full body / power ─────────────────────────────────────────────────────
    ("Kettlebell Swing",          "full_body",  ["glutes", "hamstrings"],        "other",      True,  "Hip-hinge power movement with kettlebell"),
    ("Burpees",                   "full_body",  [],                              "bodyweight", True,  "High-intensity full body conditioning movement"),
    ("Box Jump",                  "quads",      ["glutes"],                      "gym",        True,  "Plyometric lower body power onto a plyo box"),
    ("Broad Jump",                "quads",      ["glutes"],                      "bodyweight", True,  "Horizontal plyometric power jump"),
    ("Jump Squats",               "quads",      ["glutes"],                      "bodyweight", True,  "Explosive squat with a jump at the top"),
    ("Thrusters",                 "full_body",  ["shoulders", "quads"],          "dumbbells",  True,  "Squat-to-press full body exercise with dumbbells"),
    ("Farmer Carry",              "full_body",  ["core", "grip"],                "dumbbells",  True,  "Heavy loaded carry for full-body stability and grip"),
    ("Sled Push",                 "full_body",  ["quads", "glutes"],             "other",      True,  "Sled drive for power, conditioning, and leg strength"),
    ("Med Ball Slam",             "full_body",  ["core", "shoulders"],           "other",      True,  "Explosive overhead slam with a medicine ball"),

    # ── Loaded carries / athletic movements ──────────────────────────────────
    ("Suitcase Carry",            "core",       ["glutes", "traps"],             "dumbbells",  True,  "Unilateral loaded carry for anti-lateral flexion core strength"),
    ("Sled Drag",                 "full_body",  ["hamstrings", "glutes"],        "other",      True,  "Backward sled drag for posterior chain conditioning"),
    ("Trap Bar Deadlift",         "full_body",  ["quads", "glutes", "back"],     "gym",        True,  "Deadlift with trap bar — more upright torso, beginner-friendly"),
]


def seed_exercises(session: Session) -> None:
    """Insert new exercises by name — skips any that already exist."""
    existing_names = set(r.name for r in session.exec(select(Exercise)).all())
    seen_in_batch: set[str] = set()
    added = 0
    for name, primary, secondary, equipment, compound, desc in EXERCISES:
        if name in existing_names or name in seen_in_batch:
            continue
        seen_in_batch.add(name)
        session.add(Exercise(
            name=name,
            primary_muscle=primary,
            secondary_muscles=secondary,
            equipment=equipment,
            is_compound=compound,
            description=desc,
            is_custom=False,
        ))
        added += 1
    session.commit()
    if added:
        print(f"[seed] inserted {added} new exercises")


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
    """
    from app.seed_foods_data import SEED_FOODS

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

            # Upsert FoodNutrition
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
                fn.fiber = n.get("fiber")
                fn.sugar = n.get("sugar")
                fn.sodium_mg = n.get("sodium_mg")
                session.add(fn)
            else:
                session.add(FoodNutrition(
                    food_id=food.id,
                    reference_unit="100g",
                    reference_grams=ref_grams,
                    calories=n["calories"], protein=n["protein"],
                    carbs=n["carbs"], fat=n["fat"],
                    fiber=n.get("fiber"), sugar=n.get("sugar"),
                    sodium_mg=n.get("sodium_mg"),
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

        # FoodNutrition (per 100g)
        session.add(FoodNutrition(
            food_id=food.id,
            reference_unit="100g",
            reference_grams=ref_grams,
            calories=n["calories"], protein=n["protein"],
            carbs=n["carbs"], fat=n["fat"],
            fiber=n.get("fiber"), sugar=n.get("sugar"),
            sodium_mg=n.get("sodium_mg"),
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


# ─── Equipment library seed data ──────────────────────────────────────────────
# Format: (name, category, icon)

EQUIPMENT_DATA = [
    # Bodyweight & Home
    ("Pull-up bar",              "Bodyweight & Home", "🔩"),
    ("Resistance bands",         "Bodyweight & Home", "🔗"),
    ("Yoga mat",                 "Bodyweight & Home", "🧘"),
    ("Jump rope",                "Bodyweight & Home", "⚡"),
    ("Foam roller",              "Bodyweight & Home", "🛢️"),
    ("Ab wheel",                 "Bodyweight & Home", "⭕"),
    ("Dip bars",                 "Bodyweight & Home", "🤸"),
    ("Suspension trainer",       "Bodyweight & Home", "🪢"),

    # Free Weights
    ("Dumbbells",                "Free Weights", "🏋️"),
    ("Barbell",                  "Free Weights", "🏋️"),
    ("Kettlebell",               "Free Weights", "🔔"),
    ("EZ curl bar",              "Free Weights", "〰️"),
    ("Weight plates",            "Free Weights", "⭕"),
    ("Trap bar",                 "Free Weights", "⬡"),
    ("Medicine ball",            "Free Weights", "⚽"),

    # Benches & Racks
    ("Flat bench",               "Benches & Racks", "🪑"),
    ("Adjustable bench",         "Benches & Racks", "📐"),
    ("Incline bench",            "Benches & Racks", "📐"),
    ("Squat rack",               "Benches & Racks", "🏗️"),
    ("Power rack",               "Benches & Racks", "🏗️"),
    ("Landmine attachment",      "Benches & Racks", "🔧"),

    # Gym Machines
    ("Cable machine",            "Gym Machines", "🔗"),
    ("Leg press",                "Gym Machines", "🦵"),
    ("Lat pulldown",             "Gym Machines", "⬇️"),
    ("Chest press machine",      "Gym Machines", "💪"),
    ("Seated row machine",       "Gym Machines", "🔙"),
    ("Leg extension",            "Gym Machines", "🦵"),
    ("Leg curl machine",         "Gym Machines", "🦵"),
    ("Shoulder press machine",   "Gym Machines", "⬆️"),
    ("Hip abduction machine",    "Gym Machines", "🦵"),
    ("Hip adduction machine",    "Gym Machines", "🦵"),
    ("Smith machine",            "Gym Machines", "📍"),
    ("Hack squat machine",       "Gym Machines", "🦵"),
    ("Assisted pull-up machine", "Gym Machines", "🤝"),
    ("Leverage machines",        "Gym Machines", "⚙️"),

    # Cardio
    ("Treadmill",                "Cardio", "🏃"),
    ("Stationary bike",          "Cardio", "🚴"),
    ("Elliptical",               "Cardio", "🔄"),
    ("Rowing machine",           "Cardio", "🚣"),
    ("Stair climber",            "Cardio", "🪜"),
    ("Assault bike",             "Cardio", "💨"),
    ("Swimming pool",            "Cardio", "🏊"),
    ("Battle ropes",             "Cardio", "🪢"),

    # Athletic / Functional
    ("Plyo box",                 "Athletic / Functional", "📦"),
    ("Sled",                     "Athletic / Functional", "🛷"),
]


def seed_equipment(session: Session) -> None:
    """Insert new equipment by name — skips any that already exist."""
    existing_names = set(r.name for r in session.exec(select(Equipment)).all())
    added = 0
    for name, category, icon in EQUIPMENT_DATA:
        if name not in existing_names:
            session.add(Equipment(
                name=name,
                category=category,
                icon=icon,
                is_custom=False,
            ))
            added += 1
    session.commit()
    if added:
        print(f"[seed] inserted {added} new equipment items")


# ─── Goal & Pace seed data ────────────────────────────────────────────────────

GOAL_OPTIONS_DATA = [
    ("fat_loss",             "Lose Weight",            "🔥", "Burn fat through a sustainable calorie deficit"),
    ("muscle_gain",          "Build Muscle",            "💪", "Gain size and strength with a calorie surplus"),
    ("body_recomp",          "Body Recomposition",      "⚖️", "Lose fat and build muscle at the same time"),
    ("strength",             "Build Strength",          "🏋️", "Increase your 1-rep maxes and raw power output"),
    ("toning",               "Tone & Define",           "✨", "Lean out and sculpt visible muscle definition"),
    ("endurance",            "Improve Endurance",       "🏃", "Run longer, recover faster, and build stamina"),
    ("athletic_performance", "Athletic Performance",    "⚡", "Speed, power, agility, and sport-specific fitness"),
    ("maintain",             "Maintain & Stay Active",  "🎯", "Keep your current fitness level and stay healthy"),
    ("flexibility",          "Flexibility & Mobility",  "🧘", "Improve range of motion and reduce injury risk"),
    ("stress_relief",        "Mental Wellness",         "🌿", "Use movement to manage stress and improve mood"),
]

PACE_OPTIONS_DATA = [
    # Fat loss
    ("fat_loss", "conservative", "Slow & Steady",   "🐢", "~0.5 lbs/week",  "Sustainable pace — preserves muscle, easiest to stick to"),
    ("fat_loss", "moderate",     "Balanced",         "🚶", "~1 lb/week",     "Recommended for most — good results without feeling deprived"),
    ("fat_loss", "aggressive",   "Aggressive",       "🚀", "~1.5 lbs/week",  "Fastest fat loss — requires high adherence and discipline"),

    # Muscle gain
    ("muscle_gain", "conservative", "Lean Bulk",       "🌱", "~0.25 lbs/week", "Minimal fat gain — slow, clean muscle accumulation"),
    ("muscle_gain", "moderate",     "Standard Bulk",   "💪", "~0.5 lbs/week",  "Best balance of muscle gain vs fat — most popular approach"),
    ("muscle_gain", "aggressive",   "Aggressive Bulk", "🦣", "~1 lb/week",     "Maximum muscle gain — expect some added body fat"),

    # Body recomposition
    ("body_recomp", "conservative", "Gradual Recomp",   "🐢", "Slow shift",    "High protein + slight deficit — very sustainable, slower visual change"),
    ("body_recomp", "moderate",     "Steady Recomp",    "⚖️", "Steady effort", "Balanced nutrition and consistent training for noticeable changes over months"),
    ("body_recomp", "aggressive",   "Intensive Recomp", "🔥", "High effort",   "Strict calorie cycling and high training volume — best results fastest"),

    # Toning
    ("toning", "conservative", "Gentle Tone",   "🐢", "~0.5 lbs/week",  "Slow lean-out — very sustainable, no crash dieting"),
    ("toning", "moderate",     "Steady Tone",   "🚶", "~0.75 lbs/week", "Good balance of speed and comfort for visible definition"),
    ("toning", "aggressive",   "Fast Tone",     "🚀", "~1 lb/week",     "Quicker definition — stricter diet and more training required"),

    # Strength
    ("strength", "conservative", "Skill Focus",        "📚", "Technique first",   "Master movement patterns, light and gradual load increases"),
    ("strength", "moderate",     "Progressive Overload","💪", "Weekly PR gains",   "Steady linear or wave-load progression — most reliable approach"),
    ("strength", "aggressive",   "Peaking",            "🏋️", "Max effort blocks",  "High-intensity training cycles, frequent heavy days, competition prep"),

    # Endurance
    ("endurance", "conservative", "Easy Base",    "🐢", "+10% vol/week",  "Build your aerobic base at easy, conversational pace"),
    ("endurance", "moderate",     "Steady Build", "🚶", "+15% vol/week",  "Mix of easy, tempo, and moderate sessions for well-rounded fitness"),
    ("endurance", "aggressive",   "Race Prep",    "🏃", "+20% vol/week",  "High weekly volume with quality speed work — training for events"),

    # Athletic performance
    ("athletic_performance", "conservative", "Foundation",       "🌱", "Base building",    "Develop strength, movement quality, and aerobic base"),
    ("athletic_performance", "moderate",     "Sport-Ready",      "⚡", "Balanced output",  "Well-rounded mix of strength, speed, power, and conditioning"),
    ("athletic_performance", "aggressive",   "Peak Performance", "🏆", "Competition prep", "Maximum effort across all physical attributes — for serious athletes"),

    # Maintain
    ("maintain", "conservative", "Light Active",   "🌿", "2–3x/week", "Casual, low-effort sessions to stay mobile and healthy"),
    ("maintain", "moderate",     "Steady Active",  "🎯", "3–4x/week", "Consistent training to hold your current fitness and physique"),
    ("maintain", "aggressive",   "Active Lifestyle","🔥", "5x/week",   "Stay highly active, keep challenging yourself without major goals"),

    # Flexibility
    ("flexibility", "conservative", "Gentle Flow",      "🧘", "10–15 min/day", "Basic stretching and static mobility — easy to start"),
    ("flexibility", "moderate",     "Active Flexibility","🌀", "20–30 min/day", "Daily stretching, yoga flows, and targeted mobility drills"),
    ("flexibility", "aggressive",   "Deep Mobility",    "🤸", "45–60 min/day", "Long holds, loaded stretching, and progressive mobility training"),

    # Stress relief
    ("stress_relief", "conservative", "Light Movement",  "🌿", "2–3x/week", "Short, low-intensity sessions focused on feeling good"),
    ("stress_relief", "moderate",     "Regular Relief",  "😌", "3–4x/week", "Consistent routine combining movement and mindfulness"),
    ("stress_relief", "aggressive",   "Daily Active",    "💪", "Daily",     "Daily exercise as your primary stress management and mood tool"),
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
