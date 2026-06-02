"""MyFitnessPal food-name matcher.

Maps `ParsedMealRow.food_name` → Thallo `Food` row (when possible) +
final macro values. Falls back to parsed macros + no-food-link when no
high-confidence match exists — the meal still imports, it just won't
appear in food autosuggest under the canonical Thallo name.

Matching strategy (priority order, first hit wins):
  1. Exact normalized-name match in `foods` table.
  2. `food_aliases` table lookup (handles "OJ" → "orange juice").
  3. Token-set containment match (seed ⊆ db, preferring fewest extras).
  4. Reverse containment (db ⊆ seed) for verbose MFP entries like
     "Eggland's Best - Large Eggs, 2 large" → "Egg" in our seed.
  5. Jaccard fallback at ≥0.70 — last-ditch fuzzy match.

USDA Food Data Central + AI classification are wired as optional
hooks (`usda_lookup_fn`, `ai_classify_fn`). When absent, unmatched
rows return a `fallback` confidence and the pipeline imports the
parsed macros without a Food link.

Pure-function for the matching logic itself — `match_food_in_list()`
operates on a pre-loaded list of `Food` candidates and is fully
testable without a DB.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Callable, Iterable

from sqlmodel import Session, select

from app.models import Food, FoodAlias
from .mfp_parser import ParsedMealRow


# ─── Result types ────────────────────────────────────────────────────────────

# Matching confidence — informs the import-status UI ("X matched, Y AI-classified, Z fallback").
ConfidenceLevel = str  # "exact" | "alias" | "fuzzy" | "usda" | "ai" | "fallback"


@dataclass(frozen=True)
class MatchResult:
    food_id: int | None         # null when no Food link could be made
    food_name: str              # final name to store on MealItem.food_name
    confidence: ConfidenceLevel
    calories: float | None
    protein_g: float | None
    carbs_g: float | None
    fat_g: float | None
    # Free-form provenance note — used in error/review surfaces only.
    note: str | None = None


# Optional external lookup hooks. Signatures intentionally narrow so
# the existing usda_fdc / ai_classify services can adapt without
# changing their core APIs.
UsdaLookupFn = Callable[[str], MatchResult | None]
AiClassifyFn = Callable[[str, ParsedMealRow], MatchResult | None]


# ─── Tokenization (mirrors demo_resolver style) ──────────────────────────────

_PUNCT_RE = re.compile(r"[^a-z0-9 ]")
_WS_RE = re.compile(r"\s+")


def _normalize(s: str) -> str:
    s = s.lower()
    s = _PUNCT_RE.sub(" ", s)
    s = _WS_RE.sub(" ", s).strip()
    return s


# Tokens we consider too generic to drive a match on their own.
# Without this filter, "rice" hits "brown rice cake," "rice noodles,"
# etc. ambiguously. Keeping a small list — over-aggressive filtering
# kills recall faster than it kills precision.
_STOP_TOKENS = frozenset({
    "the", "a", "an", "of", "with", "and", "or", "in",
    "low", "no", "fat", "free", "less", "lite", "light",  # diet adjectives
    "raw", "cooked", "fresh", "frozen", "dried",          # prep adjectives
    "large", "medium", "small", "extra",                  # size adjectives
})


def _tokens(s: str) -> set[str]:
    # 1-char tokens are junk left over from punctuation strip
    # ("Eggland's" → "eggland s" — the dangling "s" is noise).
    return {
        t for t in _normalize(s).split(" ")
        if t and len(t) > 1 and t not in _STOP_TOKENS
    }


# ─── Pure matcher (no DB) ────────────────────────────────────────────────────

@dataclass(frozen=True)
class _Candidate:
    """Minimal projection of a Food row for matching. Pulled from the
    full Food via `_food_candidates_from_db`, but the matching logic
    itself only sees these slim objects so it stays testable in isolation."""
    food_id: int
    name: str
    aliases: tuple[str, ...] = ()


def match_food_in_list(
    food_name: str,
    candidates: Iterable[_Candidate],
) -> tuple[_Candidate | None, ConfidenceLevel]:
    """Score `food_name` against the candidate list. Returns the best
    match + confidence label, or (None, "none") when nothing clears
    the threshold."""
    if not food_name:
        return None, "none"
    norm = _normalize(food_name)
    if not norm:
        return None, "none"

    # Pre-build the candidate index once. Allocations here are the
    # whole cost — the rest is set ops.
    candidate_list = list(candidates)
    if not candidate_list:
        return None, "none"

    # 1) Exact name match.
    for c in candidate_list:
        if _normalize(c.name) == norm:
            return c, "exact"

    # 2) Alias match.
    for c in candidate_list:
        for alias in c.aliases:
            if _normalize(alias) == norm:
                return c, "alias"

    seed_toks = _tokens(food_name)
    if not seed_toks:
        return None, "none"

    # 3) Containment: seed_toks ⊆ db_toks. Prefer the candidate with
    #    the fewest extra tokens (most specific). Require ≥2 seed
    #    tokens to avoid "Apple" matching "Apple Pie."
    best_sub: tuple[int, _Candidate | None] = (10**6, None)
    for c in candidate_list:
        db_toks = _tokens(c.name)
        if not db_toks:
            continue
        if seed_toks.issubset(db_toks):
            extras = len(db_toks) - len(seed_toks)
            if extras < best_sub[0]:
                best_sub = (extras, c)
    if best_sub[1] and (len(seed_toks) >= 2 or best_sub[0] == 0):
        return best_sub[1], "fuzzy"

    # 4) Reverse containment: db_toks ⊆ seed_toks. Picks up cases
    #    where the MFP entry is more verbose than our canonical name
    #    (e.g. "Eggland's Best Large Egg" → "Egg" in seed). Capping
    #    extras at 2 keeps the match honest — "Apple Pie" still loses
    #    information mapping to "Apple", but the user can override in
    #    the review modal and the macros still come from MFP either way.
    best_super: tuple[int, _Candidate | None] = (10**6, None)
    for c in candidate_list:
        db_toks = _tokens(c.name)
        if db_toks and db_toks.issubset(seed_toks):
            extras = len(seed_toks) - len(db_toks)
            if extras < best_super[0]:
                best_super = (extras, c)
    if best_super[1] and best_super[0] <= 2:
        return best_super[1], "fuzzy"

    # 5) Jaccard fallback. High threshold — false positives are worse
    #    than missed matches (the pipeline gracefully falls back to
    #    "imported with parsed macros, no food link").
    best_jacc: tuple[float, _Candidate | None] = (0.0, None)
    for c in candidate_list:
        db_toks = _tokens(c.name)
        union = len(seed_toks | db_toks)
        if not union:
            continue
        score = len(seed_toks & db_toks) / union
        if score > best_jacc[0]:
            best_jacc = (score, c)
    if best_jacc[0] >= 0.70:
        return best_jacc[1], "fuzzy"

    return None, "none"


# ─── DB-backed matcher entry point ───────────────────────────────────────────

# Module-level candidate cache. The Food table is mostly static during
# an import session (~10k rows in seed + user customs); rebuilding the
# in-memory list per row would dominate the matcher cost. We just
# rebuild once per pipeline run.
def _food_candidates_from_db(session: Session, user_id: int) -> list[_Candidate]:
    """Pull the matchable Food set: seed foods + this user's custom foods.

    We deliberately do NOT include other users' custom foods — they'd
    leak cross-user food names into the matcher and produce confusing
    UX ("matched to 'Bob's homemade chili' — what?")."""
    # Foods are either seeded (owner_user_id NULL) or user-owned. We
    # match against both — global seed first since it's larger.
    rows = session.exec(
        select(Food).where(
            (Food.owner_user_id.is_(None)) | (Food.owner_user_id == user_id)
        ).where(Food.is_active.is_(True))
    ).all()
    # Pull aliases once and group.
    alias_rows = session.exec(select(FoodAlias)).all()
    aliases_by_food: dict[int, list[str]] = {}
    for ar in alias_rows:
        aliases_by_food.setdefault(ar.food_id, []).append(ar.alias)
    return [
        _Candidate(
            food_id=f.id,
            name=f.name,
            aliases=tuple(aliases_by_food.get(f.id, [])),
        )
        for f in rows
        if f.id is not None
    ]


def match_mfp_row(
    row: ParsedMealRow,
    session: Session,
    user_id: int,
    *,
    candidates: list[_Candidate] | None = None,
    usda_lookup_fn: UsdaLookupFn | None = None,
    ai_classify_fn: AiClassifyFn | None = None,
) -> MatchResult:
    """Match one parsed MFP row to a Thallo Food (or fall back).

    The pipeline orchestrator should preload `candidates` once with
    `_food_candidates_from_db()` and pass it in per-row so we don't
    pay the DB round-trip 1,300 times for a typical export.

    `usda_lookup_fn` and `ai_classify_fn` are optional escape hatches
    for when the local set doesn't contain the food. Bulk imports should
    keep these bounded because external normalization can be slow/costly.
    When absent, unmatched rows return `confidence='fallback'` with the
    parsed macros intact.
    """
    cands = candidates if candidates is not None else _food_candidates_from_db(session, user_id)
    match, confidence = match_food_in_list(row.food_name, cands)

    if match is not None:
        return MatchResult(
            food_id=match.food_id,
            food_name=match.name,
            confidence=confidence,
            calories=row.calories,
            protein_g=row.protein_g,
            carbs_g=row.carbs_g,
            fat_g=row.fat_g,
        )

    # USDA hook — looks up the food by name and (if found) returns a
    # MatchResult with USDA macros. The hook is responsible for any
    # network IO + caching; matcher stays pure.
    if usda_lookup_fn is not None:
        usda = usda_lookup_fn(row.food_name)
        if usda is not None:
            return usda

    # AI hook — gpt-4o-mini classification. Slow + costs money; the
    # pipeline can elect to skip when running large bulk imports.
    if ai_classify_fn is not None:
        ai = ai_classify_fn(row.food_name, row)
        if ai is not None:
            return ai

    # Fallback: import with parsed macros + no Food link. Imported
    # meals still count toward daily totals + nutrition score; they
    # just won't show up in food autosuggest under a canonical name.
    return MatchResult(
        food_id=None,
        food_name=row.food_name,
        confidence="fallback",
        calories=row.calories,
        protein_g=row.protein_g,
        carbs_g=row.carbs_g,
        fat_g=row.fat_g,
        note="no Thallo Food match; imported with parsed macros",
    )
