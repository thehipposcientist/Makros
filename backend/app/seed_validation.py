"""
Seed food validator — warns on classes of problem that used to slip
through the old `_validate_macros` check.

Called from `seed_foods()` before the insert loop. Every issue is
logged (`[seed-validation] ...`) and counted. By design the function
returns rather than raises — shipping with warnings is preferable to
blocking startup on borderline data during active development — but
the caller can inspect the returned `ValidationReport` and decide
whether to treat anything as fatal.

Checks:
  1. duplicate canonical names (exact or normalized)
  2. duplicate aliases across foods
  3. suspiciously broad aliases (single short tokens, common words)
  4. missing default servings
  5. duplicate serving labels within a food
  6. zero or negative grams
  7. calorie / macro mismatch beyond 15%
  8. category / name inconsistency (heuristic — e.g. "oil" not in FATS_OILS)
  9. missing prep_state on meats/grains where state materially changes macros

Everything is a warning. Severity is just a label on the log line —
nothing filters on it yet. Treat this as "make problems visible",
not "block the build".
"""
from __future__ import annotations

from dataclasses import dataclass, field

from app.enums import FoodCategory


# Aliases that are almost always too broad to be safe. If a seed entry
# uses one of these as an alias, it will hijack search for every other
# food of that general type. Warn loudly.
#
# NOTE: canonical-name exceptions (e.g. "pasta" ON "Pasta (Cooked)") are
# allowed via the token-containment check in `_is_alias_broad` below.
_BANNED_BROAD_ALIASES: set[str] = {
    "rice", "bread", "milk", "yogurt", "chocolate", "cheese",
    "oil", "butter", "sauce", "juice", "sugar", "salt", "water", "tea",
    "fruit", "vegetable", "meat",
}

# Minimum significant-token length. A single-word alias shorter than this
# is almost certainly too generic. The `_is_alias_broad` check whitelists
# aliases that are a token of the canonical name so "kale" on "Kale" or
# "oats" on "Oats (Dry)" don't trip this.
_MIN_ALIAS_WORD_LEN = 5


def _alias_tokens(name: str) -> set[str]:
    """Extract lowercased word tokens from a name, ignoring punctuation."""
    return {
        w.strip("()").lower()
        for w in name.replace("(", " ").replace(")", " ").split()
        if w.strip("()")
    }


def _head_name_tokens(name: str) -> set[str]:
    """Tokens from the part of the name BEFORE the first parenthesis.

    Used for category-hint checks so qualifiers like "(canned in oil)"
    on `Sardines` don't mistakenly mark the food as fats-oils.
    """
    head = name.split("(", 1)[0]
    return _alias_tokens(head)


def _singular(word: str) -> str:
    """Very crude singularizer — good enough to keep 'egg' matching 'Eggs'."""
    if len(word) > 3 and word.endswith("s") and not word.endswith("ss"):
        return word[:-1]
    return word


def _is_alias_broad(alias: str, canonical_name: str) -> tuple[bool, str]:
    """Return (is_broad, reason) for a single alias.

    An alias is considered "broad" only when:
      * it's in the banned list AND is not a (singular-normalized)
        token of the canonical name
    OR
      * it's a single word shorter than `_MIN_ALIAS_WORD_LEN` AND
      * it doesn't match a canonical-name token (singular or plural) AND
      * it isn't on the short-but-specific whitelist below.
    """
    lower = alias.lower().strip()
    canonical_tokens = _alias_tokens(canonical_name)
    canonical_singulars = {_singular(t) for t in canonical_tokens}

    def _matches_canonical(w: str) -> bool:
        return (
            w in canonical_tokens
            or _singular(w) in canonical_singulars
            or w in canonical_singulars
        )

    if lower in _BANNED_BROAD_ALIASES:
        if _matches_canonical(lower):
            return (False, "")
        return (True, f"banned broad alias '{alias}'")

    words = lower.split()
    if len(words) == 1:
        w = words[0]
        short_whitelist = {"pb", "oj", "evoo"}
        if w in short_whitelist:
            return (False, "")
        if _matches_canonical(w):
            return (False, "")
        if len(w) < _MIN_ALIAS_WORD_LEN:
            return (True, f"suspiciously short single-word alias '{alias}'")

    return (False, "")


