"""Pure-function tests for the MyFitnessPal CSV parser.

Run manually from inside the backend container:
    docker exec -it thallo-backend python -m tests.test_imports_mfp_parser

These tests don't touch the DB or Docker network — they just shove
synthetic CSV bytes at `parse_mfp_csv` and assert the structured output.
"""
from __future__ import annotations

import io
import zipfile
from datetime import date

from app.services.imports.mfp_parser import (
    parse_mfp_csv,
    parse_mfp_gdpr_zip,
    ParsedMealRow,
)


def assert_eq(actual, expected, label: str) -> None:
    assert actual == expected, f"{label}: got {actual!r}, expected {expected!r}"
    print(f"  ✓ {label}")


def assert_in(needle: str, haystack: str, label: str) -> None:
    assert needle in haystack, f"{label}: {needle!r} not in {haystack!r}"
    print(f"  ✓ {label}")


# ─── Fixtures ────────────────────────────────────────────────────────────────

# Modern 2024-era MFP export. UTF-8 with BOM, header order matches the
# official export, two days of entries, includes a TOTAL row and a
# blank trailing row.
_MFP_2024 = (
    "﻿Date,Meal,Food,Calories,Fat (g),Saturated Fat,Cholesterol (mg),"
    "Sodium (mg),Carbohydrates (g),Fiber,Sugar,Protein (g),Note\n"
    "2026-05-08,Breakfast,1 cup oatmeal,150,3,0.5,0,5,27,4,1,5,\n"
    "2026-05-08,Lunch,Grilled chicken salad,420,18,4,85,650,12,4,3,55,with vinaigrette\n"
    "2026-05-08,Dinner,Ribeye steak 8 oz,640,42,18,180,420,0,0,0,60,\n"
    "2026-05-08,Snacks,Greek yogurt,120,2,1,15,55,8,0,7,20,\n"
    "2026-05-08,,TOTAL,1330,65,23.5,280,1130,47,8,11,140,\n"
    "2026-05-09,Breakfast,3 eggs,210,15,5,540,180,1,0,0,18,\n"
    "2026-05-09,Lunch,Turkey wrap,480,15,4,55,820,55,5,4,32,\n"
    ",,,,,,,,,,,,\n"
)


def _bytes(s: str) -> bytes:
    return s.encode("utf-8")


# ─── Tests ───────────────────────────────────────────────────────────────────

def test_2024_format_basic():
    print("[test] 2024 format — basic parse")
    result = parse_mfp_csv(_bytes(_MFP_2024))
    assert_eq(len(result.rows), 6, "6 entries parsed (TOTAL + blank dropped)")
    assert_eq(result.skipped_count, 2, "TOTAL + blank row counted as skipped")
    assert_eq(result.errors, [], "no errors")

    first = result.rows[0]
    assert_eq(first.meal_date, date(2026, 5, 8), "date parsed")
    assert_eq(first.meal_type, "breakfast", "meal_type lowercased")
    assert_eq(first.food_name, "oatmeal", "quantity stripped from food name")
    assert_eq(first.quantity_text, "1 cup", "quantity captured")
    assert_eq(first.calories, 150.0, "calories")
    assert_eq(first.protein_g, 5.0, "protein")
    assert_eq(first.fat_g, 3.0, "fat")


def test_meal_type_normalization():
    print("[test] meal type variants normalize")
    csv_text = (
        "Date,Meal,Food,Calories\n"
        "2026-05-08,Snacks,Pretzels,100\n"
        "2026-05-08,Anytime,Coffee,5\n"
        "2026-05-08,Dinner,Pasta,500\n"
        "2026-05-08,SOMETHING_WEIRD,Mystery snack,200\n"
    )
    result = parse_mfp_csv(_bytes(csv_text))
    types = [r.meal_type for r in result.rows]
    assert_eq(types, ["snack", "snack", "dinner", "snack"], "all meal types")


def test_date_format_variants():
    print("[test] multiple date formats")
    csv_text = (
        "Date,Meal,Food,Calories\n"
        "2026-05-08,Breakfast,Yogurt,100\n"
        "5/8/2026,Lunch,Sandwich,400\n"
        "5/8/26,Dinner,Soup,300\n"
        "05-08-2026,Snacks,Apple,80\n"
        "\"May 8, 2026\",Snacks,Banana,90\n"
        "2026-05-08T18:30:00Z,Dinner,Soup,100\n"
    )
    result = parse_mfp_csv(_bytes(csv_text))
    dates = [r.meal_date for r in result.rows]
    assert_eq(dates, [date(2026, 5, 8)] * 6, "all 6 date forms collapse to same date")
    assert_eq(result.errors, [], "no errors despite mixed formats")


def test_unparseable_date_records_error():
    print("[test] bad date → error, not crash")
    csv_text = (
        "Date,Meal,Food,Calories\n"
        "2026-05-08,Breakfast,Yogurt,100\n"
        "garbage,Lunch,Sandwich,400\n"
    )
    result = parse_mfp_csv(_bytes(csv_text))
    assert_eq(len(result.rows), 1, "good row parsed")
    assert_eq(len(result.errors), 1, "one error recorded")
    assert_in("row 2", result.errors[0], "error names the row")
    assert_in("garbage", result.errors[0], "error includes the bad value")


