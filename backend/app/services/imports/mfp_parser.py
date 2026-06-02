"""MyFitnessPal nutrition CSV parser.

Pure-function — no DB, no network. Takes bytes (CSV file contents)
and returns a list of `ParsedMealRow` records. The orchestrator
(`mfp_pipeline.py`) is responsible for matching rows to Thallo Foods
and upserting Meal rows.

Three export shapes are accepted:

1. **90-day web export** (Reports → Export Daily Food Records). Single
   CSV file with item-level rows and a `Food` column.

2. **Current Premium export** (app/web Export). Email-delivered ZIP
   with a nutrition CSV summarized at meal level. These rows often do
   not include a `Food` column; we import each meal summary as one
   synthetic `MyFitnessPal <Meal>` item so calories/macros still count.

3. **Older GDPR data request** ZIPs with `Food_Diary.csv`, whose schema
   usually matches form (1).

The 2024-format header row (most common in the wild):

    Date,Meal,Food,Calories,Fat (g),Saturated Fat,Polyunsaturated Fat,
    Monounsaturated Fat,Trans Fat,Cholesterol,Sodium (mg),Potassium,
    Carbohydrates (g),Fiber,Sugar,Protein (g),Vitamin A,Vitamin C,
    Calcium,Iron,Note

Tolerated variations:
  - Header columns reordered or partially missing.
  - "Fat (g)" vs "Fat" vs "Total Fat (g)" — header normalization is
    lowercased + punctuation-stripped before lookup.
  - Date in YYYY-MM-DD, M/D/YYYY, MM-DD-YYYY, M/D/YY, or those values
    with a timestamp appended.
  - Numbers with thousands separator commas ("1,200").
  - Vitamin A/C/Calcium/Iron expressed as either grams or "15%" — we
    ignore micros for now (not modeled in MealItem) but parse the
    macros aggressively.
  - UTF-8 BOM at the start of the file.
  - Trailing empty rows / rows with no food name in item-level exports.

Returned rows are NOT idempotent on their own — the pipeline adds
`import_hash = sha256(user_id|date|meal_type|food_name|calories|...)`
before insert so re-uploading the same export doesn't duplicate.
"""

from __future__ import annotations

import csv
import io
import re
from dataclasses import dataclass
from datetime import date, datetime
from typing import Iterable


# ─── Public dataclass ────────────────────────────────────────────────────────

@dataclass(frozen=True)
class ParsedMealRow:
    """One MFP food-diary entry, normalized to Thallo conventions.

    `meal_type` is normalized to one of {"breakfast","lunch","dinner","snack"}.
    All macro fields are grams (`*_g`) or milligrams (`*_mg`); they default
    to `None` when missing rather than 0 so callers can distinguish
    "MFP didn't record this" from "actually zero."

    `quantity_text` is the embedded quantity prefix from the Food
    column when MFP didn't put it in a separate column (older exports).
    The matcher uses this for unit / amount normalization.

    `row_index` is the 0-based index of the source row, useful for
    surfacing "row 47 had an unparseable date" errors back to the user.
    """
    row_index: int
    meal_date: date
    meal_type: str
    food_name: str
    quantity_text: str | None
    calories: float | None
    protein_g: float | None
    carbs_g: float | None
    fat_g: float | None
    saturated_fat_g: float | None
    cholesterol_mg: float | None
    sodium_mg: float | None
    fiber_g: float | None
    sugar_g: float | None
    note: str | None


@dataclass(frozen=True)
class ParseResult:
    """Container for parser output + diagnostic info.

    `skipped` rows aren't errors — they're rows we deliberately ignored
    (empty food name, summary/total rows MFP sometimes appends). The
    `errors` list is for rows we tried to parse but couldn't (unparseable
    date, malformed CSV row, etc.) so the user can review them.
    """
    rows: list[ParsedMealRow]
    skipped_count: int
    errors: list[str]


# ─── Header / value normalizers ──────────────────────────────────────────────

