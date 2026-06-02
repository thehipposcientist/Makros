"""Fine-grained muscle-emphasis tracking helpers.

The deterministic planner and fatigue model still operate on broad
muscle buckets. These helpers power analytics-only rollups for regions
like lats, traps, front delts, rear delts, and upper chest.
"""
from __future__ import annotations

from typing import Iterable, Any

from app.services.workout.emphasis_inference import EMPHASIS_TAGS, infer_emphasis


def normalize_emphasis_tags(value: Any) -> list[str]:
    """Return canonical emphasis tags from stored JSON-ish data."""
    if not value:
        return []
    raw_items = value if isinstance(value, list) else [value]
    out: list[str] = []
    for raw in raw_items:
        tag = str(raw or "").strip().lower().replace(" ", "_").replace("-", "_")
        if tag in EMPHASIS_TAGS and tag not in out:
            out.append(tag)
    return out


def detail_tags_for_exercise(
    *,
    name: str | None,
    primary_muscle: str | None,
    secondary_muscles: Iterable[str] | None = None,
    stored_emphasis: Any = None,
) -> list[str]:
    """Resolve detail tags for a logged exercise.

    Prefer seed-time `Exercise.emphasis`; infer from name + muscle
    snapshots for legacy/custom rows that lack a canonical exercise join.
    """
    stored = normalize_emphasis_tags(stored_emphasis)
    if stored:
        return stored
    return normalize_emphasis_tags(
        infer_emphasis(name or "", primary_muscle or "", secondary_muscles or [])
    )
