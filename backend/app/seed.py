from sqlmodel import Session, select
from app.models import Exercise, Food, Equipment, GoalOption, PaceOption
from app.enums import FoodCategory

# ─── Exercise library seed data ───────────────────────────────────────────────
# Format: (name, primary_muscle, secondary_muscles, equipment, is_compound, description)

EXERCISES = [
    # Chest
    ("Barbell Bench Press",      "chest",      ["triceps", "shoulders"], "gym",        True,  "Classic horizontal press — primary chest builder"),
    ("Incline Barbell Press",    "chest",      ["triceps", "shoulders"], "gym",        True,  "Upper chest focus with inclined bench"),
    ("Decline Bench Press",      "chest",      ["triceps", "shoulders"], "gym",        True,  "Lower chest press variation"),
    ("Dumbbell Bench Press",     "chest",      ["triceps", "shoulders"], "dumbbells",  True,  "Greater range of motion than barbell"),
    ("Incline Dumbbell Press",   "chest",      ["triceps", "shoulders"], "dumbbells",  True,  "Upper chest dumbbell pressing"),
    ("Decline Push-ups",         "chest",      ["triceps", "shoulders"], "bodyweight", True,  "Harder push-up variation emphasizing upper chest"),
    ("Push-ups",                 "chest",      ["triceps", "shoulders"], "bodyweight", True,  "Foundational bodyweight chest exercise"),
    ("Wide Push-ups",            "chest",      ["shoulders"],            "bodyweight", True,  "Push-up variation with extra chest emphasis"),
    ("Diamond Push-ups",         "triceps",    ["chest", "shoulders"],   "bodyweight", True,  "Close-hand push-up emphasizing triceps"),
    ("Chest Dips",               "chest",      ["triceps"],              "gym",        True,  "Lean-forward dip for chest emphasis"),
    ("Dumbbell Fly",             "chest",      [],                       "dumbbells",  False, "Isolation stretch for the chest"),
    ("Cable Fly",                "chest",      [],                       "gym",        False, "Constant tension chest isolation"),
    ("Machine Chest Press",      "chest",      ["triceps", "shoulders"], "gym",        True,  "Stable machine-based chest press"),
    ("Pec Deck",                 "chest",      [],                       "gym",        False, "Machine chest fly isolation"),

    # Back
    ("Deadlift",                 "back",       ["hamstrings", "glutes", "core"], "gym",        True,  "King of compound lifts — full posterior chain"),
    ("Romanian Deadlift",        "hamstrings", ["glutes", "back"],               "gym",        True,  "Hip-hinge pattern targeting hamstrings"),
    ("Rack Pull",                "back",       ["glutes", "hamstrings"],         "gym",        True,  "Partial deadlift emphasizing upper posterior chain"),
    ("Barbell Row",              "back",       ["biceps"],                        "gym",        True,  "Horizontal pull — lat and mid-back width"),
    ("Pendlay Row",              "back",       ["biceps"],                        "gym",        True,  "Explosive strict row from the floor"),
    ("T-Bar Row",                "back",       ["biceps"],                        "gym",        True,  "Heavy rowing variation for thickness"),
    ("Dumbbell Row",             "back",       ["biceps"],                        "dumbbells",  True,  "Unilateral back builder with good stretch"),
    ("Chest Supported Row",      "back",       ["biceps"],                        "dumbbells",  True,  "Lower-back-friendly row variation"),
    ("Pull-ups",                 "back",       ["biceps"],                        "bodyweight", True,  "Best bodyweight back exercise"),
    ("Chin-ups",                 "back",       ["biceps"],                        "bodyweight", True,  "Supinated pull-up variation with more biceps"),
    ("Lat Pulldown",             "back",       ["biceps"],                        "gym",        True,  "Cable pull-down for lat width"),
    ("Seated Cable Row",         "back",       ["biceps"],                        "gym",        True,  "Horizontal cable pull for mid-back thickness"),
    ("Straight-arm Pulldown",    "back",       [],                                "gym",        False, "Lat isolation using cable"),
    ("Face Pull",                "shoulders",  ["back"],                          "gym",        False, "Rear delt and rotator cuff health"),
    ("Inverted Row",             "back",       ["biceps"],                        "bodyweight", True,  "Bodyweight horizontal pull"),
    ("Superman Hold",            "back",       ["glutes"],                        "bodyweight", False, "Bodyweight posterior chain and spinal erector hold"),

    # Shoulders
    ("Overhead Press",           "shoulders",  ["triceps"],              "gym",        True,  "Standing or seated barbell shoulder press"),
    ("Push Press",               "shoulders",  ["triceps", "quads"],     "gym",        True,  "Explosive overhead press using leg drive"),
    ("Dumbbell Shoulder Press",  "shoulders",  ["triceps"],              "dumbbells",  True,  "Seated dumbbell press for shoulders"),
    ("Arnold Press",             "shoulders",  ["triceps"],              "dumbbells",  True,  "Rotational press hitting all three delt heads"),
    ("Lateral Raise",            "shoulders",  [],                       "dumbbells",  False, "Side delt isolation — shoulder width"),
    ("Front Raise",              "shoulders",  [],                       "dumbbells",  False, "Anterior delt isolation"),
    ("Rear Delt Fly",            "shoulders",  ["back"],                 "dumbbells",  False, "Rear shoulder isolation"),
    ("Cable Lateral Raise",      "shoulders",  [],                       "gym",        False, "Constant-tension side delt work"),
    ("Upright Row",              "shoulders",  ["traps"],                "gym",        True,  "Vertical pull for shoulders and traps"),
    ("Pike Push-ups",            "shoulders",  ["triceps"],              "bodyweight", True,  "Bodyweight shoulder press progression"),

    # Biceps
    ("Barbell Curl",             "biceps",     [],                       "gym",        False, "Classic barbell bicep curl"),
    ("EZ Bar Curl",              "biceps",     [],                       "gym",        False, "More wrist-friendly curling variation"),
    ("Dumbbell Curl",            "biceps",     [],                       "dumbbells",  False, "Alternating or simultaneous dumbbell curl"),
    ("Hammer Curl",              "biceps",     ["forearms"],             "dumbbells",  False, "Neutral grip curl for brachialis"),
    ("Incline Dumbbell Curl",    "biceps",     [],                       "dumbbells",  False, "Long-head focused bicep curl"),
    ("Concentration Curl",       "biceps",     [],                       "dumbbells",  False, "Strict unilateral bicep isolation"),
    ("Preacher Curl",            "biceps",     [],                       "gym",        False, "Isolates biceps with preacher bench support"),
    ("Cable Curl",               "biceps",     [],                       "gym",        False, "Constant tension curl on cable machine"),

    # Triceps
    ("Skull Crusher",            "triceps",    [],                       "gym",        False, "Lying tricep extension with barbell or EZ bar"),
    ("Tricep Pushdown",          "triceps",    [],                       "gym",        False, "Cable pushdown for tricep isolation"),
    ("Rope Pushdown",            "triceps",    [],                       "gym",        False, "Cable rope pushdown for full lockout"),
    ("Close-grip Bench Press",   "triceps",    ["chest"],                "gym",        True,  "Bench press variation emphasizing triceps"),
    ("Overhead Tricep Extension","triceps",    [],                       "dumbbells",  False, "Long head stretch with overhead position"),
    ("Bench Dips",               "triceps",    ["chest"],                "bodyweight", True,  "Bodyweight triceps dip variation"),
    ("Kickbacks",                "triceps",    [],                       "dumbbells",  False, "Strict triceps lockout movement"),

    # Quads
    ("Barbell Squat",            "quads",      ["glutes", "hamstrings"], "gym",        True,  "Foundational lower body compound movement"),
    ("Front Squat",              "quads",      ["core", "glutes"],       "gym",        True,  "Quad-dominant squat with upright torso"),
    ("Leg Press",                "quads",      ["glutes", "hamstrings"], "gym",        True,  "Machine squat variation — high volume friendly"),
    ("Leg Extension",            "quads",      [],                       "gym",        False, "Quad isolation on machine"),
    ("Hack Squat",               "quads",      ["glutes"],               "gym",        True,  "Machine squat with upright torso"),
    ("Bulgarian Split Squat",    "quads",      ["glutes", "hamstrings"], "dumbbells",  True,  "Unilateral leg exercise with rear foot elevated"),
    ("Walking Lunges",           "quads",      ["glutes", "hamstrings"], "bodyweight", True,  "Dynamic lunge variation"),
    ("Reverse Lunges",           "quads",      ["glutes", "hamstrings"], "bodyweight", True,  "Knee-friendly lunge variation"),
    ("Goblet Squat",             "quads",      ["glutes", "core"],       "dumbbells",  True,  "Beginner-friendly squat with dumbbell"),
    ("Step-ups",                 "quads",      ["glutes", "hamstrings"], "dumbbells",  True,  "Single-leg lower body movement"),
    ("Bodyweight Squat",         "quads",      ["glutes"],               "bodyweight", True,  "Squat with no added weight"),
    ("Wall Sit",                 "quads",      [],                       "bodyweight", False, "Isometric quad endurance hold"),

    # Hamstrings
    ("Leg Curl",                 "hamstrings", [],                       "gym",        False, "Lying or seated hamstring curl on machine"),
    ("Good Morning",             "hamstrings", ["back", "glutes"],       "gym",        True,  "Hip hinge with barbell on upper back"),
    ("Nordic Curl",              "hamstrings", [],                       "bodyweight", True,  "Very advanced hamstring curl variation"),
    ("Single-leg Romanian Deadlift", "hamstrings", ["glutes", "core"],   "dumbbells",  True,  "Balance-demanding unilateral hinge"),

    # Glutes
    ("Hip Thrust",               "glutes",     ["hamstrings"],           "gym",        True,  "Barbell hip thrust — best glute builder"),
    ("Glute Bridge",             "glutes",     ["hamstrings"],           "bodyweight", True,  "Bodyweight hip extension on the floor"),
    ("Single-leg Glute Bridge",  "glutes",     ["hamstrings"],           "bodyweight", True,  "Unilateral glute bridge progression"),
    ("Cable Glute Kickback",     "glutes",     [],                       "gym",        False, "Cable isolation for glute contraction"),
    ("Donkey Kicks",             "glutes",     [],                       "bodyweight", False, "Bodyweight glute isolation"),
    ("Fire Hydrants",            "glutes",     [],                       "bodyweight", False, "Bodyweight glute medius work"),

    # Calves
    ("Standing Calf Raise",      "calves",     [],                       "gym",        False, "Bilateral calf raise on machine or step"),
    ("Seated Calf Raise",        "calves",     [],                       "gym",        False, "Soleus focus with bent knee position"),
    ("Single-leg Calf Raise",    "calves",     [],                       "bodyweight", False, "Bodyweight calf raise variation"),
    ("Jump Rope",                "calves",     ["cardio"],               "home",       True,  "Simple conditioning with calf demand"),

    # Core
    ("Plank",                    "core",       [],                       "bodyweight", False, "Isometric core stabilisation hold"),
    ("Side Plank",               "core",       [],                       "bodyweight", False, "Oblique and anti-lateral flexion work"),
    ("Dead Bug",                 "core",       [],                       "bodyweight", False, "Beginner-friendly anti-extension core move"),
    ("Bird Dog",                 "core",       ["back"],                 "bodyweight", False, "Core stability and coordination drill"),
    ("Cable Crunch",             "core",       [],                       "gym",        False, "Weighted crunch using cable machine"),
    ("Hanging Leg Raise",        "core",       [],                       "gym",        False, "Lower ab focus hanging from pull-up bar"),
    ("Russian Twist",            "core",       [],                       "bodyweight", False, "Rotational core exercise"),
    ("Ab Wheel Rollout",         "core",       ["shoulders"],            "gym",        False, "Challenging anti-extension core exercise"),
    ("Mountain Climbers",        "core",       ["cardio"],               "bodyweight", True,  "Dynamic core and conditioning drill"),

    # Cardio / full body
    ("Treadmill Run",            "cardio",     [],                       "gym",        False, "Steady state or interval treadmill cardio"),
    ("Incline Walk",             "cardio",     [],                       "gym",        False, "Low-impact treadmill conditioning"),
    ("Stationary Bike",          "cardio",     [],                       "gym",        False, "Low-impact cardio option"),
    ("Elliptical",               "cardio",     [],                       "gym",        False, "Joint-friendly cardio machine"),
    ("Stair Climber",            "cardio",     ["glutes", "quads"],      "gym",        False, "Lower-body-focused cardio"),
    ("Rowing Machine",           "full_body",  ["back", "legs"],         "gym",        True,  "Full body cardio with strong back activation"),
    ("Kettlebell Swing",         "full_body",  ["glutes", "hamstrings"], "gym",        True,  "Hip-hinge power movement with kettlebell"),
    ("Burpees",                  "full_body",  [],                       "bodyweight", True,  "High intensity full body conditioning"),
    ("Box Jump",                 "quads",      ["glutes"],               "gym",        True,  "Plyometric lower body power exercise"),
    ("Jump Squats",              "quads",      ["glutes"],               "bodyweight", True,  "Explosive squat variation"),
    ("Thrusters",                "full_body",  ["shoulders", "quads"],   "dumbbells",  True,  "Squat-to-press full body exercise"),
    ("Farmer Carry",             "full_body",  ["core", "grip"],         "dumbbells",  True,  "Loaded carry for full-body stability"),
]


