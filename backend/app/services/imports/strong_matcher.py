"""Strong exercise-name → Thallo Exercise matcher.

Same token-set strategy as `mfp_matcher` (exact → alias → containment
→ Jaccard). Lives in its own module so the pipeline can swap in
different match strategies per source without touching the parser.

Returns a `MatchedExercise` with the Thallo `exercise_id` when matched,
or None when no high-confidence match exists — the pipeline imports
the row with a raw name and `exercise_id=None` so it still feeds
fatigue + history correctly.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Iterable

from sqlmodel import Session, select

from app.models import Exercise


_PUNCT_RE = re.compile(r"[^a-z0-9 ]")
_WS_RE = re.compile(r"\s+")
_STOP_TOKENS = frozenset({
    "the", "a", "an", "of", "with", "and", "or",
    "barbell", "dumbbell", "machine", "cable",  # equipment qualifiers
                                                # are useful tokens but
                                                # often duplicated across
                                                # candidate names — leave
                                                # them in. Tighten later
                                                # if false-positive rate
                                                # is high.
})
# Keep equipment qualifiers IN the token set — Strong users care
# whether they did "Barbell Bench" vs "Dumbbell Bench". Override the
# definition above to be empty for now.
_STOP_TOKENS = frozenset({"the", "a", "an", "of", "with", "and", "or"})


def _normalize(s: str) -> str:
    s = s.lower()
    s = _PUNCT_RE.sub(" ", s)
    s = _WS_RE.sub(" ", s).strip()
    return s


def _tokens(s: str) -> set[str]:
    return {
        t for t in _normalize(s).split(" ")
        if t and len(t) > 1 and t not in _STOP_TOKENS
    }


@dataclass(frozen=True)
class _ExerciseCandidate:
    exercise_id: int
    name: str
    aliases: tuple[str, ...] = ()
    primary_muscle: str | None = None


@dataclass(frozen=True)
class MatchedExercise:
    exercise_id: int | None
    name: str                # canonical or original
    confidence: str          # "exact" | "alias" | "fuzzy" | "fallback"


def match_exercise_in_list(
    raw_name: str,
    candidates: Iterable[_ExerciseCandidate],
) -> MatchedExercise:
    if not raw_name:
        return MatchedExercise(None, raw_name, "fallback")
    norm = _normalize(raw_name)
    if not norm:
        return MatchedExercise(None, raw_name, "fallback")

    candidate_list = list(candidates)
    if not candidate_list:
        return MatchedExercise(None, raw_name, "fallback")

    # 1) Exact normalized name match.
    for c in candidate_list:
        if _normalize(c.name) == norm:
            return MatchedExercise(c.exercise_id, c.name, "exact")

    # 2) Alias match.
    for c in candidate_list:
        for alias in c.aliases:
            if _normalize(alias) == norm:
                return MatchedExercise(c.exercise_id, c.name, "alias")

    seed_toks = _tokens(raw_name)
    if not seed_toks:
        return MatchedExercise(None, raw_name, "fallback")

    # 3) Containment seed ⊆ db (most-specific seed in a verbose db name).
    best_sub: tuple[int, _ExerciseCandidate | None] = (10**6, None)
    for c in candidate_list:
        db_toks = _tokens(c.name)
        if not db_toks:
            continue
        if seed_toks.issubset(db_toks):
            extras = len(db_toks) - len(seed_toks)
            if extras < best_sub[0]:
                best_sub = (extras, c)
    if best_sub[1] and (len(seed_toks) >= 2 or best_sub[0] == 0):
        return MatchedExercise(best_sub[1].exercise_id, best_sub[1].name, "fuzzy")

    # 4) Reverse containment db ⊆ seed (verbose Strong name → canonical).
    best_super: tuple[int, _ExerciseCandidate | None] = (10**6, None)
    for c in candidate_list:
        db_toks = _tokens(c.name)
        if db_toks and db_toks.issubset(seed_toks):
            extras = len(seed_toks) - len(db_toks)
            if extras < best_super[0]:
                best_super = (extras, c)
    if best_super[1] and best_super[0] <= 2:
        return MatchedExercise(best_super[1].exercise_id, best_super[1].name, "fuzzy")

    # 5) Jaccard fallback.
    best_jacc: tuple[float, _ExerciseCandidate | None] = (0.0, None)
    for c in candidate_list:
        db_toks = _tokens(c.name)
        union = len(seed_toks | db_toks)
        if not union:
            continue
        score = len(seed_toks & db_toks) / union
        if score > best_jacc[0]:
            best_jacc = (score, c)
    if best_jacc[0] >= 0.70:
        return MatchedExercise(best_jacc[1].exercise_id, best_jacc[1].name, "fuzzy")

    return MatchedExercise(None, raw_name, "fallback")


def exercise_candidates_from_db(session: Session) -> list[_ExerciseCandidate]:
    """All seed exercises (Exercise.is_custom = False). Custom user
    exercises aren't in the matcher pool for the same cross-user
    leak reason as foods."""
    rows = session.exec(
        select(Exercise).where(Exercise.is_custom.is_(False))
    ).all()
    return [
        _ExerciseCandidate(
            exercise_id=e.id,
            name=e.name,
            primary_muscle=e.primary_muscle,
        )
        for e in rows
        if e.id is not None
    ]
