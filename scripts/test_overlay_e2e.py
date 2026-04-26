"""End-to-end smoke test for the UserCoachingOverlay system.

What this does:
  1. Picks the first user in the DB (or the one whose email matches
     --email).
  2. Snapshots the current overlay + a baseline planner output (set
     targets per muscle, archetype sequence for the week).
  3. Applies one or more overlay actions you pass on the command line.
  4. Re-runs the planner, snapshots the new output.
  5. Diffs and prints a colored before/after report so you can
     SEE that the overlay actually changed the plan.

Run inside the docker container (where DB + planner are wired):

    docker exec -it thallo-backend python -m scripts.test_overlay_e2e \\
        --email you@example.com \\
        --apply add_cardio_session \\
        --apply add_muscle_volume:quads \\
        --apply schedule_deload

  Reset the overlay row first:
    docker exec -it thallo-backend python -m scripts.test_overlay_e2e --reset --email you@example.com

  Pass --no-reset to keep the existing overlay (default behaviour
  is non-destructive — it appends).

Action shorthand:
    add_cardio_session
    add_zone2_session
    reduce_cardio
    add_muscle_volume:<muscle>
    reduce_muscle_volume:<muscle>
    hold_muscle_volume:<muscle>
    set_core_frequency:<n>
    schedule_deload
    strength_preservation
    hypertrophy_focus
    raise_protein_target
    raise_fiber_target
"""
from __future__ import annotations

import argparse
import sys
from typing import Any


# ── ANSI colors (no extra deps) ────────────────────────────────────

class C:
    R = "\033[0m"
    BOLD = "\033[1m"
    DIM = "\033[2m"
    RED = "\033[31m"
    GREEN = "\033[32m"
    YELLOW = "\033[33m"
    BLUE = "\033[34m"
    MAGENTA = "\033[35m"
    CYAN = "\033[36m"
    GRAY = "\033[90m"

    @staticmethod
    def section(label: str) -> str:
        return f"\n{C.BOLD}{C.CYAN}── {label} {'─' * max(1, 60 - len(label))}{C.R}"

    @staticmethod
    def diff(old: Any, new: Any) -> str:
        if old == new:
            return f"{C.GRAY}{old} → {new}  (unchanged){C.R}"
        if isinstance(old, (int, float)) and isinstance(new, (int, float)):
            arrow = "↑" if new > old else "↓"
            color = C.GREEN if new > old else C.RED
            return f"{C.GRAY}{old}{C.R} {color}{arrow} {new}{C.R}"
        return f"{C.GRAY}{old}{C.R} {C.YELLOW}→{C.R} {C.BOLD}{new}{C.R}"


# ── Action parsing ────────────────────────────────────────────────

def _parse_action(spec: str) -> dict:
    """Turn 'add_muscle_volume:quads' into a payload dict."""
    if ":" in spec:
        atype, arg = spec.split(":", 1)
    else:
        atype, arg = spec, None
    payload: dict = {}
    if atype in ("add_muscle_volume", "reduce_muscle_volume", "hold_muscle_volume"):
        if not arg:
            raise SystemExit(f"action {atype} requires :<muscle>, e.g. {atype}:quads")
        payload["muscle"] = arg
    elif atype == "set_core_frequency":
        if not arg:
            raise SystemExit(f"action {atype} requires :<sessions_per_week>")
        payload["sessions_per_week"] = int(arg)
    return {"type": atype, **payload}


# ── Snapshots ─────────────────────────────────────────────────────

def _snapshot_overlay(db, uid):
    from app.services.coach.overlay import snapshot_for_planner
    return snapshot_for_planner(db, uid, run_decay=False)


def _snapshot_planner(db, uid, snapshot_overlay: dict | None) -> dict:
    """Run the deterministic planner with the overlay applied and
    return the bits we want to diff."""
    from sqlmodel import select
    from app.models import (
        UserProfile as UPModel, UserGoal, UserPreferences,
    )
    from app.services.workout.planner import (
        PlannerInputs, weekly_set_targets,
    )

    profile = db.exec(select(UPModel).where(UPModel.user_id == uid)).first()
    goal = db.exec(select(UserGoal).where(UserGoal.user_id == uid)).first()
    prefs = db.exec(select(UserPreferences).where(UserPreferences.user_id == uid)).first()

    goal_type = (goal.goal_type.value if goal else "muscle_gain") if goal else "muscle_gain"
    days = prefs.days_per_week if prefs else 4

    inputs = PlannerInputs(
        goal=goal_type,
        days_per_week=days,
        session_minutes=60,
        experience="intermediate",
        rng_seed=uid,
        coaching_overlay=snapshot_overlay,
    )
    targets = weekly_set_targets(inputs)

    # We don't run the full plan recipe here (too many side-effects on
    # disk for an e2e probe). The set targets are the truest signal —
    # if those don't change with the overlay, NOTHING downstream will.
    return {
        "goal": goal_type,
        "days_per_week": days,
        "weekly_set_targets": targets,
    }


# ── Diff printer ──────────────────────────────────────────────────

