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
from .cardio import classify_cardio


@dataclass
class Prescription:
    sets: int
    reps: str            # free-text — "6-8", "25-40 min", "30-45s"
    rest_seconds: int
    rir_target: float


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

    # Warmup-role slots get a fixed light prescription regardless of
    # the archetype's training_type.
    if hasattr(slot, "role") and slot.role == "warmup":
        return _prescribe_warmup(slot, exercise)

    training_type = meta.training_type
    if training_type == "volume":
        return _prescribe_by_stimulus("volume", slot, exercise)
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
    }
    if archetype in _STIMULUS_ARCHETYPES:
        return _prescribe_by_stimulus(training_type, slot, exercise)
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
    return Prescription(
        sets=pres.sets, reps=pres.reps,
        rest_seconds=pres.rest_seconds, rir_target=pres.rir_target,
    )


# ── Stimulus-driven lifting ────────────────────────────────────────


def _prescribe_by_stimulus(
    training_type: str, slot, exercise: dict,
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

    if training_type == "strength":
        if role == "primary":
            return Prescription(sets=4, reps="3-5", rest_seconds=180, rir_target=1.5)
        if role == "secondary":
            return Prescription(sets=3, reps="5-8", rest_seconds=150, rir_target=2.0)
        # isolation / core
        return Prescription(sets=3, reps="8-12", rest_seconds=90, rir_target=2.0)

    if training_type == "hypertrophy":
        if role == "primary":
            return Prescription(sets=4, reps="6-10", rest_seconds=120, rir_target=2.0)
        if role == "secondary":
            return Prescription(sets=3, reps="8-12", rest_seconds=90, rir_target=2.0)
        # isolation / core
        return Prescription(sets=3, reps="10-15", rest_seconds=75, rir_target=2.5)

    # training_type == "volume"
    if role == "primary":
        return Prescription(sets=3, reps="10-15", rest_seconds=90, rir_target=2.5)
    if role == "secondary":
        return Prescription(sets=3, reps="12-15", rest_seconds=75, rir_target=3.0)
    # isolation / core
    return Prescription(sets=3, reps="12-20", rest_seconds=60, rir_target=3.0)


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
        # Short maximal sprints. Work:rest ≈ 1:6 for full ATP recovery.
        return Prescription(sets=8, reps="10-15s", rest_seconds=120, rir_target=2.5)
    if mp == "plyometric":
        return Prescription(sets=4, reps="3-5", rest_seconds=120, rir_target=2.5)
    return Prescription(sets=5, reps="3-5", rest_seconds=150, rir_target=2.5)


# ── Conditioning (cardio) ──────────────────────────────────────────


def _prescribe_conditioning(
    archetype: DayArchetype, slot, exercise: dict, inputs=None,
) -> Prescription:
    """Cardio prescription shaped by archetype, slot role, and the
    user's session_minutes budget. Interval counts and tempo block
    lengths scale with budget so a 60-minute cardio day doesn't ship
    as a 28-minute workout.

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
    # Warmup + cooldown together eat ~10 min. Work block gets the rest.
    work_minutes = max(10, session_minutes - 10)

    if archetype == DayArchetype.COND_ZONE2:
        if role == "primary":
            # Zone 2 fills most of the session. Cap at 70 min so a
            # wild session_minutes=180 request doesn't ship a 2h slog.
            z2_min = max(20, min(70, session_minutes - 8))
            z2_low = max(20, z2_min - 10)
            return Prescription(sets=1, reps=f"{z2_low}-{z2_min} min", rest_seconds=0, rir_target=1.5)
        return Prescription(sets=1, reps="3-5 min", rest_seconds=0, rir_target=1.0)

    if archetype == DayArchetype.COND_INTERVALS_SHORT:
        if "warmup" in label:
            return Prescription(sets=1, reps="5-8 min", rest_seconds=0, rir_target=1.0)
        if "cooldown" in label:
            return Prescription(sets=1, reps="3-5 min", rest_seconds=0, rir_target=1.0)
        # ~2.75 min per interval (45s work + 120s rest, 1:3 work:rest
        # ratio for near-maximal short intervals). Budget-scaled.
        count = max(6, min(16, round(work_minutes / 2.75)))
        return Prescription(sets=count, reps="30-45s", rest_seconds=120, rir_target=1.5)

    if archetype == DayArchetype.COND_INTERVALS_LONG:
        if "warmup" in label:
            return Prescription(sets=1, reps="5-8 min", rest_seconds=0, rir_target=1.0)
        if "cooldown" in label:
            return Prescription(sets=1, reps="3-5 min", rest_seconds=0, rir_target=1.0)
        # ~5 min per interval (3 min on + 2.5 min rest).
        count = max(4, min(8, round(work_minutes / 5)))
        return Prescription(sets=count, reps="2-3 min", rest_seconds=150, rir_target=2.0)

    if archetype == DayArchetype.COND_TEMPO:
        if "warmup" in label:
            return Prescription(sets=1, reps="5-8 min", rest_seconds=0, rir_target=1.0)
        if "cooldown" in label:
            return Prescription(sets=1, reps="3-5 min", rest_seconds=0, rir_target=1.0)
        # Tempo block fills the work budget, capped at 45 min.
        tempo_min = max(15, min(45, work_minutes))
        tempo_low = max(12, tempo_min - 7)
        return Prescription(sets=1, reps=f"{tempo_low}-{tempo_min} min", rest_seconds=0, rir_target=1.5)

    if archetype == DayArchetype.COND_CIRCUIT:
        # Circuit day — round-based.
        return Prescription(sets=4, reps="40s work / 20s rest", rest_seconds=60, rir_target=2.0)

    if archetype == DayArchetype.COND_SPRINT_POWER:
        if "warmup" in label:
            return Prescription(sets=1, reps="5-8 min", rest_seconds=0, rir_target=1.0)
        # Short explosive sprints with full rest.
        return Prescription(sets=8, reps="10-15s", rest_seconds=120, rir_target=2.5)

    if archetype == DayArchetype.COND_MIXED:
        if "warmup" in label or "cooldown" in label:
            return Prescription(sets=1, reps="5-8 min", rest_seconds=0, rir_target=1.0)
        if is_interval_ex:
            return Prescription(sets=6, reps="45s", rest_seconds=90, rir_target=2.0)
        return Prescription(sets=1, reps="15-20 min", rest_seconds=0, rir_target=1.5)

    # Recovery / stress-relief easy cardio.
    if archetype in (DayArchetype.RECOVERY_EASY, DayArchetype.STRESS_RELIEF_EASY):
        return Prescription(sets=1, reps="20-30 min easy", rest_seconds=0, rir_target=1.0)

    # Hybrid days — cardio portion uses a compact finisher prescription.
    # These archetypes lead with strength slots, so the cardio slot is
    # always a "finisher" block rather than the main work of the day.
    if archetype in (
        DayArchetype.HYBRID_UPPER_INTERVALS,
        DayArchetype.HYBRID_STRENGTH_INTERVALS,
    ):
        if "warmup" in label or "cooldown" in label:
            return Prescription(sets=1, reps="3-5 min", rest_seconds=0, rir_target=1.0)
        return Prescription(sets=6, reps="30s", rest_seconds=60, rir_target=2.0)
    if archetype == DayArchetype.HYBRID_LOWER_POWER:
        return Prescription(sets=6, reps="10-15s sprint", rest_seconds=90, rir_target=2.5)
    if archetype == DayArchetype.HYBRID_FULL_BODY_CIRCUIT:
        return Prescription(sets=3, reps="45s burst", rest_seconds=30, rir_target=2.0)

    # Default conditioning fallback (shouldn't hit in practice).
    return Prescription(sets=1, reps="20-30 min", rest_seconds=0, rir_target=1.5)


# ── Mobility ───────────────────────────────────────────────────────


def _prescribe_mobility(slot, exercise: dict) -> Prescription:
    """Mobility prescription: 2-3 rounds, 30-60 second holds or a
    flow time, zero rest between movements. The "reps" string is a
    hold time or flow duration — the frontend already handles the
    duration format for time-tracked exercises."""
    archetype_hint = (slot.label or "").lower()
    if "stretch" in archetype_hint or "block" in archetype_hint:
        # Focused static stretch.
        return Prescription(sets=2, reps="45-60s hold", rest_seconds=15, rir_target=1.0)
    if "flow" in archetype_hint:
        return Prescription(sets=2, reps="5-8 reps flow", rest_seconds=15, rir_target=1.0)
    # Default mobility drill.
    return Prescription(sets=2, reps="8-10 reps", rest_seconds=10, rir_target=1.0)


# ── Warmup ────────────────────────────────────────────────────────


def _prescribe_warmup(slot, exercise: dict) -> Prescription:
    """Warmup prescription: 1 set of a brief mobility drill. Either a
    45-60s hold or a 5-8 rep flow depending on the exercise type."""
    mp = (exercise.get("movement_pattern") or "").lower()
    if "stretch" in mp or "static" in mp:
        return Prescription(sets=1, reps="45-60s hold", rest_seconds=0, rir_target=1.0)
    return Prescription(sets=1, reps="5-8 reps flow", rest_seconds=0, rir_target=1.0)


# ── Recovery ───────────────────────────────────────────────────────


def _prescribe_recovery(slot, exercise: dict) -> Prescription:
    """Recovery prescription — low intensity, 15-25 minutes, no
    working-set structure. For cardio rows this looks like an easy
    walk or spin; for mobility rows (stress relief) it's a gentle
    flow."""
    if exercise.get("movement_pattern") == "cardio":
        return Prescription(sets=1, reps="15-25 min easy", rest_seconds=0, rir_target=1.0)
    return Prescription(sets=1, reps="5-8 reps easy", rest_seconds=10, rir_target=1.0)
