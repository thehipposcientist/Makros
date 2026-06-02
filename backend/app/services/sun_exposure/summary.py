from __future__ import annotations

from app.services.sun_exposure.calculation import SunExposureDailySummary


FORBIDDEN_COPY_FRAGMENTS = (
    "we know you were outside",
    "knows you were outside",
    "vitamin d dose",
    "safe sun exposure",
)


def build_summary_copy(summary: SunExposureDailySummary) -> list[str]:
    lines = [
        f"You had {round(summary.daylight_minutes)} daylight minutes today.",
        "The score uses daylight time, Apple light-intensity metadata when available, and UV Index.",
    ]
    if summary.morning_daylight_minutes >= 10 or summary.midday_daylight_minutes >= 10 or summary.afternoon_daylight_minutes >= 10:
        largest = max(
            ("morning", summary.morning_daylight_minutes),
            ("midday", summary.midday_daylight_minutes),
            ("later in the day", summary.afternoon_daylight_minutes),
            key=lambda item: item[1],
        )
        lines.insert(1, f"Most recorded daylight was {largest[0]} ({round(largest[1])} minutes).")
    if summary.very_high_uv_minutes >= 10:
        lines.insert(1, f"Recorded daylight included {round(summary.very_high_uv_minutes)} minutes at very high UV.")
    elif summary.high_uv_minutes >= 20:
        lines.insert(1, f"Recorded daylight included {round(summary.high_uv_minutes)} minutes at UV 3 or higher.")
    if summary.safety_message:
        lines.insert(1, summary.safety_message)
    return lines


def assert_sun_copy_is_safe(copy: str) -> None:
    lowered = copy.lower()
    for fragment in FORBIDDEN_COPY_FRAGMENTS:
        if fragment in lowered:
            raise ValueError(f"unsafe sun exposure copy: {fragment}")
