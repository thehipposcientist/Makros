"""FitNotes workout CSV parser.

Pure-function parser for FitNotes workout exports. FitNotes iOS documents
the header:

    Date,Exercise,Category,Weight (kg),Weight (lbs),Reps,Distance,
    Distance Unit,Time,Notes,Kind

Android exports vary a little more, but the same core fields are present
with simpler names such as Weight, Reps, Distance, Time, and Comments.
The importer groups rows by date because FitNotes CSV exports do not carry
a stable workout/session name.
"""

from __future__ import annotations

import csv
import io
import re
from dataclasses import dataclass
from datetime import date, datetime


@dataclass(frozen=True)
class ParsedFitNotesSet:
    row_index: int
    workout_date: date
    workout_started_at: datetime | None
    workout_name: str | None
    workout_duration_seconds: int | None
    workout_notes: str | None
    category: str | None
    exercise_name: str
    set_order: int
    set_type: str | None
    weight_value: float | None
    weight_unit: str
    reps: int | None
    distance_value: float | None
    distance_unit: str | None
    duration_seconds: int | None
    notes: str | None
    kind: str | None


@dataclass(frozen=True)
class FitNotesParseResult:
    sets: list[ParsedFitNotesSet]
    skipped_count: int
    errors: list[str]


_HEADER_ALIASES: dict[str, tuple[str, ...]] = {
    "date": ("date", "workout date", "datetime", "start time"),
    "exercise": ("exercise", "exercise name", "name"),
    "category": ("category", "body part", "bodypart", "muscle group"),
    "weight_kg": ("weight kg", "weight kilograms", "kg"),
    "weight_lbs": ("weight lbs", "weight lb", "weight pounds", "weight pound", "lbs", "lb"),
    "weight": ("weight",),
    "reps": ("reps", "repetitions"),
    "distance": ("distance",),
    "distance_unit": ("distance unit", "distance units", "unit"),
    "time": ("time", "duration", "seconds"),
    "notes": ("notes", "note", "comment", "comments"),
    "kind": ("kind", "exercise kind", "type"),
}
_HEADER_LOOKUP: dict[str, str] = {
    alias: canonical
    for canonical, aliases in _HEADER_ALIASES.items()
    for alias in aliases
}


def _normalize_header(raw: str) -> str:
    s = raw.strip().lower()
    s = s.replace("(", " ").replace(")", " ").replace(",", " ")
    s = re.sub(r"[^a-z0-9 ]", "", s)
    s = re.sub(r"\s+", " ", s).strip()
    return _HEADER_LOOKUP.get(s, s)


_DATE_FORMATS_WITH_TIME: tuple[str, ...] = (
    "%Y-%m-%d %H:%M:%S",
    "%Y-%m-%d %H:%M",
    "%Y-%m-%dT%H:%M:%S",
)
_DATE_FORMATS_DATE_ONLY: tuple[str, ...] = (
    "%Y-%m-%d",
    "%m/%d/%Y",
    "%d/%m/%Y",
    "%m-%d-%Y",
    "%d-%m-%Y",
)


def _parse_datetime(raw: str) -> tuple[date, datetime | None] | None:
    raw = raw.strip()
    if not raw:
        return None
    for fmt in _DATE_FORMATS_WITH_TIME:
        try:
            dt = datetime.strptime(raw, fmt)
            return dt.date(), dt
        except ValueError:
            continue
    for fmt in _DATE_FORMATS_DATE_ONLY:
        try:
            return datetime.strptime(raw, fmt).date(), None
        except ValueError:
            continue
    head = raw.split(" ")[0].split("T")[0]
    for fmt in _DATE_FORMATS_DATE_ONLY:
        try:
            return datetime.strptime(head, fmt).date(), None
        except ValueError:
            continue
    return None


def _parse_float(raw: str | None) -> float | None:
    if raw is None:
        return None
    s = raw.strip()
    if not s or s.lower() in {"--", "-", "n/a", "null"}:
        return None
    m = re.match(r"^-?\d+(?:\.\d+)?", s)
    if not m:
        return None
    try:
        return float(m.group(0))
    except ValueError:
        return None


def _parse_int(raw: str | None) -> int | None:
    v = _parse_float(raw)
    return int(v) if v is not None else None


_DURATION_HMS_RE = re.compile(r"^(\d+):(\d+)(?::(\d+))?$")


def _parse_duration_seconds(raw: str | None) -> int | None:
    if raw is None:
        return None
    s = raw.strip().lower()
    if not s:
        return None

    m = _DURATION_HMS_RE.match(s)
    if m:
        h_or_m = int(m.group(1))
        mid = int(m.group(2))
        last = int(m.group(3)) if m.group(3) else None
        if last is not None:
            return h_or_m * 3600 + mid * 60 + last
        return h_or_m * 60 + mid

    total = 0
    matched_any = False
    hr = re.search(r"(\d+(?:\.\d+)?)\s*h", s)
    if hr:
        total += int(float(hr.group(1)) * 3600)
        matched_any = True
    mi = re.search(r"(\d+(?:\.\d+)?)\s*m", s)
    if mi:
        total += int(float(mi.group(1)) * 60)
        matched_any = True
    se = re.search(r"(\d+(?:\.\d+)?)\s*s\b", s)
    if se:
        total += int(float(se.group(1)))
        matched_any = True
    if matched_any:
        return total

    bare = _parse_float(s)
    return int(bare) if bare is not None else None