def _print_overlay(label: str, snap: dict) -> None:
    print(C.section(label))
    if not snap or all(snap.get(k) in (None, {}, 0) for k in (
        "muscle_volume_bias", "cardio_minutes_target", "zone2_minutes_target",
        "core_sessions_target", "intensity_bias", "deload_active",
        "nutrition_adjustments",
    )):
        print(f"  {C.DIM}(empty — neutral baseline){C.R}")
        return
    print(f"  cardio_minutes_target  : {snap.get('cardio_minutes_target')}")
    print(f"  zone2_minutes_target   : {snap.get('zone2_minutes_target')}")
    print(f"  core_sessions_target   : {snap.get('core_sessions_target')}")
    print(f"  intensity_bias         : {snap.get('intensity_bias')}")
    print(f"  deload_active          : {snap.get('deload_active')}")
    if snap.get('deload_until_date'):
        print(f"  deload_until_date      : {snap.get('deload_until_date')}")
    bias = snap.get("muscle_volume_bias") or {}
    if bias:
        print(f"  muscle_volume_bias     :")
        for muscle, val in sorted(bias.items()):
            arrow = "▲" if val > 1.0 else "▼"
            color = C.GREEN if val > 1.0 else C.RED
            print(f"      {muscle:12} {color}{arrow} {val:.2f}{C.R}")
    nut = snap.get("nutrition_adjustments") or {}
    if nut:
        print(f"  nutrition_adjustments  : {nut}")


def _print_planner_diff(before: dict, after: dict) -> None:
    print(C.section("PLANNER OUTPUT (weekly set targets)"))
    b = before.get("weekly_set_targets") or {}
    a = after.get("weekly_set_targets") or {}
    all_muscles = sorted(set(b.keys()) | set(a.keys()))
    any_changed = False
    for m in all_muscles:
        bv = b.get(m, 0)
        av = a.get(m, 0)
        line = f"  {m:14} {C.diff(bv, av)}"
        if bv != av:
            any_changed = True
        print(line)
    if not any_changed:
        print(f"\n  {C.YELLOW}⚠  No planner change — overlay had no effect.{C.R}")
        print(f"  {C.DIM}Possible causes:{C.R}")
        print(f"  {C.DIM}  - Action targets a dimension your goal/split doesn't expose{C.R}")
        print(f"  {C.DIM}  - Bias was already at the cap{C.R}")
        print(f"  {C.DIM}  - Bro split (cardio overlay is structurally skipped){C.R}")
    else:
        print(f"\n  {C.GREEN}{C.BOLD}✓ Overlay reached the planner.{C.R}")


# ── Main ──────────────────────────────────────────────────────────

def main() -> int:
    parser = argparse.ArgumentParser(description="Coaching-overlay e2e smoke test.")
    parser.add_argument("--email", help="User email (default: first user in DB)")
    parser.add_argument("--apply", action="append", default=[],
                        help="Action to apply (repeatable). Format: 'add_cardio_session' or 'add_muscle_volume:quads'")
    parser.add_argument("--reset", action="store_true",
                        help="Wipe the user's existing overlay row before applying")
    args = parser.parse_args()

    from sqlmodel import Session, select
    from app.database import engine
    from app.models import User, UserCoachingOverlay
    from app.services.coach.overlay import apply_overlay_action

    with Session(engine) as db:
        if args.email:
            user = db.exec(select(User).where(User.email == args.email)).first()
            if not user:
                print(f"{C.RED}No user with email {args.email}{C.R}")
                return 1
        else:
            user = db.exec(select(User)).first()
            if not user:
                print(f"{C.RED}No users in DB. Sign up first.{C.R}")
                return 1
        uid = user.id

        print(f"\n{C.BOLD}user_id={uid} email={user.email}{C.R}")

        if args.reset:
            existing = db.exec(
                select(UserCoachingOverlay).where(UserCoachingOverlay.user_id == uid)
            ).first()
            if existing:
                db.delete(existing); db.commit()
                print(f"{C.MAGENTA}↻ wiped existing overlay row{C.R}")

        # ── Baseline ──────────────────────────────────────────────
        before_overlay = _snapshot_overlay(db, uid)
        before_plan = _snapshot_planner(db, uid, before_overlay)
        _print_overlay("OVERLAY BEFORE", before_overlay)

        # ── Apply requested actions ───────────────────────────────
        if not args.apply:
            print(f"\n{C.YELLOW}No actions to apply (use --apply add_cardio_session). Showing snapshot only.{C.R}")
            return 0

        print(C.section("APPLYING ACTIONS"))
        for spec in args.apply:
            action = _parse_action(spec)
            res = apply_overlay_action(db, uid, action["type"], action, rec_key=f"e2e:{spec}")
            if res is None:
                print(f"  {C.RED}✗ {spec}{C.R}  → not handled by overlay (legacy action — use apply_action.py path)")
                continue
            tag = (f"{C.GREEN}✓{C.R}" if res.applied and res.needs_regen
                   else f"{C.YELLOW}~{C.R}" if res.applied
                   else f"{C.RED}✗{C.R}")
            print(f"  {tag} {spec:30}  {res.summary}")

        # ── After ─────────────────────────────────────────────────
        after_overlay = _snapshot_overlay(db, uid)
        after_plan = _snapshot_planner(db, uid, after_overlay)
        _print_overlay("OVERLAY AFTER", after_overlay)
        _print_planner_diff(before_plan, after_plan)

        print(f"\n{C.DIM}Tip: re-run with --reset to clear and try a different combination.{C.R}\n")

    return 0


if __name__ == "__main__":
    sys.exit(main())
