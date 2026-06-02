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
    assert include_backfills is False
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


def test_startup_maintenance_backfills_require_explicit_opt_in():
    enabled, include_backfills, include_seeds = startup_data_maintenance_settings({
        "STARTUP_DATA_MAINTENANCE_ENABLED": "1",
        "STARTUP_BACKFILLS_ENABLED": "1",
    })
    assert enabled is True
    assert include_backfills is True
    assert include_seeds is True
    print("PASS test_startup_maintenance_backfills_require_explicit_opt_in")


def test_startup_background_jobs_default_policy():
    config = startup_background_tasks_config({})
    # Startup should never call enrichment/backfill jobs. It only keeps
    # account retention cleanup configurable.
    assert config.purge_expired_soft_deletes is True
    print("PASS test_startup_background_jobs_default_policy")


def test_legacy_startup_backfill_flags_are_ignored():
    config = startup_background_tasks_config({
        "STARTUP_ENRICH_FOODS_ENABLED": "1",
        "FOOD_CLASSIFICATION_BACKFILL_ENABLED": "1",
        "STARTUP_ENRICH_EXERCISE_IMAGES_ENABLED": "1",
        "STARTUP_BACKFILL_MUSCLE_FATIGUE_ENABLED": "1",
        "GUT_BACKFILL_ENABLED": "1",
    })
    assert not hasattr(config, "enrich_food_micros")
    assert not hasattr(config, "backfill_food_classification")
    assert not hasattr(config, "backfill_gut_health")
    assert config.purge_expired_soft_deletes is True
    print("PASS test_legacy_startup_backfill_flags_are_ignored")


def test_startup_account_cleanup_can_be_disabled():
    config = startup_background_tasks_config({
        "ACCOUNT_HARD_DELETE_ENABLED": "0",
    })
    assert config.purge_expired_soft_deletes is False
    print("PASS test_startup_account_cleanup_can_be_disabled")


cases = [
    test_startup_maintenance_defaults_off,
    test_startup_maintenance_allows_explicit_partial_run,
    test_startup_maintenance_backfills_require_explicit_opt_in,
    test_startup_background_jobs_default_policy,
    test_legacy_startup_backfill_flags_are_ignored,
    test_startup_account_cleanup_can_be_disabled,
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
