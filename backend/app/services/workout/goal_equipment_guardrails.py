"""Goal/equipment compatibility warnings for deterministic plans."""
from __future__ import annotations

from app.services.workout.equipment import resolve_owned_equipment_slugs
from app.services.workout.goals import goal_bucket


_STRENGTH_PROGRESSIVE_SLUGS = frozenset({
    "dumbbells",
    "adjustable_dumbbells",
    "barbell",
    "kettlebell",
    "ez_curl_bar",
    "trap_bar",
    "weight_plates",
    "cable_machine",
    "resistance_bands",
    "mini_band",
    "pull_up_bar",
    "dip_bars",
    "suspension_trainer",
    "weighted_vest",
    "medicine_ball",
    "sandbag",
    "sled",
    "smith_machine",
    "leg_press_machine",
    "lat_pulldown_machine",
    "chest_press_machine",
    "seated_row_machine",
    "leg_extension_machine",
    "leg_curl_machine",
    "shoulder_press_machine",
    "hack_squat_machine",
    "hip_abduction_machine",
    "hip_adduction_machine",
    "assisted_pullup_machine",
    "leverage_machines",
    "pec_deck_machine",
    "preacher_bench",
    "preacher_curl_machine",
    "standing_calf_raise_machine",
    "seated_calf_raise_machine",
    "machine_row_station",
    "plate_loaded_chest_press_machine",
    "high_row_machine",
    "v_squat_machine",
    "rotary_torso_machine",
    "glute_kickback_machine",
    "lateral_raise_machine",
    "belt_squat_machine",
    "hip_thrust_machine",
    "pullover_machine",
})

_HEAVY_STRENGTH_SLUGS = frozenset({
    "dumbbells",
    "adjustable_dumbbells",
    "barbell",
    "kettlebell",
    "ez_curl_bar",
    "trap_bar",
    "weight_plates",
    "cable_machine",
    "smith_machine",
    "leg_press_machine",
    "lat_pulldown_machine",
    "chest_press_machine",
    "seated_row_machine",
    "leg_extension_machine",
    "leg_curl_machine",
    "shoulder_press_machine",
    "hack_squat_machine",
    "assisted_pullup_machine",
    "leverage_machines",
    "machine_row_station",
    "plate_loaded_chest_press_machine",
    "high_row_machine",
    "v_squat_machine",
    "belt_squat_machine",
    "hip_thrust_machine",
})

_CARDIO_SLUGS = frozenset({
    "treadmill",
    "stationary_bike",
    "elliptical",
    "rowing_machine",
    "stair_climber",
    "assault_bike",
    "swimming_pool",
    "battle_ropes",
    "outdoor_bike",
    "skierg",
    "versaclimber",
    "heavy_bag",
    "ruck_pack",
})

_CONDITIONING_SLUGS = _CARDIO_SLUGS | frozenset({
    "bodyweight",
    "jump_rope",
    "step_platform",
    "plyo_box",
    "agility_ladder",
    "training_cones",
    "sled",
    "sandbag",
    "dumbbells",
    "adjustable_dumbbells",
    "kettlebell",
    "medicine_ball",
})

_UPPER_BODY_STRENGTH_SLUGS = frozenset({
    "dumbbells",
    "adjustable_dumbbells",
    "barbell",
    "kettlebell",
    "ez_curl_bar",
    "weight_plates",
    "cable_machine",
    "resistance_bands",
    "mini_band",
    "pull_up_bar",
    "dip_bars",
    "suspension_trainer",
    "weighted_vest",
    "medicine_ball",
    "smith_machine",
    "lat_pulldown_machine",
    "chest_press_machine",
    "seated_row_machine",
    "shoulder_press_machine",
    "assisted_pullup_machine",
    "leverage_machines",
    "pec_deck_machine",
    "preacher_bench",
    "preacher_curl_machine",
    "machine_row_station",
    "plate_loaded_chest_press_machine",
    "high_row_machine",
    "lateral_raise_machine",
    "pullover_machine",
})

_LOWER_BODY_STRENGTH_SLUGS = frozenset({
    "dumbbells",
    "adjustable_dumbbells",
    "barbell",
    "kettlebell",
    "trap_bar",
    "weight_plates",
    "cable_machine",
    "resistance_bands",
    "mini_band",
    "weighted_vest",
    "medicine_ball",
    "sandbag",
    "sled",
    "smith_machine",
    "leg_press_machine",
    "leg_extension_machine",
    "leg_curl_machine",
    "hack_squat_machine",
    "hip_abduction_machine",
    "hip_adduction_machine",
    "v_squat_machine",
    "glute_kickback_machine",
    "belt_squat_machine",
    "hip_thrust_machine",
    "standing_calf_raise_machine",
    "seated_calf_raise_machine",
})

