"""Pure-function tests for the Strong app workout CSV parser.

Run from inside the container:
    docker exec -it thallo-backend python -m tests.test_imports_strong_parser
"""
from __future__ import annotations

from datetime import date

from app.services.imports.strong_parser import (
    parse_strong_csv,
    group_sets_by_session,
    _parse_duration_seconds,
)


def assert_eq(actual, expected, label: str) -> None:
    assert actual == expected, f"{label}: got {actual!r}, expected {expected!r}"
    print(f"  ✓ {label}")


def assert_in(needle, haystack, label: str) -> None:
    assert needle in haystack, f"{label}: {needle!r} not in {haystack!r}"
    print(f"  ✓ {label}")


def _bytes(s: str) -> bytes:
    return s.encode("utf-8")


# Modern Strong export header + 2 sessions, mix of strength + cardio + rpe.
_MODERN = (
    "Date,Workout Name,Duration,Exercise Name,Set Order,Weight,Weight Unit,"
    "Reps,RPE,Distance,Distance Unit,Seconds,Notes,Workout Notes\n"
    "2026-05-08 09:30:00,Push Day,45m,Bench Press,1,135,lbs,10,7,,,,warm-up,Felt strong\n"
    "2026-05-08 09:30:00,Push Day,45m,Bench Press,2,185,lbs,8,8.5,,,,,Felt strong\n"
    "2026-05-08 09:30:00,Push Day,45m,Bench Press,3,205,lbs,5,9,,,,,Felt strong\n"
    "2026-05-08 09:30:00,Push Day,45m,Incline Dumbbell Press,1,50,lbs,12,7,,,,,Felt strong\n"
    "2026-05-09 10:00:00,Run,30m,Treadmill Run,1,,,,,3.1,mi,1800,,Easy pace\n"
    "2026-05-10 11:00:00,Rest Test,5m,Stretch,1,0,lbs,0,,,,,,empty placeholder\n"
)


def test_modern_format_basic():
    print("[test] modern Strong export parses cleanly")
    result = parse_strong_csv(_bytes(_MODERN))
    # 5 real sets — placeholder zero-row dropped.
    assert_eq(len(result.sets), 5, "5 sets parsed")
    assert_eq(result.skipped_count, 1, "placeholder set skipped")
    assert_eq(result.errors, [], "no errors")

    first = result.sets[0]
    assert_eq(first.workout_date, date(2026, 5, 8), "date trimmed of time")
    assert_eq(first.workout_name, "Push Day", "workout name")
    assert_eq(first.exercise_name, "Bench Press", "exercise name")
    assert_eq(first.weight_value, 135.0, "weight")
    assert_eq(first.weight_unit, "lbs", "unit from explicit col")
    assert_eq(first.reps, 10, "reps")
    assert_eq(first.rpe, 7.0, "rpe")
    assert_eq(first.workout_duration_seconds, 45 * 60, "duration 45m → 2700s")


def test_cardio_row():
    print("[test] cardio row has distance + seconds")
    result = parse_strong_csv(_bytes(_MODERN))
    cardio = [s for s in result.sets if "Treadmill" in s.exercise_name][0]
    assert_eq(cardio.distance_value, 3.1, "distance mi")
    assert_eq(cardio.distance_unit, "mi", "distance unit")
    assert_eq(cardio.duration_seconds, 1800, "30 min in seconds")
    assert_eq(cardio.weight_value, None, "no weight on cardio")
    assert_eq(cardio.reps, None, "no reps on cardio")


def test_group_by_session():
    print("[test] grouping by (date, workout_name)")
    result = parse_strong_csv(_bytes(_MODERN))
    groups = group_sets_by_session(result.sets)
    assert_eq(len(groups), 2, "2 distinct sessions")
    push = groups[(date(2026, 5, 8), "Push Day")]
    assert_eq(len(push), 4, "4 sets in Push Day session")
    run = groups[(date(2026, 5, 9), "Run")]
    assert_eq(len(run), 1, "1 set in Run session")


def test_legacy_format_no_weight_unit():
    print("[test] legacy format without Weight Unit column")
    csv_text = (
        "Date,Workout Name,Exercise Name,Set Order,Weight,Reps,Distance,Seconds,Notes,Workout Notes,Workout Duration\n"
        "2026-05-08,Pull Day,Deadlift,1,225,5,,,,,1h\n"
        "2026-05-08,Pull Day,Deadlift,2,275,3,,,,,1h\n"
    )
    result = parse_strong_csv(_bytes(csv_text))
    assert_eq(len(result.sets), 2, "both sets parsed")
    assert_eq(result.sets[0].weight_value, 225.0, "weight from value")
    assert_eq(result.sets[0].weight_unit, "lbs", "default lbs when no col")
    assert_eq(result.sets[0].workout_duration_seconds, 3600, "1h → 3600s")