def _normalize(s: str) -> str:
    return " ".join(s.lower().strip().split())


@dataclass
class ValidationReport:
    """Structured summary of validator output. `warnings` is the full
    list of human-readable messages so a test can assert against the
    number or the content."""
    warnings: list[str] = field(default_factory=list)
    duplicate_names: int = 0
    duplicate_aliases: int = 0
    broad_aliases: int = 0
    missing_default_serving: int = 0
    duplicate_serving_labels: int = 0
    invalid_grams: int = 0
    macro_mismatch: int = 0
    category_mismatch: int = 0
    missing_prep_state: int = 0

    def warn(self, msg: str) -> None:
        print(f"[seed-validation] {msg}")
        self.warnings.append(msg)

    def total(self) -> int:
        return len(self.warnings)


# Keyword hints for the category-consistency check. Matched against
# name TOKENS (whole words), not substrings, so "oil" in "Olive Oil"
# counts but "oil" doesn't erroneously match "Boiled" or "Sardines in
# Oil". Hints are PRIMARY-role — a food can be in a category without
# any of these words, but if its name contains a hint word for a
# *different* category, that's a flag.
_CATEGORY_NAME_HINTS: dict[FoodCategory, set[str]] = {
    FoodCategory.FATS_OILS: {"oil", "nuts", "seeds"},
    FoodCategory.BEVERAGES: {"juice", "coffee", "tea", "soda"},
    FoodCategory.CONDIMENTS: {"sauce", "salsa", "ketchup", "mustard", "dressing", "mayo"},
    FoodCategory.DAIRY:     {"milk", "yogurt", "cheese", "cream"},
}

# Foods whose macros depend materially on preparation state. Keyed by
# name-token — we only warn when the food's name contains one of these
# tokens AND it has no `prep_state` AND no prep hint in the name itself.
# Scoped to foods where raw/cooked differ by >10% to avoid noise.
_PREP_STATE_NAME_TRIGGERS = {
    "chicken", "beef", "steak", "turkey", "pork", "lamb", "bacon",
    "fish", "salmon", "tuna", "cod", "tilapia", "shrimp", "sausage",
    "rice", "pasta", "oats", "quinoa", "lentils", "beans",
}

# Name fragments that already signal prep state without the metadata.
_NAME_STATE_HINTS = ("cooked", "dry", "raw", "canned", "packaged", "processed")


