"""
Exercise + equipment seed validators — surface data-quality issues
that would otherwise drift into production unnoticed.

Called from `seed_exercises()` before the insert loop. Every issue is
logged (`[seed-ex-validation] ...`) and counted. Returns a structured
report so tests / CI can assert against the warning counts.

Checks:
  1. duplicate slugs
  2. duplicate display names
  3. invalid equipment slugs (not in SEED_EQUIPMENT)
  4. exercises that name no equipment but obviously need it
     (e.g. `bench` in the name → must reference a bench equipment)
  5. inconsistent laterality vs `is_unilateral` (legacy bool drifts
     from richer field)
  6. suspiciously generic machine mappings — entries still referencing
     `leverage_machines` after the specific-machine refactor
  7. movement_pattern / exercise_type combinations that don't make
     sense (e.g. `plyometric` pattern with `mobility` type)
  8. power/plyometric movements that don't carry a `power_type`
  9. empty `equipment` list on entries whose name implies external
     equipment (barbell / dumbbell / machine / cable / kettlebell)
 10. missing or empty descriptions

Warnings are not fatal — the seeder still runs. Intent is to keep
problems visible so they get fixed.
"""
from __future__ import annotations

from dataclasses import dataclass, field


_GENERIC_MACHINE_SLUG = "leverage_machines"

# Tokens in a name that imply specific equipment must be present.
_NAME_EQUIPMENT_HINTS = {
    "barbell":   "barbell",
    "dumbbell":  "dumbbells",
    "kettlebell": "kettlebell",
    "cable":     "cable_machine",
    "machine":   None,                  # generic — caught by hint #9
    "smith":     "smith_machine",
    "trap bar":  "trap_bar",
    "bench":     "flat_bench",          # at least one bench-type equipment
    "preacher":  "preacher_bench",
    "pec deck":  "pec_deck_machine",
    "hyperextension": "hyperextension_bench",
    "calf raise": None,                 # context-dependent
}

# Movement patterns that should always carry a non-strength power_type.
_PLYO_PATTERNS = {"plyometric"}

# (movement_pattern, exercise_type) combos that don't make sense.
_INCONSISTENT_COMBOS: set[tuple[str, str]] = {
    ("plyometric", "mobility"),
    ("squat", "mobility"),
    ("hinge", "mobility"),
    ("horizontal_press", "mobility"),
    ("vertical_press", "mobility"),
    ("horizontal_pull", "mobility"),
    ("vertical_pull", "mobility"),
}

_FREE_WEIGHT_NAME_TOKENS = (
    "barbell", "dumbbell", "kettlebell", "cable", "machine",
    "smith", "trap bar", "preacher", "pec deck", "hyperextension",
)

_VALID_LATERALITIES = {"bilateral", "unilateral", "alternating", "either"}


@dataclass
class ExerciseValidationReport:
    warnings: list[str] = field(default_factory=list)
    duplicate_slugs: int = 0
    duplicate_names: int = 0
    invalid_equipment: int = 0
    missing_required_support: int = 0
    laterality_inconsistent: int = 0
    generic_machine: int = 0
    bad_combo: int = 0
    missing_power_type: int = 0
    missing_equipment: int = 0
    missing_description: int = 0
    missing_substitution_group: int = 0

    def warn(self, msg: str) -> None:
        print(f"[seed-ex-validation] {msg}")
        self.warnings.append(msg)

    def total(self) -> int:
        return len(self.warnings)


