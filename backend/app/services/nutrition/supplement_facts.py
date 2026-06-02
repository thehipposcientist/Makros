"""Parse structured Supplement Facts panels into credited micronutrients.

Scanned supplements carry a ``nutrient_content`` blob on
``UserSupplementStack`` shaped as::

    {
      "serving_size": {"count": 2, "unit": "capsule"},
      "nutrients": [
        {"key": "zinc_mg", "nutrient": "Zinc", "amount": 15,
         "unit": "mg", "percent_dv": 136},
        {"key": "boron_mg", "nutrient": "Boron", "amount": 3,
         "unit": "mg", "percent_dv": null}
      ],
      "parse_source": "scan"
    }

This module turns that blob plus a logged dose into a dict of suffixed
micro keys (``calcium_mg``, ``vitamin_d_mcg``, ``boron_mg`` ...) matching
the keys the Nutrition Score pipeline already uses. Pure functions only —
no DB, no network, no I/O — so the whole thing is unit-testable.
"""
from __future__ import annotations

import re

# ─── Canonical micro keys ────────────────────────────────────────────────────
#
# Suffixed keys are the Nutrition Score's internal currency (see RDA /
# KEY_MICROS in nutrition_score.py). Listed with their canonical unit so the
# converter never has to parse a key name.
MICRO_KEY_UNIT: dict[str, str] = {
    "calcium_mg": "mg", "iron_mg": "mg", "potassium_mg": "mg",
    "magnesium_mg": "mg", "phosphorus_mg": "mg", "zinc_mg": "mg",
    "copper_mg": "mg", "manganese_mg": "mg", "boron_mg": "mg",
    "vitamin_c_mg": "mg", "vitamin_e_mg": "mg", "vitamin_b6_mg": "mg",
    "thiamin_b1_mg": "mg", "riboflavin_b2_mg": "mg", "niacin_b3_mg": "mg",
    "pantothenic_acid_b5_mg": "mg",
    "selenium_mcg": "mcg", "vitamin_d_mcg": "mcg", "vitamin_b12_mcg": "mcg",
    "vitamin_a_mcg": "mcg", "vitamin_k_mcg": "mcg", "folate_mcg": "mcg",
    "biotin_b7_mcg": "mcg",
    "omega_3_g": "g",
}

DISPLAY_NAMES: dict[str, str] = {
    "calcium_mg": "Calcium", "iron_mg": "Iron", "potassium_mg": "Potassium",
    "magnesium_mg": "Magnesium", "phosphorus_mg": "Phosphorus",
    "zinc_mg": "Zinc", "copper_mg": "Copper", "manganese_mg": "Manganese",
    "boron_mg": "Boron", "vitamin_c_mg": "Vitamin C", "vitamin_e_mg": "Vitamin E",
    "vitamin_b6_mg": "Vitamin B6", "thiamin_b1_mg": "Vitamin B1",
    "riboflavin_b2_mg": "Vitamin B2", "niacin_b3_mg": "Vitamin B3",
    "pantothenic_acid_b5_mg": "Vitamin B5", "selenium_mcg": "Selenium",
    "vitamin_d_mcg": "Vitamin D", "vitamin_b12_mcg": "Vitamin B12",
    "vitamin_a_mcg": "Vitamin A", "vitamin_k_mcg": "Vitamin K",
    "folate_mcg": "Folate", "biotin_b7_mcg": "Vitamin B7", "omega_3_g": "Omega-3",
}