def validate_seed(entries: list[dict]) -> ValidationReport:
    """Run all checks over the seed list. Returns a ValidationReport
    with every issue logged."""
    report = ValidationReport()

    # ── 1. duplicate canonical names ─────────────────────────────────────
    seen_norms: dict[str, str] = {}
    for e in entries:
        name = e.get("name", "")
        norm = _normalize(name)
        if norm in seen_norms:
            report.duplicate_names += 1
            report.warn(f"duplicate canonical name: '{name}' (also '{seen_norms[norm]}')")
        else:
            seen_norms[norm] = name

    # ── 2. alias uniqueness across foods ─────────────────────────────────
    alias_owner: dict[str, str] = {}
    for e in entries:
        owner = e.get("name", "?")
        for alias in e.get("aliases", []) or []:
            key = _normalize(alias)
            if not key:
                continue
            if key in alias_owner and alias_owner[key] != owner:
                report.duplicate_aliases += 1
                report.warn(
                    f"alias '{alias}' claimed by both '{alias_owner[key]}' and '{owner}'"
                )
            else:
                alias_owner[key] = owner

    # ── 3. broad / generic aliases ───────────────────────────────────────
    for e in entries:
        name = e.get("name", "?")
        for alias in e.get("aliases", []) or []:
            is_broad, reason = _is_alias_broad(alias, name)
            if is_broad:
                report.broad_aliases += 1
                report.warn(f"'{name}' has {reason}")

    # ── 4. servings structure ────────────────────────────────────────────
    for e in entries:
        name = e.get("name", "?")
        servings = e.get("servings") or []
        if not servings:
            report.missing_default_serving += 1
            report.warn(f"'{name}' has no servings at all")
            continue
        if not any(s.get("is_default") for s in servings):
            report.missing_default_serving += 1
            report.warn(f"'{name}' has no is_default=True serving (first one will be used)")
        seen_labels: set[str] = set()
        for s in servings:
            label = s.get("label", "").strip()
            if not label:
                report.warn(f"'{name}' has a serving with empty label")
            elif label in seen_labels:
                report.duplicate_serving_labels += 1
                report.warn(f"'{name}' has duplicate serving label '{label}'")
            else:
                seen_labels.add(label)
            grams = s.get("grams")
            if not isinstance(grams, (int, float)) or grams <= 0:
                report.invalid_grams += 1
                report.warn(f"'{name}' serving '{label}' has invalid grams={grams!r}")

    # ── 5. macro / calorie consistency (Atwater + fiber correction) ──────
    # Proper Atwater factors: protein 4, carb 4, fat 9, fiber 2 (not 4).
    # Many USDA vegetable entries look "off" by 15-20% under the naive
    # 4+4+9 formula because their carb count is dominated by fiber. The
    # corrected formula brings them back into tolerance.
    # We also skip very-low-calorie foods (<10 cal/100g) where absolute
    # integer rounding dominates the percentage error.
    for e in entries:
        n = e.get("nutrition") or {}
        cal = n.get("calories", 0)
        if cal < 10:
            continue
        fiber = n.get("fiber") or 0
        carbs = n.get("carbs", 0)
        digestible_carbs = max(carbs - fiber, 0)
        expected = (
            n.get("protein", 0) * 4
            + digestible_carbs * 4
            + fiber * 2
            + n.get("fat", 0) * 9
        )
        if expected == 0:
            continue
        diff_pct = abs(cal - expected) / expected * 100
        if diff_pct > 15:
            report.macro_mismatch += 1
            report.warn(
                f"'{e.get('name')}' macro mismatch: stated {cal} cal vs "
                f"Atwater-computed {expected:.0f} cal ({diff_pct:.0f}% off)"
            )

    # ── 6. category/name sanity ──────────────────────────────────────────
    # Check only the HEAD of the name (before any parenthetical). Avoids
    # false positives like `Sardines (canned in oil)` triggering FATS_OILS.
    for e in entries:
        head_tokens = _head_name_tokens(e.get("name", ""))
        cat = e.get("category")
        own_hints = _CATEGORY_NAME_HINTS.get(cat, set())
        if head_tokens & own_hints:
            continue
        for other_cat, other_hints in _CATEGORY_NAME_HINTS.items():
            if other_cat == cat:
                continue
            if head_tokens & other_hints:
                report.category_mismatch += 1
                report.warn(
                    f"'{e.get('name')}' is in {cat.name} but name token hints at {other_cat.name}"
                )
                break

    # ── 7. prep-state requirement (keyword-triggered, category-scoped) ───
    # Only trigger for proteins/plant-proteins/grains — packaged and
    # vegetable items don't need the same vigilance.
    _prep_scoped_cats = {
        FoodCategory.PROTEINS, FoodCategory.PLANT_PROTEINS, FoodCategory.GRAINS_CARBS,
    }
    for e in entries:
        if e.get("category") not in _prep_scoped_cats:
            continue
        if e.get("is_packaged"):
            continue
        name = e.get("name", "")
        name_lower = name.lower()
        name_tokens = _alias_tokens(name)
        if not (name_tokens & _PREP_STATE_NAME_TRIGGERS):
            continue
        has_prep = "prep_state" in e
        has_name_hint = any(h in name_lower for h in _NAME_STATE_HINTS)
        if not has_prep and not has_name_hint:
            report.missing_prep_state += 1
            report.warn(
                f"'{name}' contains a state-sensitive keyword but has no "
                f"prep_state and no prep-state hint in the name"
            )

    # Summary line so logs always have a headline number.
    if report.total() == 0:
        print("[seed-validation] OK — no warnings")
    else:
        print(
            f"[seed-validation] {report.total()} warning(s): "
            f"dup_names={report.duplicate_names} "
            f"dup_aliases={report.duplicate_aliases} "
            f"broad_aliases={report.broad_aliases} "
            f"no_default={report.missing_default_serving} "
            f"dup_labels={report.duplicate_serving_labels} "
            f"bad_grams={report.invalid_grams} "
            f"macros={report.macro_mismatch} "
            f"category={report.category_mismatch} "
            f"no_prep={report.missing_prep_state}"
        )

    return report
