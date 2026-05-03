"""Archetype-specific prescription dispatch.

Before this module, `prescribe_sets_reps` had one big goal-bucket
switch for lifting and a cardio short-circuit bolted on top. That
worked but started feeling wrong when mobility, circuit, and hybrid
archetypes arrived — the rep/set/rest model doesn't fit a flow
session, and a cardio interval day doesn't have "working sets" in the
same sense a bench-press day does.

This module owns the mapping from `(archetype, slot, exercise,
inputs)` to a `Prescription` tuple. The planner calls
`prescribe_for_slot(archetype, slot, exercise, inputs)` and gets back
the right shape for that training type:

    lifting       — sets × reps × rest (existing engine, unchanged)
    cardio        — duration-shaped reps, 1-6 sets depending on format
    mobility      — 2-3 sets of long holds / flow blocks, no rest
    recovery      — 1 set of easy duration
    hybrid        — dispatches to lifting OR cardio based on the
                    exercise's own movement_pattern

Every branch returns the same `Prescription` dataclass the existing
planner expects, so the downstream serialization path doesn't change.
"""
from __future__ import annotations

from dataclasses import dataclass

from .archetypes import DayArchetype, ARCHETYPE_META, TrainingType
from .cardio import (
    classify_cardio, build_cardio_guidance, render_cardio_prescription_text,
)


@dataclass
class Prescription:
    sets: int
    reps: str            # free-text — "6-8", "25-40 min", "30-45s"
    rest_seconds: int
    rir_target: float
    # Categorical type used by the client to render the right logging UI.
    # "strength" | "cardio_steady" | "cardio_intervals" | "mobility" |
    # "yoga_flow" | "core_circuit" | "stretch_hold" | "recovery" | "warmup"
    prescription_type: str = "strength"
    # Structured cardio targets keyed by the modality's capability tier.
    # None for non-cardio prescriptions.
    cardio_guidance: dict | None = None


def prescribe_for_slot(
    archetype: DayArchetype,
    slot,            # app.services.workout.planner.Slot — typed loosely to avoid cycle
    exercise: dict,
    inputs,          # PlannerInputs — typed loosely to avoid cycle
) -> Prescription:
    """Top-level dispatch. Reads the archetype's training_type and
    routes to the right prescription branch. Lifting is the only
    branch that currently depends on the user's goal bucket; the
    non-lifting branches use archetype-driven numbers so a muscle_gain
    user's stretch day looks the same as an endurance user's stretch
    day — because they're BOTH stretch days."""
    meta = ARCHETYPE_META.get(archetype)
    if meta is None:
        # Unknown archetype — fall back to the lifting engine so we
        # never return a bogus prescription.
        return _prescribe_lifting(slot, exercise, inputs)

    # Warmup-role slots dispatch based on the archetype's training type:
    # conditioning days get an easy-pace ramp, everything else gets a
    # dynamic movement-prep block before heavy lifts.
    if hasattr(slot, "role") and slot.role == "warmup":
        if meta.training_type == "conditioning":
            return _prescribe_cardio_warmup(slot, exercise)
        return _prescribe_warmup(slot, exercise)

    # Core-role slots always get a circuit-style prescription regardless
    # of the archetype's training_type (core slots on a push day should
    # not be prescribed with hypertrophy-style sets/reps).
    if hasattr(slot, "role") and slot.role == "core":
        return _prescribe_core(slot, exercise, inputs)

    training_type = meta.training_type
    if training_type == "volume":
        return _prescribe_by_stimulus("volume", slot, exercise, inputs)
    # Stimulus-differentiated archetypes: the new LIFT_*_HEAVY and
    # LIFT_*_HYPERTROPHY archetypes carry an explicit training_type of
    # "strength" or "hypertrophy". We detect them by checking whether
    # the archetype value contains a stimulus suffix; the OLD
    # strength/hypertrophy archetypes (LIFT_UPPER, LIFT_LOWER, etc.)
    # continue to flow through _prescribe_lifting which delegates to
    # the goal-bucket-aware prescribe_sets_reps. The new ones use the
    # stimulus-driven prescriber instead.
    _STIMULUS_ARCHETYPES = {
        DayArchetype.LIFT_UPPER_HEAVY,
        DayArchetype.LIFT_UPPER_HYPERTROPHY,
        DayArchetype.LIFT_LOWER_HEAVY,
        DayArchetype.LIFT_LOWER_HYPERTROPHY,
        DayArchetype.LIFT_FULL_BODY_STRENGTH,
        # Heavy PPL archetypes carry an explicit "strength" training_type
        # and must route through the stimulus prescriber so a Push Heavy
        # day ships 3-5 rep sets (not the goal-bucket fallback).
        DayArchetype.LIFT_PUSH_HEAVY,
        DayArchetype.LIFT_PULL_HEAVY,
        DayArchetype.LIFT_LEGS_HEAVY,
    }
    if archetype in _STIMULUS_ARCHETYPES:
        return _prescribe_by_stimulus(training_type, slot, exercise, inputs)
    if training_type in ("strength", "hypertrophy"):
        return _prescribe_lifting(slot, exercise, inputs)
    if training_type == "power":
        return _prescribe_power(slot, exercise, inputs)
    if training_type == "conditioning":
        return _prescribe_conditioning(archetype, slot, exercise, inputs)
    if training_type == "mobility":
        return _prescribe_mobility(slot, exercise)
    if training_type == "recovery":
        return _prescribe_recovery(slot, exercise)
    if training_type == "mixed":
        # Hybrid days pick per-exercise — cardio rows get a conditioning
        # prescription, strength rows get a lifting prescription.
        if exercise.get("movement_pattern") == "cardio":
            return _prescribe_conditioning(archetype, slot, exercise, inputs)
        return _prescribe_lifting(slot, exercise, inputs)
    return _prescribe_lifting(slot, exercise, inputs)


