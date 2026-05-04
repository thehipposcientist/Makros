"""Change workout day type/archetype with week reconciliation.

Core product rule: changing a workout type is allowed, but Thallo
should protect the user from breaking the plan.

Two modes:
  single  — change this day only, report conflicts
  smart   — change this day + reconcile remaining week
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, Optional

from .switch_day import (
    NON_LIFTING_FOCUSES,
    _canonical_cycle_for_split,
    _focus_family,
    normalize_focus,
)


# ── Data structures ────────────────────────────────────────────────

@dataclass
class DaySlot:
    index: int
    focus: str
    family: str
    locked: bool
    is_lifting: bool
    is_rest: bool = False

    @staticmethod
    def from_dict(idx: int, d: dict, *, locked: bool = False) -> "DaySlot":
        raw_focus = (d.get("focus") or "").strip()
        nf = normalize_focus(raw_focus)
        is_lift = _is_lifting_focus(nf)
        return DaySlot(
            index=idx,
            focus=raw_focus,
            family=_focus_family(raw_focus) if is_lift else nf,
            locked=locked,
            is_lifting=is_lift,
            is_rest=(nf in _REST_FOCUSES),
        )


@dataclass
class Conflict:
    kind: Literal[
        "adjacency",
        "missing_focus",
        "no_recovery",
        "fatigue_risk",
    ]
    severity: Literal["warn", "info"]
    message: str
    affected_days: list[int] = field(default_factory=list)
    suggestion: str | None = None


@dataclass
class ChangeResult:
    mode: Literal["single", "smart"]
    conflicts: list[Conflict]
    proposed_days: list[dict]
    changed_indices: list[int]
    exercises_needed: list[int]


# ── Conflict detection ─────────────────────────────────────────────

_ADJACENCY_COLLAPSE = {
    "legs": "lower_body",
    "lower": "lower_body",
}
_EMPTY_FOCUSES = {"empty"}
_REST_FOCUSES = {"rest", ""}
_LOWER_FAMILIES = {"legs", "lower"}
_HIGH_LOWER_ARCHETYPES = {
    "lift_legs_heavy",
    "lift_lower_heavy",
    "hybrid_lower_power",
}


def _is_lifting_focus(nf: str) -> bool:
    return (
        nf not in NON_LIFTING_FOCUSES
        and nf not in _REST_FOCUSES
        and nf not in _EMPTY_FOCUSES
    )


def _collapsed_family(focus: str) -> str:
    fam = _focus_family(focus)
    return _ADJACENCY_COLLAPSE.get(fam, fam)


def _readiness_01(
    focus_readiness: dict[str, float] | None,
    family: str,
) -> float | None:
    if not focus_readiness:
        return None
    candidates = [family]
    if family == "legs":
        candidates.append("lower")
    elif family == "lower":
        candidates.append("legs")
    values: list[float] = []
    for key in candidates:
        raw = focus_readiness.get(key)
        if raw is None:
            continue
        try:
            value = float(raw)
        except (TypeError, ValueError):
            continue
        if value > 1.0:
            value /= 100.0
        values.append(max(0.0, min(1.0, value)))
    return min(values) if values else None


def _payload_family(day: dict | None) -> str:
    if not isinstance(day, dict):
        return "?"
    return _focus_family(str(day.get("focus") or ""))


def _is_high_lower_stress_payload(day: dict | None) -> bool:
    """True for lower-body days whose archetype/stimulus is heavy.

    Used when Change Focus regenerates exercises from a fresh week. The
    generated plan may contain both `lift_legs_heavy` and
    `lift_legs_volume`; blindly taking the first family match duplicates
    heavy legs when another heavy lower day already exists.
    """
    if not isinstance(day, dict):
        return False
    if _payload_family(day) not in _LOWER_FAMILIES:
        return False
    archetype = str(day.get("archetype") or "").lower().strip()
    stimulus = str(day.get("stimulus") or "").lower().strip()
    if archetype in _HIGH_LOWER_ARCHETYPES:
        return True
    if archetype.endswith("_heavy") and (
        "legs" in archetype or "lower" in archetype
    ):
        return True
    return stimulus in {"strength", "power"}


def pick_generated_lift_day_for_change(
    proposed_days: list[dict],
    generated_days: list[dict],
    used_generated_indexes: set[int],
    target_index: int,
    proposed_focus: str,
    *,
    focus_readiness: dict[str, float] | None = None,
) -> tuple[int | None, dict | None]:
    """Pick the best generated day for a Change Focus lift slot.

    Matching is family-based so "Legs", "Legs Volume", and similar
    labels can share exercise candidates. Unlike the old router loop,
    this consumes generated variants and avoids selecting another heavy
    lower-body archetype when the proposed week already has one, or when
    lower-body readiness is low.
    """
    target_family = _focus_family(proposed_focus)
    candidates = [
        (idx, day)
        for idx, day in enumerate(generated_days)
        if _payload_family(day) == target_family
    ]
    if not candidates:
        return None, None

    target_is_lower = target_family in _LOWER_FAMILIES
    existing_high_lower = False
    same_family_archetypes: set[str] = set()
    for idx, day in enumerate(proposed_days):
        if idx == target_index:
            continue
        if _payload_family(day) == target_family:
            archetype = str(day.get("archetype") or "").lower().strip()
            if archetype:
                same_family_archetypes.add(archetype)
        if _is_high_lower_stress_payload(day):
            existing_high_lower = True

    readiness = _readiness_01(focus_readiness, target_family)
    lower_readiness_low = (
        target_is_lower
        and readiness is not None
        and readiness < 0.60
    )
    has_lighter_lower_option = any(
        not _is_high_lower_stress_payload(day)
        for _, day in candidates
    )
    prefer_lighter_lower = (
        target_is_lower
        and has_lighter_lower_option
        and (existing_high_lower or lower_readiness_low)
    )

    def _score(item: tuple[int, dict]) -> tuple[int, int, int, int]:
        idx, day = item
        archetype = str(day.get("archetype") or "").lower().strip()
        return (
            1 if prefer_lighter_lower and _is_high_lower_stress_payload(day) else 0,
            1 if idx in used_generated_indexes else 0,
            1 if archetype and archetype in same_family_archetypes else 0,
            idx,
        )

    picked_idx, picked_day = min(candidates, key=_score)
    return picked_idx, picked_day


def detect_conflicts(
    week: list[DaySlot],
    changed_idx: int,
    new_focus: str,
    *,
    split: str | None = None,
    focus_readiness: dict[str, float] | None = None,
) -> list[Conflict]:
    conflicts: list[Conflict] = []
    new_fam = _collapsed_family(new_focus)
    new_nf = normalize_focus(new_focus)
    new_is_lift = _is_lifting_focus(new_nf)

    # 1. Adjacency: back-to-back same family with neighbors
    for offset in (-1, 1):
        ni = changed_idx + offset
        if 0 <= ni < len(week):
            neighbor = week[ni]
            if neighbor.is_lifting and new_is_lift:
                if _collapsed_family(neighbor.focus) == new_fam:
                    label = "previous" if offset == -1 else "next"
                    conflicts.append(Conflict(
                        kind="adjacency",
                        severity="warn",
                        message=f"Back-to-back {new_focus} with {label} day ({neighbor.focus}).",
                        affected_days=[changed_idx, ni],
                    ))

    # 1b. Upper/push/pull overlap: Upper covers all upper-body muscles
    # (chest + shoulders + triceps + back + biceps + lats), so placing it
    # next to a Push or Pull day means those muscles get hit two days in a
    # row. Push+Pull adjacency is intentional PPL design and is NOT warned.
    _UPPER_OVERLAP_PARTNERS = {"push", "pull", "chest", "back", "shoulders", "arms"}
    new_raw_fam = _focus_family(new_focus)
    if new_is_lift:
        for offset in (-1, 1):
            ni = changed_idx + offset
            if 0 <= ni < len(week):
                neighbor = week[ni]
                if not neighbor.is_lifting:
                    continue
                nbr_fam = _focus_family(neighbor.focus)
                label = "previous" if offset == -1 else "next"
                if new_raw_fam == "upper" and nbr_fam in _UPPER_OVERLAP_PARTNERS - {"upper"}:
                    conflicts.append(Conflict(
                        kind="adjacency",
                        severity="warn",
                        message=f"Upper covers push+pull muscles — back-to-back with {label} {neighbor.focus} day hits the same muscles.",
                        affected_days=[changed_idx, ni],
                    ))
                elif new_raw_fam in _UPPER_OVERLAP_PARTNERS - {"upper"} and nbr_fam == "upper":
                    conflicts.append(Conflict(
                        kind="adjacency",
                        severity="warn",
                        message=f"{new_focus} overlaps with {label} Upper day's muscles.",
                        affected_days=[changed_idx, ni],
                    ))

    # 2. Missing focus: a split-required family is absent
    if split and new_is_lift:
        cycle = _canonical_cycle_for_split(split)
        if cycle:
            present: set[str] = set()
            for s in week:
                if s.index == changed_idx:
                    if new_is_lift:
                        present.add(_focus_family(new_focus))
                elif s.is_lifting:
                    present.add(s.family)
            for needed in set(cycle):
                if needed not in present:
                    conflicts.append(Conflict(
                        kind="missing_focus",
                        severity="warn",
                        message=f"{needed.title()} training is missing from this week.",
                        suggestion="Smart adjust can redistribute to keep all muscle groups covered.",
                    ))
    elif split and not new_is_lift:
        cycle = _canonical_cycle_for_split(split)
        if cycle:
            old_slot = week[changed_idx]
            if old_slot.is_lifting:
                remaining_lift_fams = [
                    s.family for s in week
                    if s.is_lifting and s.index != changed_idx
                ]
                for needed in set(cycle):
                    if needed not in remaining_lift_fams:
                        conflicts.append(Conflict(
                            kind="missing_focus",
                            severity="warn",
                            message=f"{needed.title()} training would be removed from this week.",
                            suggestion="Smart adjust can move it to another day.",
                        ))

    # 3. No recovery: 4+ consecutive lifting days
    if new_is_lift:
        streak = 1
        for direction in (-1, 1):
            i = changed_idx + direction
            while 0 <= i < len(week):
                s = week[i]
                if i == changed_idx:
                    pass
                elif s.is_lifting:
                    streak += 1
                else:
                    break
                i += direction
        if streak >= 4:
            conflicts.append(Conflict(
                kind="no_recovery",
                severity="warn",
                message=f"{streak} consecutive lifting days with no recovery break.",
                suggestion="Consider adding a recovery or mobility day.",
            ))

    # 4. Fatigue risk
    if focus_readiness and new_is_lift:
        fam = _focus_family(new_focus)
        readiness = focus_readiness.get(fam)
        if readiness is not None and readiness < 30:
            conflicts.append(Conflict(
                kind="fatigue_risk",
                severity="warn",
                message=f"Low readiness ({readiness:.0f}%) for {new_focus}. Muscles may still be recovering.",
                affected_days=[changed_idx],
                suggestion=f"A lighter {fam.replace('_', ' ').title()} session or a different focus may be safer.",
            ))

    return conflicts


# ── Smart adjust remaining week ────────────────────────────────────

def _target_lift_distribution(
    split: str | None,
    total_lift_days: int,
) -> list[str]:
    """Return the ideal focus-family sequence for `total_lift_days`
    in the given split. Repeats the canonical cycle as needed."""
    cycle = _canonical_cycle_for_split(split)
    if not cycle:
        return ["full_body"] * total_lift_days
    out: list[str] = []
    for i in range(total_lift_days):
        out.append(cycle[i % len(cycle)])
    return out


def smart_adjust_remaining(
    week: list[DaySlot],
    changed_idx: int,
    new_focus: str,
    *,
    split: str | None = None,
    days_per_week: int = 5,
) -> list[DaySlot]:
    """Reconcile the remaining unlocked days after a type change.

    Algorithm:
    1. Lock all completed/started/locked days + days before changed_idx.
    2. Set changed_idx to the user's chosen focus.
    3. Compute target lift distribution for the split.
    4. Subtract frozen lift families from the target pool.
    5. Distribute remaining pool across free slots using adjacency-aware
       greedy placement.
    """
    result = [DaySlot(
        index=s.index, focus=s.focus, family=s.family,
        locked=s.locked, is_lifting=s.is_lifting, is_rest=s.is_rest,
    ) for s in week]

    new_nf = normalize_focus(new_focus)
    new_is_lift = _is_lifting_focus(new_nf)

    # Mark days before changed_idx as frozen (past days).
    for s in result:
        if s.index < changed_idx:
            s.locked = True

    # Apply the user's change.
    new_fam = _focus_family(new_focus) if new_is_lift else new_nf
    result[changed_idx] = DaySlot(
        index=changed_idx,
        focus=new_focus,
        family=new_fam,
        locked=True,  # user's choice is frozen
        is_lifting=new_is_lift,
        is_rest=False,
    )

    # Identify frozen and free slots.
    frozen_lift_fams: list[str] = []
    free_indices: list[int] = []
    original_recovery_count = 0

    for s in result:
        if s.locked:
            if s.is_lifting:
                frozen_lift_fams.append(s.family)
        elif not s.is_rest:
            free_indices.append(s.index)
        if not s.is_lifting and not s.is_rest:
            original_recovery_count += 1

    if not free_indices:
        return result

    # Count total lifting days in the original week.
    total_lifts_original = sum(1 for s in week if s.is_lifting)

    old_was_lift = week[changed_idx].is_lifting
    # "Empty" is a blank editable workout shell, not a request to lower
    # weekly training frequency. Keep the target lift count so smart mode
    # can move that focus to another available future day.
    lift_delta = (
        0
        if new_nf in _EMPTY_FOCUSES
        else (1 if new_is_lift else 0) - (1 if old_was_lift else 0)
    )
    total_lifts_target = total_lifts_original + lift_delta

    # Count how many lifts are already frozen.
    frozen_lift_count = len(frozen_lift_fams)
    remaining_lifts_needed = max(0, total_lifts_target - frozen_lift_count)

    # How many free slots should be lifting vs non-lifting.
    lifts_for_free = min(remaining_lifts_needed, len(free_indices))
    non_lift_free = len(free_indices) - lifts_for_free

    # Build the pool of lift families we still need.
    target_families = _target_lift_distribution(split, total_lifts_target)

    # Remove frozen families from the pool (one instance per frozen day).
    pool: list[str] = list(target_families)
    for fam in frozen_lift_fams:
        try:
            pool.remove(fam)
        except ValueError:
            pass

    # If pool is too short (frozen consumed more than expected), extend.
    cycle = _canonical_cycle_for_split(split)
    while len(pool) < lifts_for_free:
        if cycle:
            pool.append(cycle[len(pool) % len(cycle)])
        else:
            pool.append("full_body")

    # Trim pool to the number of free lifting slots.
    pool = pool[:lifts_for_free]

    # Greedy adjacency-aware placement.
    placed: list[tuple[int, str]] = []  # (index, family)
    remaining_pool = list(pool)

    for fi in free_indices:
        if not remaining_pool:
            # Fill remaining free slots with recovery/mobility.
            placed.append((fi, "recovery"))
            continue

        # Get the previous day's family for adjacency check.
        prev_fam: str | None = None
        for pi in range(fi - 1, -1, -1):
            # Check already-placed or frozen days.
            for pidx, pfam in placed:
                if pidx == pi:
                    prev_fam = _ADJACENCY_COLLAPSE.get(pfam, pfam)
                    break
            if prev_fam:
                break
            if result[pi].locked or result[pi].is_rest:
                if result[pi].is_lifting:
                    prev_fam = _ADJACENCY_COLLAPSE.get(result[pi].family, result[pi].family)
                    break
                elif not result[pi].is_rest:
                    break  # non-lift non-rest breaks adjacency chain

        # Pick the best family from the pool.
        best_idx = 0
        for j, fam in enumerate(remaining_pool):
            collapsed = _ADJACENCY_COLLAPSE.get(fam, fam)
            if prev_fam is None or collapsed != prev_fam:
                best_idx = j
                break
        else:
            best_idx = 0

        chosen_fam = remaining_pool.pop(best_idx)
        placed.append((fi, chosen_fam))

    # Apply placements to result.
    for fi, fam in placed:
        # Humanize the snake_case family for display: "full_body" → "Full Body".
        # Was `fam.title()` which leaves underscores intact and produces
        # "Full_Body" on the day card after a switch — the user-reported bug.
        focus_label = fam.replace("_", " ").title()
        if fam in ("recovery", "mobility"):
            result[fi] = DaySlot(
                index=fi,
                focus=focus_label,
                family=fam,
                locked=False,
                is_lifting=False,
            )
        else:
            result[fi] = DaySlot(
                index=fi,
                focus=focus_label,
                family=fam,
                locked=False,
                is_lifting=True,
            )

    return result


# ── Orchestrator ───────────────────────────────────────────────────

def change_day_type(
    current_days: list[dict],
    day_index: int,
    new_focus: str,
    day_statuses: list[str],
    *,
    mode: Literal["single", "smart"] = "smart",
    split: str | None = None,
    days_per_week: int = 5,
    focus_readiness: dict[str, float] | None = None,
) -> ChangeResult:
    """Main entry point for the change-day-type feature.

    Parameters
    ----------
    current_days : list[dict]
        The user's current workout week (list of day dicts with "focus", "exercises", etc.)
    day_index : int
        0-based index of the day to change.
    new_focus : str
        The new focus label (e.g. "Pull", "Recovery", "Heavy Legs").
    day_statuses : list[str]
        Status per day: "completed", "started", "pending", "locked", "skipped".
    mode : "single" | "smart"
        "single" = change this day only. "smart" = reconcile remaining week.
    split : str | None
        The user's preferred split (e.g. "ppl", "upper_lower").
    days_per_week : int
        Number of training days per week.
    focus_readiness : dict | None
        Per-focus readiness scores from fatigue system.

    Returns
    -------
    ChangeResult with proposed_days, conflicts, changed_indices, and
    exercises_needed (indices that need exercise regeneration).
    """
    if day_index < 0 or day_index >= len(current_days):
        raise ValueError(f"day_index {day_index} out of range for {len(current_days)} days")

    # Check day protection.
    status = day_statuses[day_index] if day_index < len(day_statuses) else "pending"
    if status in ("completed", "started", "locked", "skipped"):
        return ChangeResult(
            mode=mode,
            conflicts=[Conflict(
                kind="adjacency",
                severity="warn",
                message=f"This day is {status} and cannot be changed.",
                affected_days=[day_index],
            )],
            proposed_days=current_days,
            changed_indices=[],
            exercises_needed=[],
        )

    # Build week slots.
    locked_statuses = {"completed", "started", "locked", "skipped"}
    week = [
        DaySlot.from_dict(i, d, locked=(
            i < len(day_statuses) and day_statuses[i] in locked_statuses
        ))
        for i, d in enumerate(current_days)
    ]

    # Detect conflicts for the proposed change.
    conflicts = detect_conflicts(
        week, day_index, new_focus,
        split=split,
        focus_readiness=focus_readiness,
    )

    if mode == "single":
        # Change only this day. Keep everything else as-is.
        proposed = [dict(d) for d in current_days]
        proposed[day_index] = {**proposed[day_index], "focus": new_focus}
        if normalize_focus(new_focus) in _EMPTY_FOCUSES:
            proposed[day_index] = {
                **proposed[day_index],
                "focus": "Empty",
                "exercises": [],
                "stimulus": None,
            }
        return ChangeResult(
            mode="single",
            conflicts=conflicts,
            proposed_days=proposed,
            changed_indices=[day_index],
            exercises_needed=[day_index],
        )

    # Smart adjust: reconcile remaining week.
    adjusted = smart_adjust_remaining(
        week, day_index, new_focus,
        split=split,
        days_per_week=days_per_week,
    )

    # Build proposed_days from adjusted slots.
    proposed = [dict(d) for d in current_days]
    changed_indices: list[int] = []
    exercises_needed: list[int] = []

    for slot in adjusted:
        old_slot = week[slot.index]
        if slot.index == day_index or (
            not slot.locked
            and slot.index > day_index
            and slot.family != old_slot.family
        ):
            proposed[slot.index] = {
                **proposed[slot.index],
                "focus": slot.focus,
            }
            if normalize_focus(slot.focus) in _EMPTY_FOCUSES:
                proposed[slot.index] = {
                    **proposed[slot.index],
                    "focus": "Empty",
                    "exercises": [],
                    "stimulus": None,
                }
            changed_indices.append(slot.index)
            if slot.family != old_slot.family:
                exercises_needed.append(slot.index)
            elif slot.index == day_index:
                exercises_needed.append(slot.index)

    # Re-detect conflicts on the adjusted plan.
    adjusted_week = [
        DaySlot.from_dict(i, d, locked=(
            i < len(day_statuses) and day_statuses[i] in locked_statuses
        ))
        for i, d in enumerate(proposed)
    ]
    remaining_conflicts = detect_conflicts(
        adjusted_week, day_index, new_focus,
        split=split,
        focus_readiness=focus_readiness,
    )

    return ChangeResult(
        mode="smart",
        conflicts=remaining_conflicts,
        proposed_days=proposed,
        changed_indices=changed_indices,
        exercises_needed=exercises_needed,
    )