_HEADER_ALIASES: dict[str, tuple[str, ...]] = {
    # Canonical → aliases (already lowercased + punctuation-stripped).
    "date":       ("date", "date time", "datetime", "date logged", "entry date", "logged date"),
    "meal":       ("meal", "mealtype", "meal type", "meal_type", "meal name"),
    "food":       ("food", "foods", "food name", "name", "description", "food drink", "food item"),
    "quantity":   ("quantity", "qty", "amount", "serving", "serving size"),
    "calories":   ("calories", "energy", "kcal", "calories kcal"),
    "protein":    ("protein g", "protein", "protein grams"),
    "carbs":      ("carbohydrates g", "carbs g", "carbs", "carbohydrates", "total carbohydrate", "total carbohydrate g", "total carbohydrates", "total carbohydrates g"),
    "fat":        ("fat g", "fat", "total fat g", "total fat", "fat grams"),
    "sat_fat":    ("saturated fat", "saturated fat g", "sat fat", "sat fat g"),
    "cholesterol":("cholesterol mg", "cholesterol", "chol"),
    "sodium":     ("sodium mg", "sodium"),
    "fiber":      ("fiber g", "fiber", "fibre g", "fibre", "dietary fiber", "dietary fiber g"),
    "sugar":      ("sugar g", "sugar", "sugars", "sugars g", "total sugars", "total sugars g"),
    "note":       ("note", "notes", "comment", "comments"),
}

# Inverted for O(1) header lookup.
_HEADER_LOOKUP: dict[str, str] = {
    alias: canonical
    for canonical, aliases in _HEADER_ALIASES.items()
    for alias in aliases
}


def _normalize_header(raw: str) -> str:
    """Lowercase + collapse whitespace + strip punctuation. Returns the
    canonical key when recognized, otherwise the normalized form."""
    s = raw.strip().lower()
    s = s.replace("(", " ").replace(")", " ").replace(",", " ")
    s = re.sub(r"[^a-z0-9 ]", "", s)
    s = re.sub(r"\s+", " ", s).strip()
    return _HEADER_LOOKUP.get(s, s)


_MEAL_TYPE_NORMALIZE: dict[str, str] = {
    "breakfast": "breakfast",
    "lunch":     "lunch",
    "dinner":    "dinner",
    "snack":     "snack",
    "snacks":    "snack",
    # MFP "Anytime" / custom meal names default to snack — closest match
    # to "ate this but not a specific meal slot."
    "anytime":   "snack",
}


def _normalize_meal_type(raw: str | None) -> str:
    if not raw:
        return "snack"
    return _MEAL_TYPE_NORMALIZE.get(raw.strip().lower(), "snack")


_DATE_FORMATS: tuple[str, ...] = (
    "%Y-%m-%d",      # 2026-05-10 — MFP default
    "%Y-%m-%d %H:%M",
    "%Y-%m-%d %H:%M:%S",
    "%m/%d/%Y",      # 5/10/2026 — common US export
    "%m/%d/%Y %H:%M",
    "%m/%d/%Y %H:%M:%S",
    "%m/%d/%Y %I:%M %p",
    "%m-%d-%Y",      # 5-10-2026
    "%d/%m/%Y",      # 10/5/2026 — UK locale
    "%m/%d/%y",      # 5/10/26
    "%Y/%m/%d",      # 2026/05/10
    "%B %d %Y",      # May 10 2026
    "%b %d %Y",      # May 10 2026
)


def _parse_date(raw: str) -> date | None:
    s = raw.strip()
    if not s:
        return None
    # Quoted month-name dates commonly include a comma. Header
    # normalization strips commas, so do the same here before trying
    # the explicit formats below.
    s = re.sub(r"\s+", " ", s.replace(",", " ")).strip()
    iso = s.replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(iso).date()
    except ValueError:
        pass
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    # Last resort: extract a leading date from strings like
    # "2026-05-10 7:45 PM EDT" or "5/10/2026 at 7:45 PM".
    m = re.match(r"^(\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{2,4})\b", s)
    if m:
        return _parse_date(m.group(1))
    return None


def _parse_number(raw: str | None) -> float | None:
    """Parse '1,200', '4.5g', '15%', '12.3', '<1', '--' tolerantly.

    Returns None when the cell is empty/unparseable. Returns a float
    even for integer-looking values (uniform downstream handling)."""
    if raw is None:
        return None
    s = raw.strip()
    if not s or s in {"--", "-", "n/a", "N/A", "NA"}:
        return None
    # Strip thousands separators and units. `<1` collapses to 0.5
    # rather than 1 — MFP's micro columns use it to mean "trace."
    if s.startswith("<"):
        s = s[1:].strip() or "0"
        try:
            return float(s) / 2
        except ValueError:
            return None
    s = s.replace(",", "")
    s = re.sub(r"[a-zA-Z%]", "", s).strip()
    if not s:
        return None
    try:
        return float(s)
    except ValueError:
        return None


