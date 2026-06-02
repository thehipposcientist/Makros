from __future__ import annotations

from datetime import date, timedelta
from types import SimpleNamespace


def _row(night_date: date, hours: float, score: int | None = None):
    return SimpleNamespace(night_date=night_date, total_hours=hours, score=score)


def test_sleep_pressure_waits_for_enough_nights() -> None:
    from app.services.health.sleep_pressure import compute_sleep_pressure

    today = date(2026, 5, 24)
    rows = [_row(today - timedelta(days=i), 6.5) for i in range(3)]
    result = compute_sleep_pressure(rows, as_of=today)

    assert result.status == "not_enough_data"
    assert result.sleep_score_penalty == 0
    assert result.nights_count == 3


def test_sleep_pressure_clear_when_recent_sleep_covers_need() -> None:
    from app.services.health.sleep_pressure import compute_sleep_pressure

    today = date(2026, 5, 24)
    rows = [_row(today - timedelta(days=i), 8.0, 88) for i in range(10)]
    result = compute_sleep_pressure(rows, as_of=today)

    assert result.status == "clear"
    assert result.pressure_hours < 0.5
    assert result.sleep_score_penalty == 0
    assert result.sleep_need_hours == 8.0


def test_sleep_pressure_caps_display_and_penalty_for_stacked_short_sleep() -> None:
    from app.services.health.sleep_pressure import compute_sleep_pressure

    today = date(2026, 5, 24)
    rows = [_row(today - timedelta(days=i), 6.0, 55) for i in range(10)]
    result = compute_sleep_pressure(rows, as_of=today)

    assert result.status == "high"
    assert result.pressure_hours > result.display_hours
    assert result.display_hours == 8.0
    assert result.is_capped is True
    assert 1 <= result.sleep_score_penalty <= 18


def test_sleep_pressure_gives_limited_catchup_credit() -> None:
    from app.services.health.sleep_pressure import compute_sleep_pressure

    today = date(2026, 5, 24)
    short_rows = [_row(today - timedelta(days=i), 6.25, 65) for i in range(8)]
    catchup_rows = short_rows + [
        _row(today - timedelta(days=8), 8.75, 86),
        _row(today - timedelta(days=9), 8.75, 87),
    ]

    short = compute_sleep_pressure(short_rows, as_of=today)
    catchup = compute_sleep_pressure(catchup_rows, as_of=today)

    assert catchup.pressure_hours < short.pressure_hours
    assert catchup.pressure_hours >= 0


cases = [
    test_sleep_pressure_waits_for_enough_nights,
    test_sleep_pressure_clear_when_recent_sleep_covers_need,
    test_sleep_pressure_caps_display_and_penalty_for_stacked_short_sleep,
    test_sleep_pressure_gives_limited_catchup_credit,
]