_RUNNING_ACCESS_SLUGS = frozenset({"bodyweight", "treadmill"})
_CYCLING_ACCESS_SLUGS = frozenset({"stationary_bike", "outdoor_bike", "assault_bike"})
_FIELD_SPEED_SLUGS = frozenset({
    "bodyweight",
    "treadmill",
    "agility_ladder",
    "training_cones",
    "plyo_box",
    "sled",
})
_POWER_SLUGS = frozenset({
    "plyo_box",
    "medicine_ball",
    "sled",
    "sandbag",
    "kettlebell",
    "barbell",
    "trap_bar",
    "dumbbells",
    "adjustable_dumbbells",
})
_GRIP_SLUGS = frozenset({
    "dumbbells",
    "adjustable_dumbbells",
    "kettlebell",
    "barbell",
    "trap_bar",
    "weight_plates",
    "pull_up_bar",
    "wrist_roller",
    "sandbag",
})
_RELATIVE_STRENGTH_SLUGS = frozenset({
    "bodyweight",
    "pull_up_bar",
    "dip_bars",
    "suspension_trainer",
    "weighted_vest",
    "assisted_pullup_machine",
})
_WEIGHT_BEARING_SLUGS = _STRENGTH_PROGRESSIVE_SLUGS | frozenset({
    "bodyweight",
    "treadmill",
    "stair_climber",
    "ruck_pack",
    "jump_rope",
    "weighted_vest",
})

_RUNNING_GOALS = frozenset({
    "running_fitness",
    "train_5k",
    "train_10k",
    "train_half",
    "train_marathon",
    "run_faster",
    "marathon",
    "sprint_speed",
})
_CYCLING_GOALS = frozenset({"cycling_endurance"})
_ROWING_GOALS = frozenset({"rowing_endurance"})
_SWIMMING_GOALS = frozenset({"swimming_endurance"})
_HIKING_GOALS = frozenset({"hiking_endurance"})

_BARBELL_SPECIFIC_GOALS = frozenset({
    "powerlifting",
    "improve_1rm",
    "improve_squat",
    "improve_bench",
    "improve_deadlift",
    "improve_ohp",
})

_LOWER_BODY_MUSCLE_GOALS = frozenset({"build_glutes", "build_lower_body"})
_UPPER_BODY_MUSCLE_GOALS = frozenset({
    "build_upper_body",
    "build_arms",
    "build_shoulders",
    "improve_aesthetics",
})
_PRESERVE_STRENGTH_FAT_LOSS_GOALS = frozenset({"preserve_muscle_cutting"})
_FIELD_SPEED_GOALS = frozenset({
    "sprint_speed",
    "improve_speed",
    "improve_agility",
    "improve_acceleration",
    "improve_cod",
})
_POWER_JUMP_GOALS = frozenset({"improve_power", "improve_vertical", "explosive_strength"})
_BALANCED_HEALTH_GOALS = frozenset({
    "general_health",
    "longevity",
    "healthy_aging",
    "daily_function",
    "joint_health",
})
_METABOLIC_HEALTH_GOALS = frozenset({"metabolic_health"})
_HEART_HEALTH_GOALS = frozenset({"heart_health"})
_BONE_HEALTH_GOALS = frozenset({"bone_health"})
_POSTURE_GOALS = frozenset({"improve_posture"})


def _has(owned: set[str], options: frozenset[str] | set[str]) -> bool:
    return bool(owned & set(options))


def _append_unique(warnings: list[str], warning: str) -> None:
    if warning not in warnings:
        warnings.append(warning)


def _has_barbell_setup(gid: str, owned: set[str]) -> bool:
    has_barbell_and_plates = _has(owned, frozenset({"barbell"})) and _has(owned, frozenset({"weight_plates"}))
    has_rack = _has(owned, frozenset({"squat_rack", "power_rack"}))
    has_bench = _has(owned, frozenset({"flat_bench", "adjustable_bench"}))
    if gid in {"powerlifting", "improve_1rm"}:
        return has_barbell_and_plates and has_rack and has_bench
    if gid == "improve_squat":
        return has_barbell_and_plates and has_rack
    if gid == "improve_bench":
        return has_barbell_and_plates and has_bench
    if gid in {"improve_deadlift", "improve_ohp"}:
        return has_barbell_and_plates
    return True