# Embedded-quantity extractor — pulls "1 cup", "3 oz", "150 g" off the
# front of a food name when the export didn't include a separate
# Quantity column. We don't fail-fast here; the matcher gets both the
# extracted quantity (if any) and the cleaned food name.
_QUANTITY_PREFIX_RE = re.compile(
    r"^\s*(\d+(?:[./]\d+)?(?:\s*\d+/\d+)?)\s*"
    r"(cups?|tbsp|tablespoons?|tsp|teaspoons?|oz|ounces?|grams?|g|"
    r"lbs?|pounds?|kg|kilograms?|ml|milliliters?|l|liters?|"
    r"servings?|pieces?|slices?|large|medium|small)?\s*",
    re.IGNORECASE,
)


def _split_quantity(food_field: str) -> tuple[str | None, str]:
    """Return (quantity_text, cleaned_food_name).

    If no prefix matches, quantity_text is None and food_name is the
    input unchanged. Numbers with no unit ("3 eggs") are kept as the
    quantity text since "eggs" is a reasonable food name without it."""
    if not food_field:
        return None, food_field
    m = _QUANTITY_PREFIX_RE.match(food_field)
    if not m or not m.group(1):
        return None, food_field.strip()
    qty_num, qty_unit = m.group(1), (m.group(2) or "").strip()
    qty_text = f"{qty_num} {qty_unit}".strip() if qty_unit else qty_num
    cleaned = food_field[m.end():].strip()
    return qty_text, cleaned or food_field.strip()


_SUMMARY_ROW_VALUES = {"TOTAL", "TOTALS", "DAILY TOTAL", "DAILY TOTALS", "GRAND TOTAL", "TOTAL CALORIES"}


def _looks_like_meal_level_export(column_index: dict[str, int]) -> bool:
    """MFP's current official export can be meal-level, not food-level.

    It has Date + Meal + nutrition columns, but no Food column. Treat it
    as importable because users still expect their calories/macros to
    come over even when item names are unavailable.
    """
    if "food" in column_index:
        return False
    if "date" not in column_index or "meal" not in column_index:
        return False
    return any(k in column_index for k in ("calories", "protein", "carbs", "fat"))


def _synthetic_food_name(meal_raw: str | None) -> str:
    meal = _normalize_meal_type(meal_raw)
    return f"MyFitnessPal {meal.title()}"


# ─── Public parse entry points ───────────────────────────────────────────────