def _parse_distance_unit(raw: str | None) -> str | None:
    if raw is None:
        return None
    s = raw.strip().lower()
    if not s:
        return None
    aliases = {
        "mile": "mi",
        "miles": "mi",
        "kilometer": "km",
        "kilometers": "km",
        "metre": "m",
        "meter": "m",
        "metres": "m",
        "meters": "m",
        "yard": "yd",
        "yards": "yd",
        "feet": "ft",
        "foot": "ft",
        "inch": "in",
        "inches": "in",
    }
    return aliases.get(s, s)


def _parse_kind(raw: str | None) -> str | None:
    if raw is None:
        return None
    s = re.sub(r"[^a-z]", "", raw.strip().lower())
    return s or None


def _decode_csv(raw: bytes) -> str:
    for encoding in ("utf-8-sig", "utf-8", "latin-1"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw.decode("latin-1", errors="replace")


def _pick_weight(
    weight_kg: float | None,
    weight_lbs: float | None,
    generic_weight: float | None,
) -> tuple[float | None, str]:
    if weight_lbs not in (None, 0):
        return weight_lbs, "lbs"
    if weight_kg not in (None, 0):
        return weight_kg, "kg"
    if weight_lbs is not None:
        return weight_lbs, "lbs"
    if weight_kg is not None:
        return weight_kg, "kg"
    return generic_weight, "lbs"


def parse_fitnotes_csv(raw: bytes) -> FitNotesParseResult:
    text = _decode_csv(raw)
    reader = csv.reader(io.StringIO(text))

    try:
        header_row = next(reader)
    except StopIteration:
        return FitNotesParseResult(sets=[], skipped_count=0, errors=["empty file"])

    column_index: dict[str, int] = {}
    for i, raw_header in enumerate(header_row):
        canonical = _normalize_header(raw_header)
        column_index.setdefault(canonical, i)

    if "date" not in column_index or "exercise" not in column_index:
        return FitNotesParseResult(
            sets=[],
            skipped_count=0,
            errors=["missing required columns 'Date' and/or 'Exercise'"],
        )

    def cell(row: list[str], key: str) -> str | None:
        idx = column_index.get(key)
        if idx is None or idx >= len(row):
            return None
        v = row[idx]
        return v if v != "" else None

    sets: list[ParsedFitNotesSet] = []
    errors: list[str] = []
    skipped = 0

    for row_index, raw_row in enumerate(reader, start=1):
        if not any(c.strip() for c in raw_row):
            skipped += 1
            continue

        date_raw = (cell(raw_row, "date") or "").strip()
        parsed_dt = _parse_datetime(date_raw) if date_raw else None
        if parsed_dt is None:
            errors.append(f"row {row_index}: unparseable date {date_raw!r}")
            continue
        workout_date, workout_started_at = parsed_dt

        exercise_raw = (cell(raw_row, "exercise") or "").strip()
        if not exercise_raw:
            skipped += 1
            continue

        weight, weight_unit = _pick_weight(
            _parse_float(cell(raw_row, "weight_kg")),
            _parse_float(cell(raw_row, "weight_lbs")),
            _parse_float(cell(raw_row, "weight")),
        )
        reps = _parse_int(cell(raw_row, "reps"))
        distance = _parse_float(cell(raw_row, "distance"))
        duration_seconds = _parse_duration_seconds(cell(raw_row, "time"))

        if (weight in (None, 0)) and (reps in (None, 0)) and \
           (distance in (None, 0)) and (duration_seconds in (None, 0)):
            skipped += 1
            continue

        sets.append(ParsedFitNotesSet(
            row_index=row_index,
            workout_date=workout_date,
            workout_started_at=workout_started_at,
            workout_name="FitNotes",
            workout_duration_seconds=None,
            workout_notes=None,
            category=(cell(raw_row, "category") or None),
            exercise_name=exercise_raw,
            set_order=len(sets) + 1,
            set_type=None,
            weight_value=weight,
            weight_unit=weight_unit,
            reps=reps,
            distance_value=distance,
            distance_unit=_parse_distance_unit(cell(raw_row, "distance_unit")),
            duration_seconds=duration_seconds,
            notes=(cell(raw_row, "notes") or None),
            kind=_parse_kind(cell(raw_row, "kind")),
        ))

    return FitNotesParseResult(sets=sets, skipped_count=skipped, errors=errors)


def group_sets_by_session(
    sets: list[ParsedFitNotesSet],
) -> dict[tuple[date, str | None], list[ParsedFitNotesSet]]:
    out: dict[tuple[date, str | None], list[ParsedFitNotesSet]] = {}
    for s in sets:
        key = (s.workout_date, s.workout_name)
        out.setdefault(key, []).append(s)
    return out
