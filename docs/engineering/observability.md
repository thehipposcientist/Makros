# Observability

The app and backend ship with a thin observability layer that **no-ops by
default** and lights up when you install the relevant SDKs + set env vars.
This file documents what's wired and what you need to flip the switches.

## Layers

| Layer | Frontend | Backend |
|---|---|---|
| **Crashes / errors** | `src/services/observability.ts` (Sentry) | `backend/app/observability.py` (Sentry) |
| **Funnel analytics** | `src/services/analytics.ts` (typed events → `/telemetry/events`) | `ClientTelemetryEvent` table |
| **Per-route latency** | n/a | `LatencyLoggerMiddleware` (logs `slow_route` over budget) |
| **AI usage / cost** | n/a | `AIUsageEvent` table (already shipped) |

## Frontend — Sentry

Install:
```bash
npx expo install @sentry/react-native
```

Set `EXPO_PUBLIC_SENTRY_DSN` in your env (and EAS secrets for production
builds). The `src/services/observability.ts` module auto-detects both
and initializes Sentry on first import. Until both are present every
call (`captureException`, `addBreadcrumb`, `setUser`) is a silent no-op
— safe to call freely from any code path.

Key call sites that should already be wired (search for them):
- `setUser(user)` on sign-in, `setUser(null)` on sign-out
- `captureException(err, ctx)` inside any `try/catch` that swallows an
  error we don't want to lose
- `addBreadcrumb({...})` happens automatically for every `analytics.*`
  call — no need to add them manually

## Frontend — Analytics taxonomy

Use the typed helpers in `src/services/analytics.ts` for every product-
meaningful event. Examples:

```ts
analytics.signupComplete({ method: 'apple', user_id: 123, token });
analytics.firstWorkoutLogged({ source: 'plan', token });
analytics.coachActionApply({ action: 'bump_calories', token });
```

Every call:
1. Posts to `/telemetry/events` (lands in `client_telemetry_events`)
2. Drops a Sentry breadcrumb (when Sentry is installed) so crashes
   carry funnel context

Add a new event by appending to the `EventName` union + the helper
record in `analytics.ts`. Do **not** add raw `recordTelemetryEvent()`
calls from product code — they bypass the breadcrumb sink and skip the
type checker.

## Backend — Sentry

Install:
```bash
echo 'sentry-sdk[fastapi]>=2.0' >> backend/requirements.txt
docker compose build backend
```

Set `SENTRY_DSN` in `backend/.env`. `init_observability(app)` runs at
boot (it's wired in `main.py`) and is a no-op without both deps + env.

Optional knobs:
- `SENTRY_TRACES_SAMPLE_RATE` — default `0.05` (5% perf trace sample)
- `APP_ENV` — `production` / `staging` / `development`
- `APP_VERSION` — release tag, picked up by Sentry's Releases feature

To capture an exception manually:

```python
from app.observability import capture_exception
try:
    ...
except Exception as e:
    capture_exception(e, route='/foo', user_id=current_user.id)
    raise
```

## Backend — Per-route latency

Always on (no SDK required). The `LatencyLoggerMiddleware` times every
request and writes a `slow_route` warning when the route exceeds its
budget. Budgets are in `observability.py:_LATENCY_BUDGETS_MS`:

| Path prefix | Budget |
|---|---|
| `/meals/score` | 800 ms |
| `/workouts/weekly-review` | 1500 ms |
| `/ai/fitness/composite-score` | 1500 ms |
| `/ai/*` | 3000 ms |
| `/coach/*` | 3000 ms |
| `/meals/*` | 600 ms |
| `/workouts/*` | 600 ms |
| everything else | 1200 ms |

Grep `slow_route` in logs to see hotspots:

```bash
docker compose logs backend | grep slow_route
```

## Optional — PostHog

The `src/services/analytics.ts` interface is shaped to accept a third
sink (PostHog or similar) without changing call sites. To wire it up:

1. `npx expo install posthog-react-native`
2. Set `EXPO_PUBLIC_POSTHOG_KEY`
3. Inside `_track()` in `analytics.ts`, add a third `posthog.capture(event, payload)` call alongside the existing telemetry + Sentry fans.

The existing `/telemetry/events` warehouse stays the source of truth —
PostHog gives you a funnels/dashboards UI without owning the data.

## What's intentionally NOT here

- **OpenTelemetry distributed tracing** — overkill for a single-service
  backend. Add when you split into more than one Python service.
- **Custom dashboards** — Sentry's UI covers crashes; PostHog or Mode
  covers product funnels. Don't build your own.
- **APM** — Sentry's `tracesSampleRate` is enough until you outgrow it.