def seed_exercises(session: Session) -> None:
    """Insert exercise library if the table is empty."""
    existing = session.exec(select(Exercise)).first()
    if existing:
        return  # already seeded

    for name, primary, secondary, equipment, compound, desc in EXERCISES:
        session.add(Exercise(
            name=name,
            primary_muscle=primary,
            secondary_muscles=secondary,
            equipment=equipment,
            is_compound=compound,
            description=desc,
            is_custom=False,
        ))
    session.commit()
    print(f"[seed] inserted {len(EXERCISES)} exercises")


# ─── Food library seed data ───────────────────────────────────────────────────
# Format: (name, category, unit, calories, protein, carbs, fat)

FOODS = [
    # Proteins
    ("Chicken breast",       "proteins",       "100g",      165, 31, 0,   3.6),
    ("Chicken thighs",       "proteins",       "100g",      209, 26, 0,   11),
    ("Ground beef",          "proteins",       "100g",      215, 26, 0,   13),
    ("Lean ground beef",     "proteins",       "100g",      176, 26, 0,   10),
    ("Steak",                "proteins",       "100g",      242, 26, 0,   15),
    ("Turkey breast",        "proteins",       "100g",      135, 30, 0,   1),
    ("Pork loin",            "proteins",       "100g",      182, 26, 0,   8),
    ("Ham",                  "proteins",       "100g",      145, 21, 1.5, 5.5),
    ("Salmon",               "proteins",       "100g",      208, 20, 0,   13),
    ("Tuna",                 "proteins",       "100g",      116, 26, 0,   1),
    ("Shrimp",               "proteins",       "100g",      99,  24, 0,   0.3),
    ("Cod",                  "proteins",       "100g",      82,  18, 0,   0.7),
    ("Tilapia",              "proteins",       "100g",      96,  20, 0,   1.7),
    ("Sardines",             "proteins",       "100g",      208, 25, 0,   11),
    ("Egg whites",           "proteins",       "100g",      52,  11, 1,   0.2),

    # Dairy / protein-ish
    ("Eggs",                 "plant_proteins", "1 large",   72,  6,  0.4, 5),
    ("Greek yogurt",         "plant_proteins", "170g",      100, 17, 6,   0.7),
    ("Cottage cheese",       "plant_proteins", "100g",      98,  11, 3,   4.3),
    ("String cheese",        "dairy",          "1 stick",   80,  7,  1,   6),
    ("Protein powder",       "plant_proteins", "1 scoop",   120, 25, 3,   1.5),

    # Plant proteins
    ("Tofu",                 "plant_proteins", "100g",      76,  8,  2,   4.8),
    ("Tempeh",               "plant_proteins", "100g",      193, 19, 9,   11),
    ("Lentils",              "plant_proteins", "1 cup",     230, 18, 40,  0.8),
    ("Black beans",          "plant_proteins", "1 cup",     227, 15, 41,  0.9),
    ("Pinto beans",          "plant_proteins", "1 cup",     245, 15, 45,  1.1),
    ("Kidney beans",         "plant_proteins", "1 cup",     225, 15, 40,  0.9),
    ("Chickpeas",            "plant_proteins", "1 cup",     269, 15, 45,  4),
    ("Edamame",              "plant_proteins", "1 cup",     189, 17, 16,  8),

    # Grains & carbs
    ("White rice",           "grains_carbs",   "1 cup",     206, 4,  45,  0.4),
    ("Brown rice",           "grains_carbs",   "1 cup",     216, 5,  45,  1.8),
    ("Jasmine rice",         "grains_carbs",   "1 cup",     205, 4,  45,  0.4),
    ("Basmati rice",         "grains_carbs",   "1 cup",     190, 4,  39,  0.6),
    ("Oats",                 "grains_carbs",   "1/2 cup",   150, 5,  27,  3),
    ("Pasta",                "grains_carbs",   "1 cup",     220, 8,  43,  1.3),
    ("Whole wheat pasta",    "grains_carbs",   "1 cup",     174, 7.5,37,  0.8),
    ("Quinoa",               "grains_carbs",   "1 cup",     222, 8,  39,  4),
    ("Bread",                "grains_carbs",   "1 slice",   79,  3,  15,  1),
    ("Whole wheat bread",    "grains_carbs",   "1 slice",   81,  4,  14,  1.1),
    ("Bagel",                "grains_carbs",   "1 medium",  270, 11, 53,  1.5),
    ("English muffin",       "grains_carbs",   "1 muffin",  134, 5,  26,  1),
    ("Tortilla",             "grains_carbs",   "1 medium",  140, 4,  24,  3.5),
    ("Sweet potato",         "grains_carbs",   "1 medium",  103, 2,  24,  0.1),
    ("Potato",               "grains_carbs",   "1 medium",  161, 4,  37,  0.2),
    ("Rice cakes",           "grains_carbs",   "2 cakes",   70,  1,  14,  0.5),
    ("Granola",              "grains_carbs",   "1/2 cup",   220, 5,  32,  8),
    ("Cereal",               "grains_carbs",   "1 cup",     120, 2,  26,  1),

    # Vegetables
    ("Broccoli",             "vegetables",     "1 cup",     55,  4,  11, 0.6),
    ("Spinach",              "vegetables",     "1 cup",     7,   1,  1,  0.1),
    ("Kale",                 "vegetables",     "1 cup",     33,  3,  6,  0.5),
    ("Asparagus",            "vegetables",     "1 cup",     27,  3,  5,  0.2),
    ("Bell peppers",         "vegetables",     "1 cup",     31,  1,  7,  0.3),
    ("Zucchini",             "vegetables",     "1 cup",     21,  2,  4,  0.4),
    ("Carrots",              "vegetables",     "1 cup",     52,  1,  12, 0.3),
    ("Cucumber",             "vegetables",     "1 cup",     16,  1,  4,  0.1),
    ("Tomatoes",             "vegetables",     "1 cup",     32,  2,  7,  0.4),
    ("Mushrooms",            "vegetables",     "1 cup",     15,  2,  2,  0.2),
    ("Onions",               "vegetables",     "1/2 cup",   32,  1,  7,  0.1),
    ("Garlic",               "vegetables",     "1 clove",   4,   0,  1,  0),
    ("Cauliflower",          "vegetables",     "1 cup",     27,  2,  5,  0.3),
    ("Green beans",          "vegetables",     "1 cup",     31,  2,  7,  0.1),
    ("Brussels sprouts",     "vegetables",     "1 cup",     56,  4,  11, 0.8),
    ("Lettuce",              "vegetables",     "2 cups",    10,  1,  2,  0.1),

    # Fruits
    ("Banana",               "fruits",         "1 medium",  105, 1,  27, 0.4),
    ("Apple",                "fruits",         "1 medium",  95,  0.5,25, 0.3),
    ("Blueberries",          "fruits",         "1 cup",     84,  1,  21, 0.5),
    ("Strawberries",         "fruits",         "1 cup",     49,  1,  12, 0.5),
    ("Mango",                "fruits",         "1 cup",     99,  1,  25, 0.6),
    ("Orange",               "fruits",         "1 medium",  62,  1,  15, 0.2),
    ("Grapes",               "fruits",         "1 cup",     104, 1,  27, 0.2),
    ("Avocado",              "fruits",         "1/2 fruit", 120, 2,  6,  11),
    ("Pineapple",            "fruits",         "1 cup",     82,  1,  22, 0.2),
    ("Watermelon",           "fruits",         "1 cup",     46,  1,  12, 0.2),
    ("Peach",                "fruits",         "1 medium",  59,  1,  14, 0.4),
    ("Pear",                 "fruits",         "1 medium",  101, 1,  27, 0.2),
    ("Kiwi",                 "fruits",         "1 medium",  42,  0.8,10, 0.4),
    ("Raspberries",          "fruits",         "1 cup",     64,  1.5,15, 0.8),

    # Dairy
    ("Milk (whole)",         "dairy",          "1 cup",     149, 8,  12, 8),
    ("Milk (skim)",          "dairy",          "1 cup",     83,  8,  12, 0),
    ("2% milk",              "dairy",          "1 cup",     122, 8,  12, 5),
    ("Cheddar cheese",       "dairy",          "1 oz",      113, 7,  0,  9),
    ("Mozzarella",           "dairy",          "1 oz",      80,  7,  1,  6),
    ("Parmesan",             "dairy",          "1 tbsp",    21,  2,  0.2,1.4),
    ("Butter",               "dairy",          "1 tbsp",    102, 0,  0,  12),

    # Fats & oils
    ("Olive oil",            "fats_oils",      "1 tbsp",    119, 0, 0, 14),
    ("Avocado oil",          "fats_oils",      "1 tbsp",    124, 0, 0, 14),
    ("Almonds",              "fats_oils",      "1 oz",      164, 6, 6, 14),
    ("Peanut butter",        "fats_oils",      "2 tbsp",    188, 8, 7, 16),
    ("Walnuts",              "fats_oils",      "1 oz",      185, 4, 4, 19),
    ("Cashews",              "fats_oils",      "1 oz",      157, 5, 9, 12),
    ("Pistachios",           "fats_oils",      "1 oz",      159, 6, 8, 13),
    ("Chia seeds",           "fats_oils",      "1 tbsp",    58,  2, 5, 3.7),
    ("Flax seeds",           "fats_oils",      "1 tbsp",    55,  1.9,3, 4.3),
    ("Coconut oil",          "fats_oils",      "1 tbsp",    117, 0, 0, 14),

    # Snacks / extras
    ("Dark chocolate",       "fats_oils",      "1 oz",      170, 2, 13, 12),
    ("Honey",                "grains_carbs",   "1 tbsp",    64,  0, 17, 0),
    ("Jam",                  "grains_carbs",   "1 tbsp",    56,  0, 14, 0),
    ("Hummus",               "plant_proteins", "2 tbsp",    70,  2, 4,  5),
]