def test_separate_quantity_column():
    print("[test] explicit quantity column preferred over embedded prefix")
    csv_text = (
        "Date,Meal,Food,Quantity,Calories,Protein (g)\n"
        "2026-05-08,Breakfast,Oatmeal,1.5 cup,225,7.5\n"
        "2026-05-08,Lunch,Chicken breast,6 oz,280,52\n"
    )
    result = parse_mfp_csv(_bytes(csv_text))
    assert_eq(result.rows[0].food_name, "Oatmeal", "food name unchanged when col present")
    assert_eq(result.rows[0].quantity_text, "1.5 cup", "quantity from column")
    assert_eq(result.rows[1].quantity_text, "6 oz", "quantity from column 2")


def test_number_parsing_tolerance():
    print("[test] number cell quirks")
    csv_text = (
        "Date,Meal,Food,Calories,Sodium (mg),Sugar,Fiber\n"
        "2026-05-08,Breakfast,Cereal,\"1,200\",450,<1,--\n"
    )
    result = parse_mfp_csv(_bytes(csv_text))
    row = result.rows[0]
    assert_eq(row.calories, 1200.0, "thousands separator")
    assert_eq(row.sodium_mg, 450.0, "plain integer")
    assert_eq(row.sugar_g, 0.5, "<1 collapses to 0.5 (trace)")
    assert_eq(row.fiber_g, None, "-- → None")


def test_missing_required_columns():
    print("[test] missing Date/Food columns → error not crash")
    csv_text = (
        "Meal,Food,Calories\n"
        "Breakfast,Oatmeal,150\n"
    )
    result = parse_mfp_csv(_bytes(csv_text))
    assert_eq(len(result.rows), 0, "no rows parsed")
    assert_in("missing required columns", result.errors[0], "error message")


def test_official_meal_level_nutrition_export_without_food_column():
    print("[test] official MFP nutrition CSV — meal-level, no Food column")
    csv_text = (
        "Date,Meal,Calories,Fat (g),Saturated Fat,Polyunsaturated Fat,"
        "Monounsaturated Fat,Trans Fat,Cholesterol,Sodium (mg),Potassium,"
        "Carbohydrates (g),Dietary Fiber (g),Sugars (g),Protein (g),Vitamin A,"
        "Vitamin C,Calcium,Iron,Note\n"
        "2026-05-08,Breakfast,350,10,2,0,0,0,20,300,120,45,6,12,20,0,0,0,0,eggs and oats\n"
        "2026-05-08,Lunch,600,22,5,0,0,0,80,900,300,55,8,9,42,0,0,0,0,\n"
        "2026-05-08,Daily Total,950,32,7,0,0,0,100,1200,420,100,14,21,62,0,0,0,0,\n"
    )
    result = parse_mfp_csv(_bytes(csv_text))
    assert_eq(len(result.rows), 2, "two meal summaries parsed")
    assert_eq(result.skipped_count, 1, "daily total skipped")
    first = result.rows[0]
    assert_eq(first.food_name, "MyFitnessPal Breakfast", "synthetic food name")
    assert_eq(first.quantity_text, "meal", "meal-level unit")
    assert_eq(first.fiber_g, 6.0, "Dietary Fiber (g) recognized")
    assert_eq(first.sugar_g, 12.0, "Sugars (g) recognized")
    assert_eq(first.protein_g, 20.0, "protein parsed")


def test_empty_file():
    print("[test] empty file → empty result, error noted")
    result = parse_mfp_csv(b"")
    assert_eq(result.rows, [], "no rows")
    assert_in("empty file", result.errors[0], "empty-file error")


def test_header_alias_variants():
    print("[test] header aliases — 'Fat' / 'Total Fat (g)' / 'Carbohydrates'")
    csv_text = (
        "Date,Meal Type,Description,kcal,Total Fat (g),Total Carbohydrate (g),protein g\n"
        "2026-05-08,Breakfast,Oatmeal,150,3,27,5\n"
    )
    result = parse_mfp_csv(_bytes(csv_text))
    assert_eq(len(result.rows), 1, "row parsed despite alias headers")
    row = result.rows[0]
    assert_eq(row.calories, 150.0, "kcal recognized as Calories")
    assert_eq(row.fat_g, 3.0, "Total Fat (g) recognized")
    assert_eq(row.carbs_g, 27.0, "Total Carbohydrate (g) recognized")
    assert_eq(row.protein_g, 5.0, "protein g recognized")


def test_gdpr_zip_extraction():
    print("[test] GDPR ZIP — extract Food_Diary.csv")
    csv_bytes = _bytes(_MFP_2024)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("MyFitnessPal_Export/Food_Diary.csv", csv_bytes)
        zf.writestr("MyFitnessPal_Export/Measurements.csv", b"date,weight\n2026-05-08,180\n")
    result = parse_mfp_gdpr_zip(buf.getvalue())
    assert_eq(len(result.rows), 6, "extracted + parsed 6 rows")