def _decode_csv(raw: bytes) -> str:
    """UTF-8 with BOM tolerance, Latin-1 fallback. MFP's old exports
    are inconsistent — recent ones are UTF-8 with a BOM, older Windows
    exports are CP-1252-ish. Latin-1 cannot fail-decode (1:1 mapping to
    Unicode), so it's a safe final fallback."""
    for encoding in ("utf-8-sig", "utf-8", "latin-1"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw.decode("latin-1", errors="replace")


def parse_mfp_csv(raw: bytes) -> ParseResult:
    """Parse the bytes of an MFP nutrition CSV.

    The parser is forgiving: unknown columns are ignored, rows with
    blank dates / food names are skipped (counted in `skipped_count`)
    for item-level files, meal-level summary files synthesize a food
    name, and rows that fail date parsing are recorded as errors so the
    user can review them later.

    For the GDPR ZIP, the pipeline extracts `Food_Diary.csv` and
    passes its bytes here. Other CSVs in the ZIP (Exercise_Diary,
    Measurements, Recipes) get their own parsers.
    """
    text = _decode_csv(raw)
    reader = csv.reader(io.StringIO(text))

    try:
        header_row = next(reader)
    except StopIteration:
        return ParseResult(rows=[], skipped_count=0, errors=["empty file"])

    # Map canonical column key → CSV column index. Unrecognized columns
    # silently land under their normalized name (harmless — we only
    # read the canonical keys downstream).
    column_index: dict[str, int] = {}
    for i, raw_header in enumerate(header_row):
        canonical = _normalize_header(raw_header)
        # Don't clobber an earlier mapping if the same canonical key
        # appears twice (e.g. some exports duplicate "Sugar"). First
        # occurrence wins.
        column_index.setdefault(canonical, i)

    meal_level_export = _looks_like_meal_level_export(column_index)
    if "date" not in column_index or ("food" not in column_index and not meal_level_export):
        return ParseResult(
            rows=[],
            skipped_count=0,
            errors=["missing required columns: expected 'Date' plus either 'Food' or meal-level nutrition columns"],
        )

    def cell(row: list[str], key: str) -> str | None:
        idx = column_index.get(key)
        if idx is None or idx >= len(row):
            return None
        v = row[idx]
        return v if v != "" else None

    rows: list[ParsedMealRow] = []
    errors: list[str] = []
    skipped = 0

    for row_index, raw_row in enumerate(reader, start=1):
        # Skip totally blank rows (MFP appends them sometimes).
        if not any(cell.strip() for cell in raw_row):
            skipped += 1
            continue

        meal_raw = (cell(raw_row, "meal") or "").strip()
        food_raw = (cell(raw_row, "food") or "").strip()
        if meal_level_export:
            summary_label = (meal_raw or food_raw).upper()
            if not meal_raw or summary_label in _SUMMARY_ROW_VALUES:
                skipped += 1
                continue
            food_raw = _synthetic_food_name(meal_raw)
        else:
            if not food_raw:
                skipped += 1
                continue

            # Daily total / summary rows have date but no per-food entry —
            # MFP appends "TOTAL" rows. Skip them.
            if food_raw.upper() in _SUMMARY_ROW_VALUES:
                skipped += 1
                continue

        date_raw = (cell(raw_row, "date") or "").strip()
        meal_date = _parse_date(date_raw) if date_raw else None
        if meal_date is None:
            errors.append(f"row {row_index}: unparseable date {date_raw!r}")
            continue

        # Quantity: prefer the explicit column when present, else
        # split from the food name. Always retain the cleaned food
        # name for matching.
        quantity_col = cell(raw_row, "quantity")
        if meal_level_export:
            quantity_text = "meal"
            food_name = food_raw
        elif quantity_col:
            quantity_text = quantity_col.strip()
            food_name = food_raw
        else:
            quantity_text, food_name = _split_quantity(food_raw)

        rows.append(ParsedMealRow(
            row_index=row_index,
            meal_date=meal_date,
            meal_type=_normalize_meal_type(meal_raw),
            food_name=food_name,
            quantity_text=quantity_text,
            calories=_parse_number(cell(raw_row, "calories")),
            protein_g=_parse_number(cell(raw_row, "protein")),
            carbs_g=_parse_number(cell(raw_row, "carbs")),
            fat_g=_parse_number(cell(raw_row, "fat")),
            saturated_fat_g=_parse_number(cell(raw_row, "sat_fat")),
            cholesterol_mg=_parse_number(cell(raw_row, "cholesterol")),
            sodium_mg=_parse_number(cell(raw_row, "sodium")),
            fiber_g=_parse_number(cell(raw_row, "fiber")),
            sugar_g=_parse_number(cell(raw_row, "sugar")),
            note=(cell(raw_row, "note") or None),
        ))

    return ParseResult(rows=rows, skipped_count=skipped, errors=errors)


def parse_mfp_gdpr_zip(zip_bytes: bytes) -> ParseResult:
    """Convenience wrapper: extract the nutrition CSV from an MFP ZIP
    and parse it. Returns an error if the ZIP doesn't contain the
    expected file.

    Other CSVs in the ZIP (Exercise_Diary, Measurements, Recipes) are
    not currently consumed — they'll be addressed in follow-up imports."""
    import zipfile

    try:
        zf = zipfile.ZipFile(io.BytesIO(zip_bytes))
    except zipfile.BadZipFile as e:
        return ParseResult(rows=[], skipped_count=0, errors=[f"bad zip: {e}"])

    def normalized_base(path: str) -> str:
        base = path.rsplit("/", 1)[-1].lower().strip()
        base = re.sub(r"[^a-z0-9]+", "_", base).strip("_")
        return base

    names = [name for name in zf.namelist() if not name.endswith("/")]
    csv_names = [name for name in names if normalized_base(name).endswith("_csv")]

    # Prefer explicit food-diary files, then current official "nutrition"
    # exports. Avoid progress/exercise CSVs that ship in the same ZIP.
    target_name: str | None = None
    explicit_names = {"food_diary_csv", "fooddiary_csv", "your_nutrition_csv", "nutrition_csv"}
    for name in csv_names:
        if normalized_base(name) in explicit_names:
            target_name = name
            break
    if target_name is None:
        for name in csv_names:
            base = normalized_base(name)
            if (
                ("nutrition" in base or "meal" in base or "food" in base)
                and not any(skip in base for skip in ("exercise", "progress", "measurement", "weight"))
            ):
                target_name = name
                break
    if target_name is None and len(csv_names) == 1:
        base = normalized_base(csv_names[0])
        if not any(skip in base for skip in ("exercise", "progress", "measurement", "weight")):
            target_name = csv_names[0]

    if not target_name:
        return ParseResult(
            rows=[],
            skipped_count=0,
            errors=["zip does not contain a MyFitnessPal nutrition CSV"],
        )

    csv_bytes = zf.read(target_name)
    return parse_mfp_csv(csv_bytes)