# ── Lifting ────────────────────────────────────────────────────────


def _prescribe_lifting(slot, exercise: dict, inputs) -> Prescription:
    """Thin wrapper that delegates to the existing
    `planner.prescribe_sets_reps`. Kept separate so future callers
    can swap it out without touching the archetype dispatch."""
    from .planner import prescribe_sets_reps
    pres = prescribe_sets_reps(exercise, slot, inputs)
    return _apply_lifting_session_density(Prescription(
        sets=pres.sets, reps=pres.reps,
        rest_seconds=pres.rest_seconds, rir_target=pres.rir_target,
        prescription_type="strength",
    ), slot, inputs)


def _apply_lifting_session_density(prescription: Prescription, slot, inputs) -> Prescription:
    """Scale working sets for longer lifting sessions.

    Slot expansion adds more exercises when the catalog can support it, but
    long sessions still underfill when eligible accessories run out. Adding
    sets to the existing movement pattern is deterministic and keeps the day
    focused without forcing awkward duplicate exercises.
    """
    if prescription.prescription_type != "strength":
        return prescription
    role = getattr(slot, "role", "")
    if role in ("warmup", "core"):
        return prescription
    try:
        session_minutes = int(getattr(inputs, "session_minutes", None) or 45)
    except (TypeError, ValueError):
        session_minutes = 45
    if session_minutes < 60:
        return prescription

    bonus = 2 if session_minutes >= 90 else 1
    caps = {
        "primary": 6 if session_minutes >= 90 else 5,
        "secondary": 5 if session_minutes >= 90 else 4,
        "isolation": 5 if session_minutes >= 90 else 4,
        "accessory": 5 if session_minutes >= 90 else 4,
    }
    cap = caps.get(role, 4 if session_minutes < 90 else 5)
    prescription.sets = min(cap, prescription.sets + bonus)
    return prescription


# ── Stimulus-driven lifting ────────────────────────────────────────


def _prescribe_by_stimulus(
    training_type: str, slot, exercise: dict, inputs=None,
) -> Prescription:
    """Prescription for stimulus-differentiated lifting archetypes.

    Unlike `_prescribe_lifting` (which delegates to goal-bucket-aware
    `prescribe_sets_reps`), this function prescribes based on the
    archetype's explicit training_type so a "heavy" day always gets
    heavy parameters regardless of the user's goal bucket.

    training_type values handled:
        "strength"    — low rep, long rest, low RIR
        "hypertrophy" — moderate rep, moderate rest
        "volume"      — high rep, short rest, higher RIR
    """
    role = slot.role

    def _done(prescription: Prescription) -> Prescription:
        return _apply_lifting_session_density(prescription, slot, inputs)

    if training_type == "strength":
        if role == "primary":
            return _done(Prescription(sets=4, reps="3-5", rest_seconds=180, rir_target=1.5, prescription_type="strength"))
        if role == "secondary":
            return _done(Prescription(sets=3, reps="5-8", rest_seconds=150, rir_target=2.0, prescription_type="strength"))
        return _done(Prescription(sets=3, reps="8-12", rest_seconds=90, rir_target=2.0, prescription_type="strength"))

    if training_type == "hypertrophy":
        if role == "primary":
            return _done(Prescription(sets=4, reps="6-10", rest_seconds=120, rir_target=2.0, prescription_type="strength"))
        if role == "secondary":
            return _done(Prescription(sets=3, reps="8-12", rest_seconds=90, rir_target=2.0, prescription_type="strength"))
        return _done(Prescription(sets=3, reps="10-15", rest_seconds=75, rir_target=2.5, prescription_type="strength"))

    # training_type == "volume"
    if role == "primary":
        return _done(Prescription(sets=3, reps="10-15", rest_seconds=90, rir_target=2.5, prescription_type="strength"))
    if role == "secondary":
        return _done(Prescription(sets=3, reps="12-15", rest_seconds=75, rir_target=3.0, prescription_type="strength"))
    return _done(Prescription(sets=3, reps="12-20", rest_seconds=60, rir_target=3.0, prescription_type="strength"))