def test_duration_parsing_variants():
    print("[test] duration formats")
    assert_eq(_parse_duration_seconds("30m"), 1800, "30m")
    assert_eq(_parse_duration_seconds("1h 15m"), 75 * 60, "1h 15m")
    assert_eq(_parse_duration_seconds("1:15:00"), 4500, "h:mm:ss")
    assert_eq(_parse_duration_seconds("75"), 4500, "bare 75 = 75 min")
    assert_eq(_parse_duration_seconds("3600"), 3600, "bare 3600 = 3600 sec")
    assert_eq(_parse_duration_seconds(""), None, "empty → None")
    assert_eq(_parse_duration_seconds("garbage"), None, "garbage → None")


def test_date_with_time_strips_time():
    print("[test] date column with time component")
    csv_text = (
        "Date,Workout Name,Exercise Name,Set Order,Weight,Reps\n"
        "2026-05-08 14:30:00,Push,Bench,1,135,10\n"
        "2026-05-08T14:30:00,Push,Bench,2,135,8\n"
    )
    result = parse_strong_csv(_bytes(csv_text))
    assert_eq(len(result.sets), 2, "both rows parsed despite time differences")
    assert_eq(result.sets[0].workout_date, date(2026, 5, 8), "space-separated time")
    assert_eq(result.sets[1].workout_date, date(2026, 5, 8), "T-separated time")


def test_kg_weight_unit():
    print("[test] kg weight unit honored")
    csv_text = (
        "Date,Workout Name,Exercise Name,Set Order,Weight,Weight Unit,Reps\n"
        "2026-05-08,Push,Bench,1,80,kg,10\n"
    )
    result = parse_strong_csv(_bytes(csv_text))
    assert_eq(result.sets[0].weight_unit, "kg", "kg recognized")
    assert_eq(result.sets[0].weight_value, 80.0, "value preserved")


def test_distance_with_embedded_unit():
    print("[test] distance like '5 km' gets value off")
    csv_text = (
        "Date,Workout Name,Exercise Name,Set Order,Distance\n"
        "2026-05-08,Run,Outdoor Run,1,5.2 km\n"
    )
    result = parse_strong_csv(_bytes(csv_text))
    assert_eq(result.sets[0].distance_value, 5.2, "value parsed off 5.2 km")


def test_missing_required_columns():
    print("[test] missing Date/Exercise → error not crash")
    csv_text = (
        "Workout Name,Set Order\n"
        "Push,1\n"
    )
    result = parse_strong_csv(_bytes(csv_text))
    assert_eq(result.sets, [], "no sets")
    assert_in("missing required columns", result.errors[0], "error message")


def test_empty_file():
    print("[test] empty file → error noted")
    result = parse_strong_csv(b"")
    assert_eq(result.sets, [], "no sets")
    assert_in("empty file", result.errors[0], "empty file error")


def test_set_order_default_when_missing():
    print("[test] Set Order missing → auto-assigned by row index")
    csv_text = (
        "Date,Workout Name,Exercise Name,Weight,Reps\n"
        "2026-05-08,Push,Bench,135,10\n"
        "2026-05-08,Push,Bench,145,8\n"
    )
    result = parse_strong_csv(_bytes(csv_text))
    assert_eq(result.sets[0].set_order, 1, "first set order 1")
    assert_eq(result.sets[1].set_order, 2, "second set order 2")


def test_warmup_marker_is_imported():
    print("[test] Strong 'W' warmup marker is imported, not skipped")
    csv_text = (
        "Date,Workout Name,Exercise Name,Set Order,Weight,Reps\n"
        "2026-05-08,Push,Bench,W,45,12\n"
        "2026-05-08,Push,Bench,1,135,8\n"
    )
    result = parse_strong_csv(_bytes(csv_text))
    assert_eq(len(result.sets), 2, "warmup + working set parsed")
    assert_eq(result.skipped_count, 0, "warmup not skipped")
    assert_eq(result.sets[0].set_type, "warmup", "warmup marker captured")
    assert_eq(result.sets[0].weight_value, 45.0, "warmup weight kept")


def test_unparseable_date_records_error():
    print("[test] bad date → error, other rows still parse")
    csv_text = (
        "Date,Workout Name,Exercise Name,Weight,Reps\n"
        "2026-05-08,Push,Bench,135,10\n"
        "garbage,Push,Bench,145,8\n"
        "2026-05-09,Pull,Row,95,12\n"
    )
    result = parse_strong_csv(_bytes(csv_text))
    assert_eq(len(result.sets), 2, "good rows parsed")
    assert_eq(len(result.errors), 1, "one error for bad date")
    assert_in("garbage", result.errors[0], "error mentions value")


if __name__ == "__main__":
    test_modern_format_basic()
    test_cardio_row()
    test_group_by_session()
    test_legacy_format_no_weight_unit()
    test_duration_parsing_variants()
    test_date_with_time_strips_time()
    test_kg_weight_unit()
    test_distance_with_embedded_unit()
    test_missing_required_columns()
    test_empty_file()
    test_set_order_default_when_missing()
    test_warmup_marker_is_imported()
    test_unparseable_date_records_error()
    print("\n✅ test_imports_strong_parser.py PASSED")