# Substring fragments of a *space-stripped, lowercased* nutrient name → key.
# Checked in order, first match wins — so "vitaminb12" must precede
# "vitaminb1" (the latter is a substring of the former).
_NAME_PATTERNS: tuple[tuple[str, str], ...] = (
    ("vitaminb12", "vitamin_b12_mcg"),
    ("cobalamin", "vitamin_b12_mcg"),
    ("vitaminb6", "vitamin_b6_mg"),
    ("pyridoxine", "vitamin_b6_mg"),
    ("vitaminb1", "thiamin_b1_mg"),
    ("thiamin", "thiamin_b1_mg"),
    ("vitaminb2", "riboflavin_b2_mg"),
    ("riboflavin", "riboflavin_b2_mg"),
    ("vitaminb3", "niacin_b3_mg"),
    ("niacin", "niacin_b3_mg"),
    ("vitaminb5", "pantothenic_acid_b5_mg"),
    ("pantothenic", "pantothenic_acid_b5_mg"),
    ("vitaminb7", "biotin_b7_mcg"),
    ("biotin", "biotin_b7_mcg"),
    ("vitaminb9", "folate_mcg"),
    ("folicacid", "folate_mcg"),
    ("folate", "folate_mcg"),
    ("vitamind", "vitamin_d_mcg"),
    ("cholecalciferol", "vitamin_d_mcg"),
    ("vitamina", "vitamin_a_mcg"),
    ("retinol", "vitamin_a_mcg"),
    ("vitaminc", "vitamin_c_mg"),
    ("ascorbic", "vitamin_c_mg"),
    ("vitamine", "vitamin_e_mg"),
    ("tocopherol", "vitamin_e_mg"),
    ("vitamink", "vitamin_k_mcg"),
    ("phylloquinone", "vitamin_k_mcg"),
    ("menaquinone", "vitamin_k_mcg"),
    ("calcium", "calcium_mg"),
    ("iron", "iron_mg"),
    ("potassium", "potassium_mg"),
    ("magnesium", "magnesium_mg"),
    ("phosphorus", "phosphorus_mg"),
    ("zinc", "zinc_mg"),
    ("copper", "copper_mg"),
    ("manganese", "manganese_mg"),
    ("selenium", "selenium_mcg"),
    ("boron", "boron_mg"),
    ("omega3", "omega_3_g"),
    ("fishoil", "omega_3_g"),
    ("epadha", "omega_3_g"),
)

# micro key → IU per canonical unit. IU is nutrient-specific; dividing the
# label's IU value by this factor yields the canonical-unit amount.
_IU_FACTORS: dict[str, float] = {
    "vitamin_d_mcg": 40.0,    # 1 mcg cholecalciferol = 40 IU
    "vitamin_a_mcg": 3.33,    # 1 mcg RAE ≈ 3.33 IU (retinol)
    "vitamin_e_mg": 1.49,     # 1 mg ≈ 1.49 IU (d-alpha-tocopherol)
}

_MASS_TO_MCG: dict[str, float] = {"g": 1_000_000.0, "mg": 1_000.0, "mcg": 1.0}

# Count-based dose units (post-singularization). A logged dose in one of
# these can be scaled against the label serving count.
_COUNT_UNITS = {
    "capsule", "cap", "tablet", "tab", "softgel", "gel",
    "gummy", "gummie", "pill", "scoop", "lozenge", "drop",
}


def _safe_float(value: object) -> float:
    try:
        return float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return 0.0


def _norm_name(name: object) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(name or "").lower())


def _norm_unit(unit: object) -> str:
    """Collapse a free-text unit string to one of mg/mcg/g/iu, or ''."""
    u = str(unit or "").strip().lower().replace("µ", "u").replace("μ", "u")
    u = re.sub(r"[^a-z]", "", u)
    if not u:
        return ""
    if u.startswith("iu"):
        return "iu"
    if u.startswith("mcg") or u.startswith("ug"):
        return "mcg"
    if u.startswith("mg"):
        return "mg"
    if u.startswith("g"):
        return "g"
    return ""


def _norm_dose_unit(unit: object) -> str:
    """Normalize a count/serving unit; strips a trailing plural 's'."""
    u = re.sub(r"[^a-z]", "", str(unit or "").lower())
    if len(u) > 1 and u.endswith("s"):
        u = u[:-1]
    return u


def normalize_nutrient_name(name: object) -> str | None:
    """Map a label nutrient name → suffixed micro key, or None if unknown."""
    norm = _norm_name(name)
    if not norm:
        return None
    for fragment, key in _NAME_PATTERNS:
        if fragment in norm:
            return key
    return None


