from enum import Enum


class GoalType(str, Enum):
    FAT_LOSS             = "fat_loss"
    MUSCLE_GAIN          = "muscle_gain"
    BODY_RECOMP          = "body_recomp"
    STRENGTH             = "strength"
    ENDURANCE            = "endurance"
    ATHLETIC_PERFORMANCE = "athletic_performance"
    TONING               = "toning"
    MAINTAIN             = "maintain"
    FLEXIBILITY          = "flexibility"
    STRESS_RELIEF        = "stress_relief"


class GoalPace(str, Enum):
    CONSERVATIVE = "conservative"
    MODERATE     = "moderate"
    AGGRESSIVE   = "aggressive"


class Gender(str, Enum):
    MALE              = "male"
    FEMALE            = "female"
    NONBINARY         = "nonbinary"
    PREFER_NOT_TO_SAY = "prefer_not_to_say"


class MealType(str, Enum):
    BREAKFAST     = "breakfast"
    LUNCH         = "lunch"
    DINNER        = "dinner"
    SNACK         = "snack"
    # Timing-aware types unlock pre/post-workout fueling insights,
    # caffeine-timing warnings, and fasting-window analytics.
    PRE_WORKOUT   = "pre_workout"
    POST_WORKOUT  = "post_workout"


class EquipmentType(str, Enum):
    GYM        = "gym"
    DUMBBELLS  = "dumbbells"
    BODYWEIGHT = "bodyweight"
    HOME       = "home"
    CARDIO     = "cardio"
    OTHER      = "other"


class MuscleGroup(str, Enum):
    CHEST        = "chest"
    BACK         = "back"
    SHOULDERS    = "shoulders"
    BICEPS       = "biceps"
    TRICEPS      = "triceps"
    QUADS        = "quads"
    HAMSTRINGS   = "hamstrings"
    GLUTES       = "glutes"
    CALVES       = "calves"
    CORE         = "core"
    TRAPS        = "traps"
    FOREARMS     = "forearms"
    ADDUCTORS    = "adductors"
    HIP_FLEXORS  = "hip_flexors"
    FULL_BODY    = "full_body"
    CARDIO       = "cardio"


class MovementPattern(str, Enum):
    SQUAT           = "squat"
    HINGE           = "hinge"
    LUNGE           = "lunge"
    HORIZONTAL_PRESS = "horizontal_press"
    VERTICAL_PRESS  = "vertical_press"
    HORIZONTAL_PULL = "horizontal_pull"
    VERTICAL_PULL   = "vertical_pull"
    CARRY           = "carry"
    ROTATION        = "rotation"
    ANTI_ROTATION   = "anti_rotation"
    ANTI_EXTENSION  = "anti_extension"
    ISOLATION       = "isolation"
    CARDIO          = "cardio"
    MOBILITY        = "mobility"
    PLYOMETRIC      = "plyometric"


class ExerciseType(str, Enum):
    STRENGTH = "strength"
    CARDIO   = "cardio"
    MOBILITY = "mobility"


class EquipmentRole(str, Enum):
    PRIMARY  = "primary"
    SUPPORT  = "support"
    OPTIONAL = "optional"


class WorkoutSource(str, Enum):
    GENERATED = "generated"
    CUSTOM    = "custom"
    LOGGED    = "logged"


class MealSource(str, Enum):
    GENERATED = "generated"
    LOGGED    = "logged"


class FoodCategory(str, Enum):
    PROTEINS        = "proteins"
    PLANT_PROTEINS  = "plant_proteins"
    GRAINS_CARBS    = "grains_carbs"
    VEGETABLES      = "vegetables"
    FRUITS          = "fruits"
    DAIRY           = "dairy"
    FATS_OILS       = "fats_oils"
    # 2026-04-13: added three categories for items that were previously
    # shoehorned into the closest food group. This prevents the meal
    # assembler's slot-aware fallback logic from picking coffee as a
    # "vegetable" for a lunch plate, etc.
    CONDIMENTS      = "condiments"   # sauces, dressings, hot sauce, salsa
    BEVERAGES       = "beverages"    # coffee, juice, sports drinks
    SUPPLEMENTS     = "supplements"  # creatine, pre-workout, vitamins


class FoodSource(str, Enum):
    SEED    = "seed"       # curated seed data shipped with the app
    USDA    = "usda"       # imported from USDA FoodData Central
    BARCODE = "barcode"    # scanned via barcode / Open Food Facts
    USER    = "user"       # created by a specific user
    AI      = "ai"         # auto-created by AI as fallback