# ── Power / plyometric ─────────────────────────────────────────────


def _prescribe_power(slot, exercise: dict, inputs) -> Prescription:
    """Power / sprint / plyometric prescription. Splits by the
    exercise's actual movement pattern:
      - cardio (sprints) → short duration work + full rest
      - plyometric (bodyweight jumps) → 4 × 3-5 reps
      - loaded power (trap bar jump, hang clean) → 5 × 3-5 reps
    Without this split, Stationary Bike would have been prescribed
    "3-5 reps" on a sprint day — nonsense."""
    mp = exercise.get("movement_pattern") or ""
    if mp == "cardio":
        return Prescription(sets=8, reps="10-15s", rest_seconds=120, rir_target=2.5, prescription_type="cardio_intervals")
    if mp == "plyometric":
        return Prescription(sets=4, reps="3-5", rest_seconds=120, rir_target=2.5, prescription_type="strength")
    return Prescription(sets=5, reps="3-5", rest_seconds=150, rir_target=2.5, prescription_type="strength")


# ── Conditioning (cardio) ──────────────────────────────────────────


def _prescribe_conditioning(
    archetype: DayArchetype, slot, exercise: dict, inputs=None,
) -> Prescription:
    """Cardio prescription shaped by archetype, slot role, and the
    user's session_minutes budget. Interval counts and tempo block
    lengths scale with budget so a 60-minute cardio day doesn't ship
    as a 28-minute workout.

    For primary cardio slots, equipment-specific guidance is built via
    build_cardio_guidance so the prescription text reflects the user's
    actual equipment (watts for a smart bike, speed+incline for a
    treadmill, RPE fallback when no capability data is available).

    Scaling rules:
      - `session_minutes` pulled off `inputs` (PlannerInputs); defaults
        to 45 if not provided.
      - Pool of ~10 min for warmup + cooldown leaves `work_minutes`
        for the main block.
      - Short intervals: ~2.75 min per interval (45s on + 120s rest)
        so `interval_count = round(work_minutes / 2.75)`, clamped 6-16.
      - Long intervals: ~5 min per (3 min on + 2:30 rest),
        `count = round(work_minutes / 5)`, clamped 4-8.
      - Tempo / Zone 2: main block uses the full remaining work time.
    """
    role = slot.role
    label = (slot.label or "").lower()
    is_interval_ex = classify_cardio(exercise) == "intervals"
    session_minutes = int(getattr(inputs, "session_minutes", None) or 45)
    work_minutes = max(10, session_minutes - 10)

    # Equipment capabilities from PlannerInputs (optional field).
    user_caps: dict = {}
    if inputs is not None:
        user_caps = getattr(inputs, "user_equipment_capabilities", None) or {}
    user_age = getattr(inputs, "user_age", None) if inputs else None
    resting_hr = getattr(inputs, "resting_hr", None) if inputs else None

    def _make_cardio(
        sets: int,
        base_reps: str,
        rest: int,
        rir: float,
        p_type: str,
        *,
        enhance: bool = True,
    ) -> Prescription:
        """Build a Prescription, optionally enhancing it with modality-
        specific cardio_guidance. ``enhance=True`` on main-block slots;
        warm-up/cool-down slots skip guidance to stay concise."""
        if not enhance:
            return Prescription(sets=sets, reps=base_reps, rest_seconds=rest,
                                rir_target=rir, prescription_type=p_type)
        from .cardio import detect_cardio_modality
        ex_name = exercise.get("name", "")
        modality = detect_cardio_modality(ex_name)
        caps = list(user_caps.get(modality, [])) if modality else []
        guidance = build_cardio_guidance(
            exercise,
            archetype_name=archetype.value if archetype else "",
            session_minutes=session_minutes,
            capabilities=caps,
            user_age=user_age,
            resting_hr=resting_hr,
        )
        # The prescription's base_reps is the authoritative duration —
        # override the session_minutes-derived value from build_cardio_guidance
        # so a Cardio Finisher with "8-12 min" reps doesn't get rendered as
        # a 50-minute Zone 2 block.
        import re as _re
        _range_match = _re.search(r"(\d+)\s*-\s*(\d+)\s*min", base_reps)
        _single_match = None if _range_match else _re.search(r"^\s*(\d+)\s*min", base_reps)
        if _range_match:
            guidance["duration_min"] = int(_range_match.group(2))
        elif _single_match:
            guidance["duration_min"] = int(_single_match.group(1))
        rep_text = render_cardio_prescription_text(guidance, ex_name)
        return Prescription(
            sets=sets,
            reps=rep_text or base_reps,
            rest_seconds=rest,
            rir_target=rir,
            prescription_type=p_type,
            cardio_guidance=guidance,
        )

    if archetype == DayArchetype.COND_ZONE2:
        if role == "primary":
            z2_min = max(20, min(70, session_minutes - 8))
            z2_low = max(20, z2_min - 10)
            return _make_cardio(1, f"{z2_low}-{z2_min} min", 0, 1.5, "cardio_steady")
        return Prescription(sets=1, reps="3-5 min", rest_seconds=0, rir_target=1.0,
                            prescription_type="cardio_steady", enhance=False) if False else \
               Prescription(sets=1, reps="3-5 min", rest_seconds=0, rir_target=1.0,
                            prescription_type="cardio_steady")

    if archetype == DayArchetype.COND_INTERVALS_SHORT:
        if "warmup" in label:
            return Prescription(sets=1, reps="5-8 min", rest_seconds=0, rir_target=1.0,
                                prescription_type="cardio_steady")
        if "cooldown" in label:
            return Prescription(sets=1, reps="3-5 min", rest_seconds=0, rir_target=1.0,
                                prescription_type="cardio_steady")
        count = max(6, min(16, round(work_minutes / 2.75)))
        return _make_cardio(count, "30-45s", 120, 1.5, "cardio_intervals")

    if archetype == DayArchetype.COND_INTERVALS_LONG:
        if "warmup" in label:
            return Prescription(sets=1, reps="5-8 min", rest_seconds=0, rir_target=1.0,
                                prescription_type="cardio_steady")
        if "cooldown" in label:
            return Prescription(sets=1, reps="3-5 min", rest_seconds=0, rir_target=1.0,
                                prescription_type="cardio_steady")
        count = max(4, min(8, round(work_minutes / 5)))
        return _make_cardio(count, "2-3 min", 150, 2.0, "cardio_intervals")

    if archetype == DayArchetype.COND_TEMPO:
        if "warmup" in label:
            return Prescription(sets=1, reps="5-8 min", rest_seconds=0, rir_target=1.0,
                                prescription_type="cardio_steady")
        if "cooldown" in label:
            return Prescription(sets=1, reps="3-5 min", rest_seconds=0, rir_target=1.0,
                                prescription_type="cardio_steady")
        tempo_min = max(15, min(45, work_minutes))
        tempo_low = max(12, tempo_min - 7)
        return _make_cardio(1, f"{tempo_low}-{tempo_min} min", 0, 1.5, "cardio_steady")

    if archetype == DayArchetype.COND_CIRCUIT:
        return Prescription(sets=4, reps="40s work / 20s rest", rest_seconds=60,
                            rir_target=2.0, prescription_type="cardio_intervals")

    if archetype == DayArchetype.COND_SPRINT_POWER:
        if "warmup" in label:
            return Prescription(sets=1, reps="5-8 min", rest_seconds=0, rir_target=1.0,
                                prescription_type="cardio_steady")
        return _make_cardio(8, "10-15s", 120, 2.5, "cardio_intervals")

    if archetype == DayArchetype.COND_MIXED:
        if "warmup" in label or "cooldown" in label:
            return Prescription(sets=1, reps="5-8 min", rest_seconds=0, rir_target=1.0,
                                prescription_type="cardio_steady")
        if is_interval_ex:
            return _make_cardio(6, "45s", 90, 2.0, "cardio_intervals")
        return _make_cardio(1, "15-20 min", 0, 1.5, "cardio_steady")

    if archetype in (DayArchetype.RECOVERY_EASY, DayArchetype.STRESS_RELIEF_EASY):
        return _make_cardio(1, "20-30 min easy", 0, 1.0, "cardio_steady")

    if archetype in (
        DayArchetype.HYBRID_UPPER_INTERVALS,
        DayArchetype.HYBRID_STRENGTH_INTERVALS,
    ):
        if "warmup" in label or "cooldown" in label:
            return Prescription(sets=1, reps="3-5 min", rest_seconds=0, rir_target=1.0,
                                prescription_type="cardio_steady")
        return _make_cardio(6, "30s", 60, 2.0, "cardio_intervals")
    if archetype == DayArchetype.HYBRID_LOWER_POWER:
        return _make_cardio(6, "10-15s sprint", 90, 2.5, "cardio_intervals")
    if archetype == DayArchetype.HYBRID_FULL_BODY_CIRCUIT:
        return _make_cardio(3, "45s burst", 30, 2.0, "cardio_intervals")

    # PLUS_CARDIO finisher slots (mixed archetype, cardio role)
    # Role was "isolation" historically; changed to "secondary" so the
    # finisher survives density trimming on 45-min sessions. Accept both.
    # Duration scales with session_minutes so the lift+cardio total stays
    # in the user's chosen range — the lift portion of a 7-slot template
    # already runs ~50 min, leaving ~5-15 min for the finisher at sm=60.
    if role in ("isolation", "secondary"):
        if session_minutes <= 45:
            finisher_reps = "3-5 min"
        elif session_minutes <= 60:
            finisher_reps = "8-12 min"
        elif session_minutes <= 75:
            finisher_reps = "12-18 min"
        else:
            finisher_reps = "18-25 min"
        return _make_cardio(1, finisher_reps, 0, 1.5, "cardio_steady")

    return _make_cardio(1, "20-30 min", 0, 1.5, "cardio_steady")