def validate_exercise_seed(
    entries: list[dict],
    equipment_slugs: set[str] | None = None,
) -> ExerciseValidationReport:
    """Run all checks. `equipment_slugs` is the set of valid Equipment
    slugs from SEED_EQUIPMENT; passed in by the caller so this module
    doesn't import the seed file itself (avoids circular imports if
    validators ever move)."""
    report = ExerciseValidationReport()
    equipment_slugs = equipment_slugs or set()

    # ── 1. duplicate slugs ───────────────────────────────────────────────
    seen_slugs: set[str] = set()
    for e in entries:
        slug = e.get("slug", "")
        if not slug:
            report.warn(f"entry has no slug: {e.get('name')}")
            continue
        if slug in seen_slugs:
            report.duplicate_slugs += 1
            report.warn(f"duplicate slug '{slug}'")
        seen_slugs.add(slug)

    # ── 2. duplicate names ───────────────────────────────────────────────
    seen_names: dict[str, str] = {}
    for e in entries:
        name = e.get("name", "")
        if not name:
            continue
        if name in seen_names:
            report.duplicate_names += 1
            report.warn(f"duplicate name '{name}' (slugs: {seen_names[name]} + {e.get('slug')})")
        else:
            seen_names[name] = e.get("slug", "")

    # ── 3. invalid equipment slugs ───────────────────────────────────────
    if equipment_slugs:
        for e in entries:
            for eq in e.get("equipment", []) or []:
                slug = eq.get("slug", "")
                if slug and slug not in equipment_slugs:
                    report.invalid_equipment += 1
                    report.warn(
                        f"'{e.get('slug')}' references unknown equipment slug '{slug}'"
                    )

    # ── 4. exercises whose name implies a specific equipment slug ───────
    for e in entries:
        name_lower = e.get("name", "").lower()
        eq_slugs = {eq.get("slug") for eq in e.get("equipment", []) or []}
        for token, required_slug in _NAME_EQUIPMENT_HINTS.items():
            if token not in name_lower or required_slug is None:
                continue
            # Bench is special — accept any bench variant.
            if required_slug == "flat_bench":
                if not any(s in eq_slugs for s in ("flat_bench", "adjustable_bench", "incline_bench", "decline_bench")):
                    report.missing_required_support += 1
                    report.warn(
                        f"'{e.get('slug')}' has '{token}' in name but no bench in equipment"
                    )
            elif required_slug not in eq_slugs:
                report.missing_required_support += 1
                report.warn(
                    f"'{e.get('slug')}' has '{token}' in name but no '{required_slug}' in equipment"
                )

    # ── 5. laterality consistency ───────────────────────────────────────
    for e in entries:
        lat = e.get("laterality")
        if lat is None:
            continue
        if lat not in _VALID_LATERALITIES:
            report.laterality_inconsistent += 1
            report.warn(f"'{e.get('slug')}' has invalid laterality '{lat}'")
            continue
        is_uni = e.get("is_unilateral", False)
        # bilateral/either should NOT be flagged unilateral; unilateral
        # and alternating SHOULD be flagged unilateral.
        if lat in ("unilateral", "alternating") and not is_uni:
            report.laterality_inconsistent += 1
            report.warn(
                f"'{e.get('slug')}' laterality={lat} but is_unilateral=False"
            )
        if lat == "bilateral" and is_uni:
            report.laterality_inconsistent += 1
            report.warn(
                f"'{e.get('slug')}' laterality=bilateral but is_unilateral=True"
            )

    # ── 6. generic machine slug (after specific-machine refactor) ───────
    for e in entries:
        for eq in e.get("equipment", []) or []:
            if eq.get("slug") == _GENERIC_MACHINE_SLUG:
                report.generic_machine += 1
                report.warn(
                    f"'{e.get('slug')}' still references generic '{_GENERIC_MACHINE_SLUG}' "
                    f"— consider a specific machine slug"
                )

    # ── 7. movement_pattern / exercise_type combos ──────────────────────
    for e in entries:
        combo = (e.get("movement_pattern"), e.get("exercise_type"))
        if combo in _INCONSISTENT_COMBOS:
            report.bad_combo += 1
            report.warn(
                f"'{e.get('slug')}' has inconsistent combo "
                f"movement_pattern={combo[0]}, exercise_type={combo[1]}"
            )

    # ── 8. plyometric/power without power_type ──────────────────────────
    for e in entries:
        mp = e.get("movement_pattern")
        if mp in _PLYO_PATTERNS and "power_type" not in e:
            report.missing_power_type += 1
            report.warn(
                f"'{e.get('slug')}' is movement_pattern={mp} but has no "
                f"power_type — should be 'power' or 'plyometric'"
            )

    # ── 9. external-equipment names with empty equipment list ───────────
    for e in entries:
        name_lower = e.get("name", "").lower()
        eq = e.get("equipment", []) or []
        if eq:
            continue
        if any(tok in name_lower for tok in _FREE_WEIGHT_NAME_TOKENS):
            report.missing_equipment += 1
            report.warn(
                f"'{e.get('slug')}' name suggests external equipment but "
                f"equipment list is empty"
            )

    # ── 10. missing description ─────────────────────────────────────────
    for e in entries:
        desc = (e.get("description") or "").strip()
        if not desc:
            report.missing_description += 1
            report.warn(f"'{e.get('slug')}' has no description")

    # ── 11. major-family entries should declare a substitution_group ────
    # The planner's swap logic only works when entries opt in to a group.
    # We don't require it on prehab/mobility/cardio entries (those rarely
    # need 1-for-1 substitution), but compound strength + plyometric work
    # should always belong to a family.
    _SUB_GROUP_REQUIRED_PATTERNS = {
        "horizontal_press", "vertical_press", "horizontal_pull", "vertical_pull",
        "squat", "hinge", "lunge", "plyometric", "carry",
    }
    for e in entries:
        mp = e.get("movement_pattern")
        if mp not in _SUB_GROUP_REQUIRED_PATTERNS:
            continue
        if e.get("exercise_type") in ("mobility",):
            continue
        if not e.get("substitution_group"):
            report.missing_substitution_group += 1
            report.warn(
                f"'{e.get('slug')}' has movement_pattern={mp} but no "
                f"substitution_group — planner can't swap it"
            )

    if report.total() == 0:
        print("[seed-ex-validation] OK — no warnings")
    else:
        print(
            f"[seed-ex-validation] {report.total()} warning(s): "
            f"dup_slug={report.duplicate_slugs} "
            f"dup_name={report.duplicate_names} "
            f"bad_eq={report.invalid_equipment} "
            f"no_support={report.missing_required_support} "
            f"laterality={report.laterality_inconsistent} "
            f"generic_machine={report.generic_machine} "
            f"bad_combo={report.bad_combo} "
            f"no_power_type={report.missing_power_type} "
            f"no_eq={report.missing_equipment} "
            f"no_desc={report.missing_description} "
            f"no_sub_group={report.missing_substitution_group}"
        )

    return report