def seed_foods(session: Session) -> None:
    """Insert food library if the table is empty."""
    existing = session.exec(select(Food)).first()
    if existing:
        return  # already seeded

    for name, category, unit, calories, protein, carbs, fat in FOODS:
        session.add(Food(
            name=name,
            category=category,
            unit=unit,
            calories=calories,
            protein=protein,
            carbs=carbs,
            fat=fat,
            is_custom=False,
        ))
    session.commit()
    print(f"[seed] inserted {len(FOODS)} foods")


# ─── Equipment library seed data ──────────────────────────────────────────────
# Format: (name, category, icon)

EQUIPMENT_DATA = [
    # Bodyweight & Home
    ("Pull-up bar", "Bodyweight & Home", "🔩"),
    ("Resistance bands", "Bodyweight & Home", "🔗"),
    ("Yoga mat", "Bodyweight & Home", "🧘"),
    ("Jump rope", "Bodyweight & Home", "⚡"),
    ("Foam roller", "Bodyweight & Home", "🛢️"),

    # Free Weights
    ("Dumbbells", "Free Weights", "🏋️"),
    ("Barbell", "Free Weights", "🏋️"),
    ("Kettlebell", "Free Weights", "🔔"),
    ("EZ curl bar", "Free Weights", "〰️"),
    ("Weight plates", "Free Weights", "⭕"),

    # Benches & Racks
    ("Flat bench", "Benches & Racks", "🪑"),
    ("Incline bench", "Benches & Racks", "📐"),
    ("Squat rack", "Benches & Racks", "🏗️"),
    ("Power rack", "Benches & Racks", "🏗️"),

    # Gym Machines
    ("Cable machine", "Gym Machines", "🔗"),
    ("Leg press", "Gym Machines", "🦵"),
    ("Lat pulldown", "Gym Machines", "⬇️"),
    ("Chest press machine", "Gym Machines", "💪"),
    ("Seated row machine", "Gym Machines", "🔙"),
    ("Leg extension", "Gym Machines", "🦵"),
    ("Leg curl", "Gym Machines", "🦵"),
    ("Shoulder press machine", "Gym Machines", "↑"),
    ("Smith machine", "Gym Machines", "📍"),
    ("Hack squat machine", "Gym Machines", "🦵"),
    ("Leg press v-squat", "Gym Machines", "📐"),
    ("Leverage machines", "Gym Machines", "⚙️"),
]