def goal_equipment_warnings(goal: str | None, equipment: list[str] | tuple[str, ...] | None) -> list[str]:
    """Return deterministic warning strings for mismatched goal/equipment.

    These warnings do not block plan generation. The planner can still
    generate a fallback, but the app should be honest when that fallback
    is no longer the literal training promise of the selected goal.
    """
    gid = (goal or "").strip().lower()
    bucket = goal_bucket(gid)
    owned = resolve_owned_equipment_slugs(list(equipment or []))

    warnings: list[str] = []
    has_progressive_strength = _has(owned, _STRENGTH_PROGRESSIVE_SLUGS)
    has_heavy_strength = _has(owned, _HEAVY_STRENGTH_SLUGS)
    has_conditioning = _has(owned, _CONDITIONING_SLUGS)
    has_cardio_access = _has(owned, _CARDIO_SLUGS | frozenset({"bodyweight", "jump_rope", "step_platform"}))
    has_bodyweight = "bodyweight" in owned
    has_upper_strength = _has(owned, _UPPER_BODY_STRENGTH_SLUGS)
    has_lower_strength = _has(owned, _LOWER_BODY_STRENGTH_SLUGS)

    if bucket == "strength":
        if gid == "relative_strength":
            if not _has(owned, _RELATIVE_STRENGTH_SLUGS | _STRENGTH_PROGRESSIVE_SLUGS):
                _append_unique(
                    warnings,
                    "Relative strength can start with bodyweight work, but it needs calisthenics or resistance options "
                    "like a pull-up bar, dip bars, suspension trainer, dumbbells, or a weighted vest for specific progress.",
                )
        elif not has_progressive_strength:
            _append_unique(
                warnings,
                "Build Strength needs progressive resistance. With your current equipment, "
                "Thallo can create a bodyweight strength plan, but true heavy strength "
                "progression needs dumbbells, a barbell, bands, a pull-up bar, cables, or machines.",
            )
        elif not has_heavy_strength:
            _append_unique(
                warnings,
                "This strength setup is light-resistance dominant. It can build starter strength, "
                "but heavy 3-6 rep progression works best with free weights, cables, or machines.",
            )
        if gid in _BARBELL_SPECIFIC_GOALS and not _has_barbell_setup(gid, owned):
            _append_unique(
                warnings,
                "This strength target is barbell-specific. Add the relevant barbell, plates, rack, "
                "or bench equipment, or choose a broader strength goal.",
            )
        if gid == "improve_pullups" and not _has(owned, frozenset({"pull_up_bar", "assisted_pullup_machine"})):
            _append_unique(warnings, "Pull-up goals need a pull-up bar or assisted pull-up machine for specific progress.")
        if gid == "improve_grip" and not _has(owned, _GRIP_SLUGS):
            _append_unique(warnings, "Grip strength goals need hang, carry, or pinch-load options like dumbbells, kettlebells, plates, a barbell, pull-up bar, or wrist roller.")
        if gid == "functional_strength" and not _has(owned, frozenset({"dumbbells", "adjustable_dumbbells", "kettlebell", "sandbag", "sled", "trap_bar", "weighted_vest", "medicine_ball"})):
            _append_unique(warnings, "Functional strength works best with something you can carry, hinge, lunge, or load, such as dumbbells, kettlebells, a sandbag, sled, trap bar, weighted vest, or medicine ball.")

    if (bucket in {"muscle_gain", "body_recomp"} or gid == "maintain_physique"):
        if not has_progressive_strength:
            _append_unique(
                warnings,
                "This equipment limits muscle-building progress. The plan will lean on bodyweight work; "
                "add dumbbells, bands, cables, or machines for better progressive overload.",
            )
        elif not has_heavy_strength:
            _append_unique(
                warnings,
                "This muscle-building setup is light-resistance dominant. It can work for beginners, "
                "but hypertrophy progression is better with dumbbells, cables, machines, or heavier free weights.",
            )
        if gid in _LOWER_BODY_MUSCLE_GOALS and has_progressive_strength and not has_lower_strength:
            _append_unique(
                warnings,
                "This lower-body growth goal needs lower-body resistance. Add dumbbells, a barbell, bands, cables, "
                "leg machines, a sled, or hip-thrust/squat equipment for a better match.",
            )
        if gid in _UPPER_BODY_MUSCLE_GOALS and has_progressive_strength and not has_upper_strength:
            _append_unique(
                warnings,
                "This upper-body focus needs pressing or pulling resistance. Add dumbbells, bands, cables, "
                "a pull-up bar, dip bars, or upper-body machines for a better match.",
            )

    if gid in _PRESERVE_STRENGTH_FAT_LOSS_GOALS and not has_progressive_strength:
        _append_unique(
            warnings,
            "Preserving muscle while cutting works best with resistance training. With this equipment, "
            "the plan can support fat loss, but muscle retention is less specific.",
        )

    if bucket in {"athletic_performance", "hyrox"} and not has_progressive_strength:
        _append_unique(
            warnings,
            "Hybrid performance goals need both conditioning and resistance work. With only cardio gear, "
            "the plan becomes bike/bodyweight cross-training instead of a full hybrid program.",
        )

    if bucket == "endurance" and not has_conditioning and gid not in (_RUNNING_GOALS | _CYCLING_GOALS | _ROWING_GOALS | _SWIMMING_GOALS | _HIKING_GOALS):
        _append_unique(
            warnings,
            "Cardio and endurance goals need a conditioning option. Add a cardio machine, jump rope, outdoor/bodyweight access, "
            "or conditioning tools so the plan can match the goal.",
        )
    if gid in _RUNNING_GOALS and not _has(owned, _RUNNING_ACCESS_SLUGS):
        _append_unique(
            warnings,
            "Running goals need running exposure. A bike can support conditioning, but add treadmill/outdoor running access "
            "or switch to a cycling/cardio goal for a better match.",
        )
    if gid in _CYCLING_GOALS and not _has(owned, _CYCLING_ACCESS_SLUGS):
        _append_unique(warnings, "Cycling endurance needs a stationary, outdoor, or assault bike to match the selected goal.")
    if gid in _ROWING_GOALS and "rowing_machine" not in owned:
        _append_unique(warnings, "Rowing endurance needs a rowing machine. Other cardio gear is cross-training, not rowing-specific work.")
    if gid in _SWIMMING_GOALS and "swimming_pool" not in owned:
        _append_unique(warnings, "Swimming endurance needs pool access. Other cardio gear is cross-training, not swim-specific work.")
    if gid in _HIKING_GOALS and not _has(owned, frozenset({"bodyweight", "treadmill", "stair_climber", "ruck_pack"})):
        _append_unique(warnings, "Hiking endurance needs outdoor walking/hiking, incline treadmill, stair climber, or ruck access.")

    if gid in _FIELD_SPEED_GOALS and not _has(owned, _FIELD_SPEED_SLUGS):
        _append_unique(
            warnings,
            "Speed and agility goals need room to sprint, cut, jump, or drill. Add bodyweight/outdoor access, a treadmill, "
            "cones, an agility ladder, plyo box, or sled for a better match.",
        )
    if gid in _POWER_JUMP_GOALS and not (has_lower_strength or _has(owned, _POWER_SLUGS)):
        _append_unique(
            warnings,
            "Power and jump goals need explosive lower-body work. Add lower-body strength equipment, a plyo box, medicine ball, "
            "sled, sandbag, kettlebell, or free weights for a better match.",
        )
    if bucket == "hyrox":
        if not _has(owned, _RUNNING_ACCESS_SLUGS):
            _append_unique(warnings, "HYROX-style goals include running. Add treadmill/outdoor running access or expect a cross-training version.")
        if not _has(owned, frozenset({"rowing_machine", "skierg", "sled", "sandbag", "kettlebell", "dumbbells", "adjustable_dumbbells", "medicine_ball", "treadmill", "bodyweight"})):
            _append_unique(warnings, "HYROX-style goals need functional station tools such as rower/SkiErg, sled, sandbag, kettlebells, dumbbells, medicine ball, or running access.")

    if gid in _HEART_HEALTH_GOALS and not has_cardio_access:
        _append_unique(
            warnings,
            "Heart-health goals need a repeatable cardio option. Add a cardio machine, jump rope, step platform, or outdoor/bodyweight access.",
        )
    if gid in _METABOLIC_HEALTH_GOALS:
        if not (has_progressive_strength or has_bodyweight):
            _append_unique(warnings, "Metabolic-health goals work best with resistance training plus easy activity. Add bodyweight or progressive resistance equipment for the strength side.")
        if not has_cardio_access:
            _append_unique(warnings, "Metabolic-health goals also need easy conditioning, such as walking, cycling, treadmill, rowing, or simple bodyweight intervals.")
    if gid in _BONE_HEALTH_GOALS and not _has(owned, _WEIGHT_BEARING_SLUGS):
        _append_unique(
            warnings,
            "Bone-health goals need weight-bearing or resistance work. Bike and swim work are useful cardio, but add walking, stairs, rucking, bodyweight, or resistance equipment.",
        )
    if gid in _BALANCED_HEALTH_GOALS and not (has_progressive_strength or has_bodyweight):
        _append_unique(
            warnings,
            "This health goal is meant to stay balanced across strength, mobility, and cardio. With only machine cardio, "
            "the plan becomes less complete unless you add bodyweight or resistance options.",
        )
    if gid in _POSTURE_GOALS and not (has_upper_strength or has_bodyweight or _has(owned, frozenset({"yoga_mat", "foam_roller"}))):
        _append_unique(
            warnings,
            "Posture goals need upper-back, core, and mobility work. Add bodyweight access, bands, a pull-up/row option, cables, "
            "upper-body machines, a yoga mat, or a foam roller for a better match.",
        )

    return warnings
