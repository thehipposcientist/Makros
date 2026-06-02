from __future__ import annotations

from sqlalchemy import func, or_
from sqlmodel import col

from app.models import WorkoutCompletion


_PRIVATE_COMPLETION_SOURCES = {
    "apple_health",
    "apple health",
    "apple-health",
    "healthkit",
    "health_kit",
    "import_apple_health",
    "apple_health_import",
}


def completion_is_shareable_to_social(
    *,
    source_context: str | None = None,
    activity_source: str | None = None,
    import_source: str | None = None,
) -> bool:
    values = {
        str(value).strip().lower()
        for value in (source_context, activity_source, import_source)
        if value is not None and str(value).strip()
    }
    return values.isdisjoint(_PRIVATE_COMPLETION_SOURCES)


def shareable_completion_filters():
    def not_private(column):
        return or_(column.is_(None), ~func.lower(column).in_(_PRIVATE_COMPLETION_SOURCES))

    return (
        not_private(col(WorkoutCompletion.source_context)),
        not_private(col(WorkoutCompletion.activity_source)),
        not_private(col(WorkoutCompletion.import_source)),
    )