def seed_equipment(session: Session) -> None:
    """Insert equipment library if the table is empty."""
    existing = session.exec(select(Equipment)).first()
    if existing:
        return  # already seeded

    for name, category, icon in EQUIPMENT_DATA:
        session.add(Equipment(
            name=name,
            category=category,
            icon=icon,
            is_custom=False,
        ))
    session.commit()
    print(f"[seed] inserted {len(EQUIPMENT_DATA)} equipment items")


# ─── Goal & Pace seed data ────────────────────────────────────────────────────

GOAL_OPTIONS_DATA = [
    ("fat_loss", "Lose Weight", "🔥", "Burn fat through a calorie deficit"),
    ("muscle_gain", "Build Muscle", "💪", "Gain size and mass with a calorie surplus"),
    ("body_recomp", "Body Recomposition", "⚖️", "Lose fat and build muscle simultaneously"),
    ("strength", "Build Strength", "🏋️", "Increase your 1-rep maxes and raw power"),
    ("toning", "Tone & Define", "✨", "Lean out and sculpt visible definition"),
    ("endurance", "Improve Endurance", "🏃", "Run longer, recover faster, build stamina"),
    ("athletic_performance", "Athletic Performance", "⚡", "Speed, power, and sport-specific fitness"),
    ("maintain", "Maintain & Stay Active", "🎯", "Keep your fitness level and stay healthy"),
    ("flexibility", "Flexibility & Mobility", "🧘", "Improve range of motion, reduce injury risk"),
    ("stress_relief", "Mental Wellness", "🌿", "Use movement to manage stress and mood"),
]

