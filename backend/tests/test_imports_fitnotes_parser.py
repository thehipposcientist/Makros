"""Pure-function tests for the FitNotes workout CSV parser.

Run from inside the container:
    docker exec -it thallo-backend python -m tests.test_imports_fitnotes_parser
"""
from __future__ import annotations

from datetime import date

from app.services.imports.fitnotes_parser import (
    _parse_duration_seconds,
    group_sets_by_session,
    parse_fitnotes_csv,
)


def assert_eq(actual, expected, label: str) -> None:
    assert actual == expected, f"{label}: got {actual!r}, expected {expected!r}"
    print(f"  ✓ {label}")


def assert_in(needle, haystack, label: str) -> None:
    assert needle in haystack, f"{label}: {needle!r} not in {haystack!r}"
    print(f"  ✓ {label}")


def _bytes(s: str) -> bytes:
    return s.encode("utf-8")


_IOS_FORMAT = (
    "Date,Exercise,Category,Weight (kg),Weight (lbs),Reps,Distance,Distance Unit,Time,Notes,Kind\n"
    "2026-05-08,Bench Press,Chest,,135,10,,,,Felt good,wr\n"
    "2026-05-08,Bench Press,Chest,,155,8,,,,,wr\n"
    "2026-05-08,Plank,Abs,,,,,,01:30,Hard,t\n"
    "2026-05-09,Treadmill,Cardio,,,,3.1,mi,30:00,Easy,dt\n"
    "2026-05-09,Empty Row,Other,,,,,,,,wr\n"
)


def test_ios_format_basic() -> None:
    print("[test] FitNotes iOS-style CSV parses")
    result = parse_fitnotes_csv(_bytes(_IOS_FORMAT))
    assert_eq(len(result.sets), 4, "4 real sets parsed")
    assert_eq(result.skipped_count, 1, "empty metric row skipped")
    assert_eq(result.errors, [], "no errors")

    first = result.sets[0]
    assert_eq(first.workout_date, date(2026, 5, 8), "date")
    assert_eq(first.workout_name, "FitNotes", "session label")
    assert_eq(first.exercise_name, "Bench Press", "exercise")
    assert_eq(first.category, "Chest", "category")
    assert_eq(first.weight_value, 135.0, "lbs weight")
    assert_eq(first.weight_unit, "lbs", "lbs unit")
    assert_eq(first.reps, 10, "reps")
    assert_eq(first.kind, "wr", "kind")
    assert_eq(first.notes, "Felt good", "notes")


def test_kg_column_preferred_when_lbs_empty() -> None:
    print("[test] kg column is honored")
    csv_text = (
        "Date,Exercise,Category,Weight (kg),Weight (lbs),Reps\n"
        "2026-05-08,Deadlift,Back,100,,5\n"
    )
    result = parse_fitnotes_csv(_bytes(csv_text))
    assert_eq(result.sets[0].weight_value, 100.0, "kg weight")
    assert_eq(result.sets[0].weight_unit, "kg", "kg unit")


def test_android_style_headers() -> None:
    print("[test] simpler Android-style headers parse")
    csv_text = (
        "Date,Exercise,Category,Weight,Reps,Distance,Distance Unit,Time,Comment\n"
        "05/08/2026,Pushups,Chest,0,25,,,,bodyweight\n"
        "05/08/2026,Rowing,Cardio,,,2000,m,08:30,\n"
    )
    result = parse_fitnotes_csv(_bytes(csv_text))
    assert_eq(len(result.sets), 2, "2 rows parsed")
    assert_eq(result.sets[0].weight_value, 0.0, "bodyweight zero kept")
    assert_eq(result.sets[0].reps, 25, "reps-only row kept")
    assert_eq(result.sets[0].notes, "bodyweight", "comment alias")
    assert_eq(result.sets[1].distance_value, 2000.0, "distance")
    assert_eq(result.sets[1].distance_unit, "m", "distance unit")
    assert_eq(result.sets[1].duration_seconds, 510, "mm:ss duration")


def test_group_by_date_session() -> None:
    print("[test] rows group by FitNotes date")
    result = parse_fitnotes_csv(_bytes(_IOS_FORMAT))
    groups = group_sets_by_session(result.sets)
    assert_eq(len(groups), 2, "2 date sessions")
    assert_eq(len(groups[(date(2026, 5, 8), "FitNotes")]), 3, "May 8 has 3 sets")
    assert_eq(len(groups[(date(2026, 5, 9), "FitNotes")]), 1, "May 9 has 1 set")


def test_duration_parsing_variants() -> None:
    print("[test] FitNotes time formats")
    assert_eq(_parse_duration_seconds("01:01:01"), 3661, "hh:mm:ss")
    assert_eq(_parse_duration_seconds("23:59"), 1439, "mm:ss")
    assert_eq(_parse_duration_seconds("5 min"), 300, "5 min")
    assert_eq(_parse_duration_seconds("90"), 90, "bare seconds")
    assert_eq(_parse_duration_seconds(""), None, "empty")


def test_missing_required_columns() -> None:
    print("[test] missing Date/Exercise → error not crash")
    result = parse_fitnotes_csv(_bytes("Category,Weight\nChest,135\n"))
    assert_eq(result.sets, [], "no sets")
    assert_in("missing required columns", result.errors[0], "error message")


def test_empty_file() -> None:
    print("[test] empty file → error noted")
    result = parse_fitnotes_csv(b"")
    assert_eq(result.sets, [], "no sets")
    assert_in("empty file", result.errors[0], "empty file error")


def test_bad_date_records_error() -> None:
    print("[test] bad date → error, other rows still parse")
    csv_text = (
        "Date,Exercise,Weight,Reps\n"
        "2026-05-08,Bench,135,10\n"
        "garbage,Bench,155,8\n"
        "2026-05-09,Squat,225,5\n"
    )
    result = parse_fitnotes_csv(_bytes(csv_text))
    assert_eq(len(result.sets), 2, "good rows parsed")
    assert_eq(len(result.errors), 1, "one bad date error")
    assert_in("garbage", result.errors[0], "error mentions value")


if __name__ == "__main__":
    test_ios_format_basic()
    test_kg_column_preferred_when_lbs_empty()
    test_android_style_headers()
    test_group_by_date_session()
    test_duration_parsing_variants()
    test_missing_required_columns()
    test_empty_file()
    test_bad_date_records_error()
    print("\n✅ test_imports_fitnotes_parser.py PASSED")