def convert_amount(amount: object, unit: object, micro_key: str) -> float:
    """Convert ``amount`` (in ``unit``) to ``micro_key``'s canonical unit.

    Handles mg/mcg/g mass conversion and nutrient-specific IU conversion.
    An unrecognized unit is assumed to already be the canonical unit — the
    least-surprising default, since labels almost always use the nutrient's
    natural unit. IU for a nutrient with no IU factor returns 0.
    """
    amt = _safe_float(amount)
    if amt <= 0:
        return 0.0
    target = MICRO_KEY_UNIT.get(micro_key)
    if target is None:
        return 0.0
    u = _norm_unit(unit)
    if u == "iu":
        factor = _IU_FACTORS.get(micro_key)
        return amt / factor if factor else 0.0
    src = u if u in _MASS_TO_MCG else target
    return amt * _MASS_TO_MCG[src] / _MASS_TO_MCG[target]


def _serving_scale(serving_size: object, dose_amount: object, dose_unit: object) -> float:
    """How many label servings a logged dose represents.

    A dose logged as ``serving`` maps 1:1. A count-based dose
    (capsule/tablet/...) scales by the label serving count when the units
    match. Everything else — mass-unit doses, unit mismatch, missing
    serving size — falls back to one serving. Guessing past that produces
    wrong numbers more often than right ones.
    """
    dose = _safe_float(dose_amount)
    du = _norm_dose_unit(dose_unit)
    if du == "serving":
        return dose if dose > 0 else 1.0
    if du in _COUNT_UNITS and isinstance(serving_size, dict):
        count = _safe_float(serving_size.get("count"))
        su = _norm_dose_unit(serving_size.get("unit"))
        if dose > 0 and count > 0 and du == su:
            return dose / count
    return 1.0


def credited_micros_from_content(
    nutrient_content: object,
    dose_amount: object = None,
    dose_unit: object = None,
) -> dict[str, float]:
    """Convert a stored ``nutrient_content`` blob + a logged dose into a
    ``{micro_key: amount}`` dict in the score's canonical units."""
    out: dict[str, float] = {}
    if not isinstance(nutrient_content, dict):
        return out
    nutrients = nutrient_content.get("nutrients")
    if not isinstance(nutrients, list):
        return out
    scale = _serving_scale(nutrient_content.get("serving_size"), dose_amount, dose_unit)
    for entry in nutrients:
        if not isinstance(entry, dict):
            continue
        key = entry.get("key")
        if not key or key not in MICRO_KEY_UNIT:
            key = normalize_nutrient_name(entry.get("nutrient"))
        if not key:
            continue
        amount = convert_amount(entry.get("amount"), entry.get("unit"), key)
        if amount <= 0:
            continue
        out[key] = out.get(key, 0.0) + amount * scale
    return out


def _sanitize_serving_size(raw: object) -> dict | None:
    if not isinstance(raw, dict):
        return None
    count = _safe_float(raw.get("count"))
    unit = _norm_dose_unit(raw.get("unit"))[:16]
    if count <= 0 and not unit:
        return None
    return {
        "count": round(count, 3) if count > 0 else None,
        "unit": unit or None,
    }


def sanitize_nutrient_facts(
    raw_facts: object,
    serving_size: object = None,
    *,
    parse_source: str = "scan",
) -> dict | None:
    """Validate an AI-extracted Supplement Facts list into a storable
    ``nutrient_content`` blob. Unmappable rows, non-positive amounts and
    duplicate nutrients are dropped. Returns None when nothing survives."""
    if not isinstance(raw_facts, list):
        return None
    nutrients: list[dict] = []
    seen: set[str] = set()
    for entry in raw_facts:
        if not isinstance(entry, dict):
            continue
        key = normalize_nutrient_name(entry.get("nutrient") or entry.get("name"))
        if not key or key in seen:
            continue
        amount = _safe_float(entry.get("amount"))
        if amount <= 0:
            continue
        unit = str(entry.get("unit") or "").strip()[:12] or MICRO_KEY_UNIT.get(key, "")
        pdv_raw = entry.get("percent_dv")
        try:
            pdv = round(float(pdv_raw), 1) if pdv_raw is not None else None
        except (TypeError, ValueError):
            pdv = None
        nutrients.append({
            "key": key,
            "nutrient": DISPLAY_NAMES.get(key, key),
            "amount": round(amount, 4),
            "unit": unit,
            "percent_dv": pdv,
        })
        seen.add(key)
    if not nutrients:
        return None
    blob: dict = {"nutrients": nutrients, "parse_source": parse_source}
    ss = _sanitize_serving_size(serving_size)
    if ss:
        blob["serving_size"] = ss
    return blob
