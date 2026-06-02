"""Read-time enrichment for workout exercise dicts.

The planner runs off the in-memory SEED_EXERCISES list, so generated
day/week payloads carry only the planner's view of each exercise (name,
sets, reps, etc). Image URLs and free-exercise-db demo identifiers live
on the Exercise table and need to be patched in before the response
leaves the API — otherwise the client renders no demo card and no
exercise thumbnail.

PlanDay.workout_json is also a snapshot taken at generation time, so any
plan generated before `demo_exercise_db_id` was added has NULL demo ids
in its persisted JSON. Calling this helper at read time (inside the
plan-week endpoints) backfills those snapshots without a DB write.

Idempotent: existing non-null fields on the exercise dict are preserved.
"""

from __future__ import annotations

from typing import Iterable, Sequence

from sqlmodel import Session, select

from app.models import Exercise


def enrich_exercises_with_demo_ids(
    db: Session,
    exercise_lists: Sequence[Iterable[dict] | None],
) -> None:
    """Mutate each exercise dict in-place to add `demo_exercise_db_id`
    and `image_url` looked up from the Exercise table by name.

    `exercise_lists` is a list of lists — pass each day's
    `workout_json["exercises"]` (or the planner's `days[i]["exercises"]`)
    so the helper can do a single batched query across the whole payload.
    """
    names: set[str] = set()
    for ex_list in exercise_lists:
        if not ex_list:
            continue
        for ex in ex_list:
            if isinstance(ex, dict):
                n = ex.get("name")
                if n:
                    names.add(n)
    if not names:
        return

    try:
        rows = db.exec(
            select(Exercise.name, Exercise.demo_exercise_db_id, Exercise.image_url)
            .where(Exercise.name.in_(names))
        ).all()
    except Exception:
        # Read-time enrichment is best-effort. Never break the workout
        # response over a missing column / connection blip.
        return

    demo_map: dict[str, str] = {r[0]: r[1] for r in rows if r[1]}
    img_map: dict[str, str] = {r[0]: r[2] for r in rows if r[2]}

    for ex_list in exercise_lists:
        if not ex_list:
            continue
        for ex in ex_list:
            if not isinstance(ex, dict):
                continue
            name = ex.get("name")
            if not name:
                continue
            if not ex.get("demo_exercise_db_id") and demo_map.get(name):
                ex["demo_exercise_db_id"] = demo_map[name]
            if not ex.get("image_url") and img_map.get(name):
                ex["image_url"] = img_map[name]
