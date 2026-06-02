# Oura Ring — Direct API Integration Plan

Status: **Planned / not started.** Last updated: 2026-05-29.
Owner: TBD. Companion strategy doc: [`wearable-integrations.md`](./wearable-integrations.md).

## Why Oura is the recommended next iOS integration

1. **It fills the exact gap the Apple Health passthrough leaves.** HK sleep from third-party rings (notably WHOOP) is unreliable — stages often missing, delivered hours late, and no vendor sleep score. Oura's API returns **clean, staged sleep + Daily Sleep score + Daily Readiness + temperature deviation**, none of which are in HealthKit.
2. **Friendliest direct API of any wearable.** Self-serve developer registration (no approval queue), OAuth 2.0 authorization-code flow, REST/JSON, generous limits. Realistic build: **3–5 days**.
3. **High-value cohort.** Oura users are sleep/recovery-focused — precisely Thallo's readiness audience. They will notice if Thallo's readiness is weaker than the Oura app's.

> If **Android** is the higher priority instead, build **Health Connect** first — it has more reach per unit effort and is already specced in [`android-health-connect.md`](./android-health-connect.md). Oura is the iOS-only-next-cycle recommendation.

## API facts (verify against current Oura docs before building)

- Base: `https://api.ouraring.com/v2`
- Auth: OAuth 2.0 auth-code → access token + refresh token, **per user**. Authorize URL `https://cloud.ouraring.com/oauth/authorize`, token URL `https://api.ouraring.com/oauth/token`.
- Self-serve app registration at the Oura developer portal; set the redirect URI to a backend callback (not a deep link directly — see flow below).
- **No webhooks** — poll. A daily cron + an on-app-open opportunistic sync is enough.
- Key endpoints (all support `start_date` / `end_date`):
  - `GET /usercollection/daily_readiness` → readiness score, contributors, temperature deviation
  - `GET /usercollection/daily_sleep` → daily sleep **score** + contributors
  - `GET /usercollection/sleep` → per-period sleep sessions with **stages** (deep/REM/light/awake), latency, efficiency, HR/HRV during sleep
  - `GET /usercollection/daily_activity` → steps, active calories
  - `GET /usercollection/heartrate`, `/usercollection/workout`, `/usercollection/daily_spo2`
- Rate limits are generous; initial backfill fetch ~30 days at a time.

## Architecture — reuse, don't fork

Follow the rules in `wearable-integrations.md` → "Implementation Notes Common to All Direct APIs":

- **One credential table.** `IntegrationCredential(user_id, provider, access_token, refresh_token, expires_at, scope, status, last_sync_at)`, unique on `(user_id, provider)`. Tokens are bearer secrets — wrap with `app.field_encryption.encrypt_text` / `decrypt_text` exactly like the Strava path already does.
- **Reuse `DailyHealthSnapshot`** for normalized daily fields (sleep totals/stages, RHR, HRV, steps, active energy, respiratory). Do **not** create an `oura_daily` table for fields that already exist. Add only genuinely-new proprietary columns via idempotent `ADD COLUMN IF NOT EXISTS`:
  - `oura_readiness_score INT`, `oura_sleep_score INT`, `oura_temp_deviation_c FLOAT`
- **Provenance:** stamp `source="oura"` and populate `source_details.providers` / `source_details.fields` so Oura + Apple Health (+ future WHOOP) can contribute to the same day without clobbering each other. When both HK and Oura have a field, **prefer Oura for sleep stages + scores**, prefer the higher-fidelity source per field.

## Backend (FastAPI)

New router `backend/app/routers/integrations/oura.py`, registered in `main.py`:

```
GET  /integrations/oura/authorize   -> 302 to Oura authorize URL with state (CSRF) + PKCE
GET  /integrations/oura/callback    -> exchange code, encrypt+store tokens, 302 to thallo://settings/health?connected=oura
POST /integrations/oura/sync        -> on-demand sync for the signed-in user (used by app-open + manual "Sync now")
DELETE /integrations/oura           -> revoke + delete credential, surface "reconnect" state
```

- **Sync service** `backend/app/services/integrations/oura_sync.py`: refresh token if near expiry → fetch `daily_readiness`, `daily_sleep`, `sleep`, `daily_activity` since `last_sync_at` (default 30d on first run) → upsert into `DailyHealthSnapshot` with provenance → set `last_sync_at`. On refresh failure set `status="revoked"`.
- **Daily cron**: a daemon-thread loop in `main.py` (match the existing `_purge_expired_soft_deletes` pattern) that syncs all users with an active Oura credential. Do **not** do this per-request.
- **Tests** (register in `tests/run_all.py`): pure-function normalizer (Oura JSON → `DailyHealthSnapshot` shape), token-refresh-failure → revoked, provenance-merge precedence (Oura sleep beats HK sleep). No live network in tests — fixture the Oura payloads.

## Frontend (React Native)

- **Single "Connect external services" screen** in Settings (per the "what NOT to do" rules — don't add per-provider prompts scattered around). Row per provider with connected/disconnected state + last-sync age + reconnect CTA.
- Connect = open the backend `/integrations/oura/authorize` URL in an in-app browser (`expo-web-browser`); the backend callback deep-links back to `thallo://settings/health?connected=oura`.
- Readiness/sleep cards already read through the normalized snapshot, so once the backend writes Oura data they light up automatically. Add a small "via Oura" source chip where readiness/sleep is shown.
- `src/services/api.ts`: add `connectOura()` (returns authorize URL), `syncOura()`, `disconnectOura()`, `getIntegrationStatus()`. Update consumers per the API-contract rule.

## Companion: Sleep-source quality detection (do this regardless of Oura)

This is the cheap, high-leverage piece that makes the gap visible and drives connect conversions — and it helps WHOOP users *today*, before any direct integration ships.

- In the readiness/sleep computation path, classify the current HK sleep as **rich** (has stages + total) / **thin** (total only, no stages) / **missing**.
- When sleep is `thin` or `missing` for N of the last 7 days AND the user has no direct sleep provider connected, surface a one-line CTA on the Sleep/Readiness card: *"Connect Oura or WHOOP for full sleep data."* → deep-links to the Connect screen.
- Keep scoring on whatever data exists; just stop *silently* scoring on thin data. Add a confidence/"limited data" marker to the readiness score when inputs are thin (mirrors the existing min-signals gate pattern).

## Rollout / sequencing

1. Land `IntegrationCredential` table + the encrypted-token helpers (generalize from Strava).
2. Backend authorize/callback/sync + normalizer + tests.
3. Connect-services Settings screen + API methods.
4. Daily cron.
5. Sleep-source quality detection + CTA (can ship ahead of Oura — it only needs the HK classifier + Connect screen).
6. Beta with a handful of Oura users; verify provenance merge and that Oura sleep correctly supersedes HK sleep.

## Gotchas

- **Timestamps:** Oura reports in user-local date for daily summaries and ISO timestamps for sessions. Store UTC in the DB, render local in the client (per the common-notes rule).
- **Token refresh** must be graceful — never 500 a user request because a refresh failed; mark revoked + show reconnect.
- **Don't expose raw Oura payloads to the client** — normalize server-side; the client keeps reading through `healthDataSummary.ts` / the daily snapshot shape.
- **Backfill rate:** fetch ~30 days per call on first connect; don't loop a year of history synchronously.