# ─── Equipment-only validator ────────────────────────────────────────────────
#
# Focused checks for SEED_EQUIPMENT entries themselves (not their use by
# exercises — that's covered by the exercise validator's check #3). Run
# alongside the exercise validator to catch equipment regressions early.

# Categories the seed currently uses. Adding a new one here is a deliberate
# act, not a typo.
_VALID_EQUIPMENT_CATEGORIES = {
    "Bodyweight & Home",
    "Free Weights",
    "Benches & Racks",
    "Gym Machines",
    "Cardio",
    "Athletic / Functional",
}

# Slugs that are deliberately generic catch-alls — the validator records a
# "generic" warning every time they're referenced from an exercise, but it
# does NOT warn on their existence in SEED_EQUIPMENT itself. They're a
# safety net for niche plate-loaded machines we haven't broken out yet.
_DELIBERATELY_GENERIC = {"leverage_machines"}


@dataclass
class EquipmentValidationReport:
    warnings: list[str] = field(default_factory=list)
    duplicate_slugs: int = 0
    duplicate_names: int = 0
    invalid_category: int = 0
    bad_slug_format: int = 0
    missing_icon: int = 0
    missing_name: int = 0

    def warn(self, msg: str) -> None:
        print(f"[seed-eq-validation] {msg}")
        self.warnings.append(msg)

    def total(self) -> int:
        return len(self.warnings)


def validate_equipment_seed(entries: list[dict]) -> EquipmentValidationReport:
    """Run quality checks on SEED_EQUIPMENT itself.

    Checks:
      1. duplicate slugs
      2. duplicate display names
      3. invalid categories (must be in _VALID_EQUIPMENT_CATEGORIES)
      4. slug format — snake_case, alphanumeric + underscore, no spaces
      5. missing or empty icon
      6. missing or empty name
    """
    report = EquipmentValidationReport()

    # ── 1. duplicate slugs ───────────────────────────────────────────────
    seen_slugs: set[str] = set()
    for e in entries:
        slug = e.get("slug", "")
        if not slug:
            report.warn(f"equipment entry has no slug: {e.get('name')}")
            continue
        if slug in seen_slugs:
            report.duplicate_slugs += 1
            report.warn(f"duplicate equipment slug '{slug}'")
        seen_slugs.add(slug)

    # ── 2. duplicate names ───────────────────────────────────────────────
    seen_names: dict[str, str] = {}
    for e in entries:
        name = e.get("name", "")
        if not name:
            report.missing_name += 1
            report.warn(f"equipment '{e.get('slug')}' has no name")
            continue
        if name in seen_names:
            report.duplicate_names += 1
            report.warn(
                f"duplicate equipment name '{name}' "
                f"(slugs: {seen_names[name]} + {e.get('slug')})"
            )
        else:
            seen_names[name] = e.get("slug", "")

    # ── 3. invalid categories ────────────────────────────────────────────
    for e in entries:
        cat = e.get("category", "")
        if cat not in _VALID_EQUIPMENT_CATEGORIES:
            report.invalid_category += 1
            report.warn(
                f"equipment '{e.get('slug')}' has invalid category '{cat}' — "
                f"must be one of {sorted(_VALID_EQUIPMENT_CATEGORIES)}"
            )

    # ── 4. slug format ───────────────────────────────────────────────────
    for e in entries:
        slug = e.get("slug", "")
        if not slug:
            continue
        if slug != slug.lower():
            report.bad_slug_format += 1
            report.warn(f"equipment slug '{slug}' is not lowercase")
            continue
        if not all(c.isalnum() or c == "_" for c in slug):
            report.bad_slug_format += 1
            report.warn(
                f"equipment slug '{slug}' has invalid characters — "
                f"snake_case alphanumerics only"
            )
        if " " in slug:
            report.bad_slug_format += 1
            report.warn(f"equipment slug '{slug}' contains spaces")

    # ── 5. missing icons ─────────────────────────────────────────────────
    for e in entries:
        icon = e.get("icon", "")
        if not icon or not icon.strip():
            report.missing_icon += 1
            report.warn(f"equipment '{e.get('slug')}' has no icon")

    # Summary line.
    if report.total() == 0:
        print("[seed-eq-validation] OK — no warnings")
    else:
        print(
            f"[seed-eq-validation] {report.total()} warning(s): "
            f"dup_slug={report.duplicate_slugs} "
            f"dup_name={report.duplicate_names} "
            f"bad_cat={report.invalid_category} "
            f"bad_slug={report.bad_slug_format} "
            f"no_icon={report.missing_icon} "
            f"no_name={report.missing_name}"
        )
    return report