def test_zip_extracts_current_your_nutrition_file():
    print("[test] MFP ZIP — extract current Your Nutrition.csv")
    csv_bytes = _bytes(
        "Date,Meal,Calories,Fat (g),Carbohydrates (g),Protein (g)\n"
        "2026-05-08,Breakfast,350,10,45,20\n"
    )
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("MyFitnessPal Export/Your Exercise.csv", b"Date,Exercise\n")
        zf.writestr("MyFitnessPal Export/Your Progress.csv", b"Date,Weight\n")
        zf.writestr("MyFitnessPal Export/Your Nutrition.csv", csv_bytes)
    result = parse_mfp_gdpr_zip(buf.getvalue())
    assert_eq(len(result.rows), 1, "nutrition file selected")
    assert_eq(result.rows[0].food_name, "MyFitnessPal Breakfast", "meal summary parsed")


def test_gdpr_zip_missing_food_diary():
    print("[test] MFP ZIP — no nutrition CSV → error")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("Measurements.csv", b"date,weight\n")
    result = parse_mfp_gdpr_zip(buf.getvalue())
    assert_eq(result.rows, [], "no rows")
    assert_in("nutrition CSV", result.errors[0], "error mentions missing file")


def test_gdpr_zip_bad_zip():
    print("[test] not a real ZIP → error")
    result = parse_mfp_gdpr_zip(b"this is not a zip")
    assert_eq(result.rows, [], "no rows")
    assert_in("bad zip", result.errors[0], "error mentions bad zip")


def test_blank_food_name_skipped():
    print("[test] rows with empty Food field are skipped, not errored")
    csv_text = (
        "Date,Meal,Food,Calories\n"
        "2026-05-08,Breakfast,Oatmeal,150\n"
        "2026-05-08,Lunch,,0\n"
        "2026-05-09,Dinner,Pasta,500\n"
    )
    result = parse_mfp_csv(_bytes(csv_text))
    assert_eq(len(result.rows), 2, "blank-food row dropped")
    assert_eq(result.skipped_count, 1, "skip counted")
    assert_eq(result.errors, [], "not an error, just a skip")


def test_partial_macros_default_to_none():
    print("[test] missing macro cells → None, not 0")
    csv_text = (
        "Date,Meal,Food,Calories,Protein (g),Fat (g)\n"
        "2026-05-08,Breakfast,Mystery food,200,,\n"
    )
    result = parse_mfp_csv(_bytes(csv_text))
    row = result.rows[0]
    assert_eq(row.calories, 200.0, "calories present")
    assert_eq(row.protein_g, None, "protein empty → None")
    assert_eq(row.fat_g, None, "fat empty → None")
    assert_eq(row.sodium_mg, None, "sodium absent → None")


def test_food_name_with_brand_prefix_not_split():
    print("[test] '3 eggs' splits, 'Eggland's Best 3 eggs' doesn't")
    csv_text = (
        "Date,Meal,Food,Calories\n"
        "2026-05-08,Breakfast,3 eggs,210\n"
        "2026-05-08,Lunch,Eggland's Best - Large Egg,70\n"
    )
    result = parse_mfp_csv(_bytes(csv_text))
    assert_eq(result.rows[0].quantity_text, "3", "leading number split off")
    assert_eq(result.rows[0].food_name, "eggs", "food cleaned")
    assert_eq(result.rows[1].quantity_text, None, "brand-name leading word not split")
    assert_eq(result.rows[1].food_name, "Eggland's Best - Large Egg", "name unchanged")


def test_legacy_windows_encoding_does_not_crash():
    print("[test] Latin-1 / CP-1252 encoded export")
    # Em-dash in CP-1252 (0x97) — modern UTF-8 reads this as garbage,
    # but our fallback to Latin-1 lets it through without crashing.
    raw_cp1252 = (
        b"Date,Meal,Food,Calories\n"
        b"2026-05-08,Breakfast,Chef\x92s salad,250\n"
    )
    result = parse_mfp_csv(raw_cp1252)
    assert_eq(len(result.rows), 1, "row parsed despite encoding")
    assert_in("salad", result.rows[0].food_name.lower(), "salad survives roundtrip")


# ─── Runner ──────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    test_2024_format_basic()
    test_meal_type_normalization()
    test_date_format_variants()
    test_unparseable_date_records_error()
    test_separate_quantity_column()
    test_number_parsing_tolerance()
    test_missing_required_columns()
    test_official_meal_level_nutrition_export_without_food_column()
    test_empty_file()
    test_header_alias_variants()
    test_gdpr_zip_extraction()
    test_zip_extracts_current_your_nutrition_file()
    test_gdpr_zip_missing_food_diary()
    test_gdpr_zip_bad_zip()
    test_blank_food_name_skipped()
    test_partial_macros_default_to_none()
    test_food_name_with_brand_prefix_not_split()
    test_legacy_windows_encoding_does_not_crash()
    print("\n✅ test_imports_mfp_parser.py PASSED")
