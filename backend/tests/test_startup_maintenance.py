"""Startup maintenance gates.

Schema migrations may run at startup, but data scans/backfills/seeds
should only run when an operator explicitly enables them.
"""
from __future__ import annotations

from app.database import startup_data_maintenance_settings
from app.main import startup_background_tasks_config


def test_startup_maintenance_defaults_off():
    enabled, include_backfills, include_seeds = startup_data_maintenance_settings({})
    assert enabled is False
    assert include_backfills is True
    assert include_seeds is True
    print("PASS test_startup_maintenance_defaults_off")


def test_startup_maintenance_allows_explicit_partial_run():
    enabled, include_backfills, include_seeds = startup_data_maintenance_settings({
        "STARTUP_DATA_MAINTENANCE_ENABLED": "1",
        "STARTUP_BACKFILLS_ENABLED": "0",
        "STARTUP_SEEDS_ENABLED": "1",
    })
    assert enabled is True
    assert include_backfills is False
    assert include_seeds is True
    print("PASS test_startup_maintenance_allows_explicit_partial_run")


def test_startup_background_jobs_default_to_no_data_scans():
    config = startup_background_tasks_config({})
    assert config.enrich_food_micros is False
    assert config.enrich_exercise_images is False
    assert config.backfill_muscle_fatigue is False
    assert config.backfill_gut_health is False
    assert config.purge_expired_soft_deletes is True
    print("PASS test_startup_background_jobs_default_to_no_data_scans")


def test_startup_background_jobs_allow_explicit_opt_in():
    config = startup_background_tasks_config({
        "STARTUP_ENRICH_FOODS_ENABLED": "1",
        "STARTUP_ENRICH_EXERCISE_IMAGES_ENABLED": "1",
        "STARTUP_BACKFILL_MUSCLE_FATIGUE_ENABLED": "1",
        "GUT_BACKFILL_ENABLED": "1",
        "ACCOUNT_HARD_DELETE_ENABLED": "0",
    })
    assert config.enrich_food_micros is True
    assert config.enrich_exercise_images is True
    assert config.backfill_muscle_fatigue is True
    assert config.backfill_gut_health is True
    assert config.purge_expired_soft_deletes is False
    print("PASS test_startup_background_jobs_allow_explicit_opt_in")


cases = [
    test_startup_maintenance_defaults_off,
    test_startup_maintenance_allows_explicit_partial_run,
    test_startup_background_jobs_default_to_no_data_scans,
    test_startup_background_jobs_allow_explicit_opt_in,
]


if __name__ == "__main__":
    failures = 0
    for case in cases:
        try:
            case()
        except Exception as exc:
            failures += 1
            print(f"FAIL {case.__name__}: {exc}")
    raise SystemExit(0 if failures == 0 else 1)