# ── Mobility ───────────────────────────────────────────────────────


def _prescribe_mobility(slot, exercise: dict) -> Prescription:
    """Mobility prescription: 2-3 rounds, 30-60 second holds or flow
    time, minimal rest between movements.

    Yoga exercises get a duration-based prescription with style context
    rather than being treated as generic stretching. Detection uses the
    exercise name and label — explicit enough to distinguish a yoga flow
    from a foam-roll session without adding a schema field.
    """
    ex_name = (exercise.get("name") or "").lower()
    label   = (slot.label or "").lower()

    # Yoga — duration block, not sets × reps
    is_yoga = "yoga" in ex_name or "yoga" in label or "vinyasa" in ex_name or "yin " in ex_name
    if is_yoga:
        return Prescription(sets=1, reps="15-20 min flow", rest_seconds=0,
                            rir_target=1.0, prescription_type="yoga_flow")

    if "stretch" in label or "block" in label or "hold" in ex_name:
        return Prescription(sets=2, reps="45-60s hold", rest_seconds=15,
                            rir_target=1.0, prescription_type="stretch_hold")
    if "flow" in label:
        return Prescription(sets=2, reps="5-8 reps flow", rest_seconds=15,
                            rir_target=1.0, prescription_type="mobility")
    return Prescription(sets=2, reps="8-10 reps", rest_seconds=10,
                        rir_target=1.0, prescription_type="mobility")