PACE_OPTIONS_DATA = [
    ("fat_loss", "conservative", "Slow & Steady", "🐢", "~0.5 lbs/week", "Sustainable, preserves muscle mass"),
    ("fat_loss", "moderate", "Balanced", "🚶", "~1 lb/week", "Recommended for most people"),
    ("fat_loss", "aggressive", "Aggressive", "🚀", "~1.5 lbs/week", "Fastest results, more discipline needed"),
    ("toning", "conservative", "Gentle Cut", "🐢", "~0.5 lbs/week", "Slow lean-out, very sustainable"),
    ("toning", "moderate", "Steady Cut", "🚶", "~0.75 lbs/week", "Good balance of speed and comfort"),
    ("toning", "aggressive", "Fast Cut", "🚀", "~1 lb/week", "Quicker definition, stricter diet"),
    ("muscle_gain", "conservative", "Lean Bulk", "🌱", "~0.25 lbs/week", "Minimal fat gain, slow and clean"),
    ("muscle_gain", "moderate", "Standard Bulk", "💪", "~0.5 lbs/week", "Best balance of muscle vs fat"),
    ("muscle_gain", "aggressive", "Aggressive Bulk", "🦣", "~1 lb/week", "Maximum muscle, expect some fat"),
]


def seed_goals(session: Session) -> None:
    """Insert goal and pace options if they're empty."""
    existing_goal = session.exec(select(GoalOption)).first()
    if existing_goal:
        return  # already seeded

    for value, label, icon, description in GOAL_OPTIONS_DATA:
        session.add(GoalOption(
            value=value,
            label=label,
            icon=icon,
            description=description,
        ))
    session.commit()
    print(f"[seed] inserted {len(GOAL_OPTIONS_DATA)} goal options")

    for goal_value, pace_value, label, icon, rate, description in PACE_OPTIONS_DATA:
        session.add(PaceOption(
            goal_value=goal_value,
            value=pace_value,
            label=label,
            icon=icon,
            rate=rate,
            description=description,
        ))
    session.commit()
    print(f"[seed] inserted {len(PACE_OPTIONS_DATA)} pace options")
