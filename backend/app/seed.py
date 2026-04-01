from sqlmodel import Session, select
from app.models import Exercise

# ─── Exercise library seed data ───────────────────────────────────────────────
# Format: (name, primary_muscle, secondary_muscles, equipment, is_compound, description)

EXERCISES = [
    # Chest
    ("Barbell Bench Press",     "chest",      ["triceps", "shoulders"], "gym",        True,  "Classic horizontal press — primary chest builder"),
    ("Incline Barbell Press",   "chest",      ["triceps", "shoulders"], "gym",        True,  "Upper chest focus with inclined bench"),
    ("Dumbbell Bench Press",    "chest",      ["triceps", "shoulders"], "dumbbells",  True,  "Greater range of motion than barbell"),
    ("Dumbbell Fly",            "chest",      [],                       "dumbbells",  False, "Isolation stretch for the chest"),
    ("Cable Fly",               "chest",      [],                       "gym",        False, "Constant tension chest isolation"),
    ("Push-ups",                "chest",      ["triceps", "shoulders"], "bodyweight", True,  "Foundational bodyweight chest exercise"),
    ("Dips",                    "chest",      ["triceps"],              "gym",        True,  "Lean forward to emphasise chest"),

    # Back
    ("Deadlift",                "back",       ["hamstrings", "glutes", "core"], "gym",       True,  "King of compound lifts — full posterior chain"),
    ("Romanian Deadlift",       "hamstrings", ["glutes", "back"],               "gym",       True,  "Hip-hinge pattern targeting hamstrings"),
    ("Barbell Row",             "back",       ["biceps"],                        "gym",       True,  "Horizontal pull — lat and mid-back width"),
    ("Dumbbell Row",            "back",       ["biceps"],                        "dumbbells", True,  "Unilateral back builder with good stretch"),
    ("Pull-ups",                "back",       ["biceps"],                        "bodyweight",True,  "Best bodyweight back exercise"),
    ("Lat Pulldown",            "back",       ["biceps"],                        "gym",       True,  "Cable pull-down for lat width"),
    ("Seated Cable Row",        "back",       ["biceps"],                        "gym",       True,  "Horizontal cable pull for mid-back thickness"),
    ("Face Pull",               "shoulders",  ["back"],                          "gym",       False, "Rear delt and rotator cuff health"),
    ("Inverted Row",            "back",       ["biceps"],                        "bodyweight",True,  "Bodyweight horizontal pull"),

    # Shoulders
    ("Overhead Press",          "shoulders",  ["triceps"],              "gym",        True,  "Standing or seated barbell shoulder press"),
    ("Dumbbell Shoulder Press", "shoulders",  ["triceps"],              "dumbbells",  True,  "Seated dumbbell press for shoulders"),
    ("Lateral Raise",           "shoulders",  [],                       "dumbbells",  False, "Side delt isolation — shoulder width"),
    ("Front Raise",             "shoulders",  [],                       "dumbbells",  False, "Anterior delt isolation"),
    ("Arnold Press",            "shoulders",  ["triceps"],              "dumbbells",  True,  "Rotational press hitting all three delt heads"),

    # Biceps
    ("Barbell Curl",            "biceps",     [],                       "gym",        False, "Classic barbell bicep curl"),
    ("Dumbbell Curl",           "biceps",     [],                       "dumbbells",  False, "Alternating or simultaneous dumbbell curl"),
    ("Hammer Curl",             "biceps",     ["forearms"],             "dumbbells",  False, "Neutral grip curl for brachialis"),
    ("Preacher Curl",           "biceps",     [],                       "gym",        False, "Isolates biceps with preacher bench support"),
    ("Cable Curl",              "biceps",     [],                       "gym",        False, "Constant tension curl on cable machine"),

    # Triceps
    ("Skull Crusher",           "triceps",    [],                       "gym",        False, "Lying tricep extension with barbell or EZ bar"),
    ("Tricep Pushdown",         "triceps",    [],                       "gym",        False, "Cable pushdown for tricep isolation"),
    ("Close-grip Bench Press",  "triceps",    ["chest"],                "gym",        True,  "Bench press variation emphasising triceps"),
    ("Overhead Tricep Extension","triceps",   [],                       "dumbbells",  False, "Long head stretch with overhead position"),

    # Quads
    ("Barbell Squat",           "quads",      ["glutes", "hamstrings"], "gym",        True,  "Foundational lower body compound movement"),
    ("Leg Press",               "quads",      ["glutes", "hamstrings"], "gym",        True,  "Machine squat variation — high volume friendly"),
    ("Leg Extension",           "quads",      [],                       "gym",        False, "Quad isolation on machine"),
    ("Hack Squat",              "quads",      ["glutes"],               "gym",        True,  "Machine squat with upright torso"),
    ("Bulgarian Split Squat",   "quads",      ["glutes", "hamstrings"], "dumbbells",  True,  "Unilateral leg exercise with rear foot elevated"),
    ("Lunges",                  "quads",      ["glutes", "hamstrings"], "bodyweight", True,  "Walking or stationary lunge"),
    ("Bodyweight Squat",        "quads",      ["glutes"],               "bodyweight", True,  "Squat with no added weight"),

    # Hamstrings
    ("Leg Curl",                "hamstrings", [],                       "gym",        False, "Lying or seated hamstring curl on machine"),
    ("Good Morning",            "hamstrings", ["back", "glutes"],       "gym",        True,  "Hip hinge with barbell on upper back"),

    # Glutes
    ("Hip Thrust",              "glutes",     ["hamstrings"],           "gym",        True,  "Barbell hip thrust — best glute builder"),
    ("Glute Bridge",            "glutes",     ["hamstrings"],           "bodyweight", True,  "Bodyweight hip extension on the floor"),
    ("Cable Glute Kickback",    "glutes",     [],                       "gym",        False, "Cable isolation for glute contraction"),

    # Calves
    ("Standing Calf Raise",     "calves",     [],                       "gym",        False, "Bilateral calf raise on machine or step"),
    ("Seated Calf Raise",       "calves",     [],                       "gym",        False, "Soleus focus with bent knee position"),

    # Core
    ("Plank",                   "core",       [],                       "bodyweight", False, "Isometric core stabilisation hold"),
    ("Cable Crunch",            "core",       [],                       "gym",        False, "Weighted crunch using cable machine"),
    ("Hanging Leg Raise",       "core",       [],                       "gym",        False, "Lower ab focus hanging from pull-up bar"),
    ("Russian Twist",           "core",       [],                       "bodyweight", False, "Rotational core exercise"),
    ("Ab Wheel Rollout",        "core",       ["shoulders"],            "gym",        False, "Challenging anti-extension core exercise"),

    # Cardio / full body
    ("Treadmill Run",           "cardio",     [],                       "gym",        False, "Steady state or interval treadmill cardio"),
    ("Rowing Machine",          "full_body",  [],                       "gym",        True,  "Full body cardio with strong back activation"),
    ("Kettlebell Swing",        "full_body",  ["glutes", "hamstrings"], "gym",        True,  "Hip-hinge power movement with kettlebell"),
    ("Burpees",                 "full_body",  [],                       "bodyweight", True,  "High intensity full body conditioning"),
    ("Box Jump",                "quads",      ["glutes"],               "gym",        True,  "Plyometric lower body power exercise"),
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