# ── Warmup ────────────────────────────────────────────────────────


def _prescribe_warmup(slot, exercise: dict) -> Prescription:
    """Warmup prescription: always a short, DYNAMIC movement-prep block.

    Static stretching and long mobility holds reduce peak force output
    before heavy lifts. So regardless of the underlying exercise's
    movement pattern, we prescribe a dynamic flow (2 sets × 6-8 reps,
    no rest, low RIR). If the exercise library happened to pick a
    static stretch for this slot, the user still performs it as a
    dynamic flow rather than a long held position.

    Density trimming (slots.py `density_adjust_slots`) drops the whole
    warmup slot first when `session_minutes` is tight, so SHORT
    sessions (<=30 min) skip this block entirely and go straight to
    ramp-up sets on the primary lift.
    """
    return Prescription(sets=2, reps="6-8 reps flow", rest_seconds=0,
                        rir_target=1.0, prescription_type="warmup")


def _prescribe_cardio_warmup(slot, exercise: dict) -> Prescription:
    """Cardio warmup: 3-5 min progressive ramp from easy to moderate pace."""
    return Prescription(sets=1, reps="3-5 min easy ramp", rest_seconds=0,
                        rir_target=1.0, prescription_type="warmup")



# ── Recovery ───────────────────────────────────────────────────────


