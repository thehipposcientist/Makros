# Claude Rules — Testing

1. **Run tests after backend changes**: `make test` or `docker exec thallo-backend python -m tests.run_all`. Fix new failures before marking work done.

2. **No fixed pass count — compare before/after**: A handful of failures are flaky / environment-dependent (FatSecret network search, account-deletion DB state) and vary run to run. Run the suite before and after your change; only a NEW failure in an area you touched is a regression to fix.

3. **Register new test modules**: Add to `backend/tests/run_all.py`. Tests not in `run_all.py` will not run in CI.

4. **Prefer pure-function tests**: No DB setup, no Docker required, fast feedback loop. Target any deterministic service function.

5. **No DB mocking in integration tests**: Tests that hit the DB must hit a real DB (via Docker). Mock failures have historically masked real migration bugs.

6. **Test coverage priority**:
   - Deterministic planner logic (recipes, archetypes, slots, prescriptions)
   - Scoring functions (nutrition score, fatigue, fitness score)
   - Pure-function services (change_day_type, digest, rolling_e1rm, carb_distribution)
   - API smoke tests (happy path only — detailed logic is unit-tested)

7. **Avoid `test_api_smoke` regressions**: These tests require a running backend with a seeded DB. They catch import/startup errors. Don't break them with bad migrations.
