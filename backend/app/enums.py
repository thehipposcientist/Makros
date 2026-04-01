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
    BREAKFAST = "breakfast"
    LUNCH     = "lunch"
    DINNER    = "dinner"
    SNACK     = "snack"


class EquipmentType(str, Enum):
    GYM        = "gym"
    DUMBBELLS  = "dumbbells"
    BODYWEIGHT = "bodyweight"
    HOME       = "home"
    OTHER      = "other"


class MuscleGroup(str, Enum):
    CHEST       = "chest"
    BACK        = "back"
    SHOULDERS   = "shoulders"
    BICEPS      = "biceps"
    TRICEPS     = "triceps"
    QUADS       = "quads"
    HAMSTRINGS  = "hamstrings"
    GLUTES      = "glutes"
    CALVES      = "calves"
    CORE        = "core"
    FULL_BODY   = "full_body"
    CARDIO      = "cardio"


class WorkoutSource(str, Enum):
    GENERATED = "generated"
    CUSTOM    = "custom"
    LOGGED    = "logged"


class MealSource(str, Enum):
    GENERATED = "generated"
    LOGGED    = "logged"