def _prescribe_recovery(slot, exercise: dict) -> Prescription:
    """Recovery prescription — low intensity, 15-25 minutes, no
    working-set structure. For cardio rows this looks like an easy
    walk or spin; for mobility rows (stress relief) it's a gentle
    flow."""
    if exercise.get("movement_pattern") == "cardio":
        return Prescription(sets=1, reps="15-25 min easy", rest_seconds=0,
                            rir_target=1.0, prescription_type="recovery")
    return Prescription(sets=1, reps="5-8 reps easy", rest_seconds=10,
                        rir_target=1.0, prescription_type="recovery")


# ── Core circuit ───────────────────────────────────────────────────────────────


def _prescribe_core(slot, exercise: dict, inputs=None) -> Prescription:
    """Core-circuit prescription.

    Core slots are NOT prescribed as strength sets — dead bugs and
    Pallof presses have no meaningful "weight × reps" structure, and
    treating them identically to a bench press set produces prescriptions
    like "3 × 8-12 reps" for an anti-extension hold, which is wrong.

    Instead, each core movement gets a category-appropriate prescription:
      anti_extension  → 3 rounds × 30-45s hold (or 8-12 reps for dynamic)
      anti_rotation   → 3 rounds × 10-15 reps per side (or 30-45s hold)
      lateral_stability → 2-3 rounds × 30-45s per side
      flexion_lower_ab  → 3 rounds × 12-20 reps
      carry / bracing   → 3 rounds × 30-40m or 40-60s

    The pattern is encoded in the slot label (set by core_programmer.py)
    so no schema change is needed.
    """
    label   = (slot.label or "").lower()
    ex_name = (exercise.get("name") or "").lower()
    mp      = (exercise.get("movement_pattern") or "").lower()
    tm      = (exercise.get("default_tracking_mode") or "reps").lower()

    # Carry / bracing — distance or timed
    if "carry" in label or "bracing" in label or "carry" in ex_name:
        return Prescription(sets=3, reps="30-40m or 40-60s", rest_seconds=60,
                            rir_target=1.5, prescription_type="core_circuit")

    # Anti-extension (plank, dead bug, rollout)
    if "anti-extension" in label or "anti_extension" in mp:
        if tm == "time" or any(kw in ex_name for kw in ("plank", "dead bug", "rollout", "hollow")):
            return Prescription(sets=3, reps="30-45s hold", rest_seconds=45,
                                rir_target=1.5, prescription_type="core_circuit")
        return Prescription(sets=3, reps="8-12 reps", rest_seconds=45,
                            rir_target=1.5, prescription_type="core_circuit")

    # Anti-rotation (Pallof press, bird dog)
    if "anti-rotation" in label or "anti_rotation" in mp:
        if any(kw in ex_name for kw in ("pallof", "bird dog", "bird-dog")):
            return Prescription(sets=3, reps="10-15 reps per side", rest_seconds=45,
                                rir_target=1.5, prescription_type="core_circuit")
        if tm == "time":
            return Prescription(sets=3, reps="30-45s hold per side", rest_seconds=45,
                                rir_target=1.5, prescription_type="core_circuit")
        return Prescription(sets=3, reps="10-15 reps", rest_seconds=45,
                            rir_target=1.5, prescription_type="core_circuit")

    # Lateral stability (side plank, Copenhagen)
    if "lateral" in label:
        return Prescription(sets=3, reps="30-45s per side", rest_seconds=45,
                            rir_target=1.5, prescription_type="core_circuit")

    # Flexion / lower ab (hanging leg raise, reverse crunch)
    if "lower ab" in label or "flexion" in label:
        return Prescription(sets=3, reps="12-20 reps", rest_seconds=45,
                            rir_target=2.0, prescription_type="core_circuit")

    # Generic core fallback
    if tm == "time":
        return Prescription(sets=3, reps="30-45s", rest_seconds=45,
                            rir_target=1.5, prescription_type="core_circuit")
    return Prescription(sets=3, reps="10-15 reps", rest_seconds=45,
                        rir_target=1.5, prescription_type="core_circuit")
