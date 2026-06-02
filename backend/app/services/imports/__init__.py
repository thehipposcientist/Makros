"""Data-import services for switching users from competitor apps.

Each subordinate module owns one source:
  - mfp_parser.py    — MyFitnessPal Food Diary CSV → ParsedMealRow
  - mfp_matcher.py   — ParsedMealRow → Thallo Food (USDA + AI fallback)
  - mfp_pipeline.py  — orchestrator: parse → match → idempotent Meal upsert

Strong (workouts), Strava (activities), Hevy, Cronometer, and the generic
CSV catch-all live alongside these as they're added.

Public surface intentionally narrow — routers import only the pipeline
orchestrators (`run_mfp_import`, `run_strong_import`, ...) and the
parsers stay pure-function for testability.
"""
