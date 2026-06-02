# Wearable Integrations — Coverage, Cost, Recommendation Matrix

Last updated: 2026-05-24
Audience: product + engineering, when planning device support.

This is the strategic doc for "which wearables should Thallo invest in, in what order, and what will each cost to integrate?" The tactical Apple Health implementation guide lives at [`HEALTH_INTEGRATIONS.md`](../HEALTH_INTEGRATIONS.md); this doc is the planning lens on top.

## TL;DR

| Tier | Integration | Status | What it unlocks | When to invest |
|---|---|---|---|---|
| **1** | Apple Health (iOS) | ✅ Shipped | Apple Watch, WHOOP, Oura, Garmin Connect sharing, Polar, Peloton, any HK-writing app | Done — keep extending readers |
| **1** | Apple Watch native app | ✅ Shipped | First-party live workout, outdoor-cardio GPS/distance, complications, hydration, Smart Stack | Done — Siri intent stub is the gap |
| **2** | Health Connect (Android) | ⏳ Abstraction scaffolded / native reader not built | Wear OS, Fitbit/Google Health, Galaxy, Garmin Android, Pixel | Next Android health-sync investment |
| **3** | Oura Ring (direct API) | ❌ Not built | Oura's proprietary readiness, sleep score, temperature deviation — none in HK | Once iOS user count justifies; Oura's API is friendly |
| **4** | WHOOP (direct API) | ❌ Not built | Recovery, day strain, sleep performance + **clean sleep stages**, journal | **Re-rated higher:** WHOOP→Apple Health sleep is unreliable (stages often missing, delayed ~hours, no sleep score), so the gap is bigger than "just recovery." Start the dev-approval application early; build when a WHOOP cohort + paid tier exists |
| **4** | Garmin Health API | ❌ Not built | Stress, body battery, training readiness, VO2max history | Only if you sign a non-iOS Garmin cohort |
| **5** | Polar Accesslink, Suunto, Fitbit Web API | ❌ Not built | Marginal incremental users | Skip unless requested |
| **5** | Strava | ✅ Shipped | Activity import/backfill for runners/cyclists — not really a "wearable" but adjacent | Done for OAuth/backfill; tokens now use field encryption when configured |

**Strategic recommendation:** lean hard on Apple Health as the iOS aggregator and on Health Connect as the Android aggregator. Build direct integrations only when (a) the data you need *isn't* in the aggregator, AND (b) the user cohort with that device is large enough to justify weeks of OAuth + webhook + per-user backfill work.

---

## Currently Shipped

### Apple Health (HealthKit)
- Module: `modules/thallo-healthkit/`
- Service entry: `src/services/healthDataSummary.ts` (preferred over raw `readHealthSummary`)
- Backend: `/health/daily-summary`, `/health/sleep`, `/workouts/detected-import`
- Reads: sleep stages, RHR, HR, HRV, steps, workouts, active energy, weight, VO2 max, respiratory/O2/mindful/stand, menstrual-flow phase.
- Writes: completed Thallo workouts (`saveWorkoutToHealth`), including route data when captured, so they appear under "Other" workouts in the Health app alongside Watch / WHOOP / Garmin entries.
- Detects external workouts: `workoutAutoImport.ts` + `DetectedWorkoutsCard` lets a user import Watch/WHOOP/etc. workouts they didn't log in Thallo.
- See [`healthkit.md`](./healthkit.md) for the field map.

### Apple Watch (native SwiftUI app)
- Phone bridge: `modules/thallo-watch-bridge/` (WCSession)
- Watch app: `targets/thallo-watch/`
- Complication target: `targets/thallo-watch-complication/`
- Live workout, outdoor cardio distance/pace/GPS context, hydration +8 oz quick action, complications, Smart Stack widget links, App Group SharedDefaults for state mirror.
- See [`apple-watch.md`](./apple-watch.md).

### Android (Health Connect)
- Document-stage: [`android-health-connect.md`](./android-health-connect.md)
- Platform entry point: `src/services/platformHealth.ts` routes iOS to Apple Health and keeps Android on a Health Connect no-op until the native reader lands.
- Health Connect is Google's unified store for Android, analogous to HealthKit on iOS. Fitbit/Google Health, Galaxy Health, Garmin, Polar, and Wear OS apps can write here. Building the Health Connect reader once covers the same ground as the Apple Health work, for Android.
- Native module, manifest permissions, Play Console declarations, and Android readers are not yet implemented.

---

## Aggregators Beat Direct Integrations

Most wearables already write to one of two stores:

| Device | Apple Health (iOS) | Health Connect (Android) | Direct API |
|---|---|---|---|
| Apple Watch | ✅ first-party | n/a | n/a |
| WHOOP | ⚠️ HR/HRV/RHR/respiratory + asleep totals only — **sleep stages sync unreliably, no sleep-performance score, delivered ~hours late**; no recovery/strain | n/a | ✅ proprietary scores + reliable full sleep |
| Oura | ✅ (sleep/HR/HRV/temp/activity) | ✅ | ✅ readiness/sleep score |
| Garmin | ⚠️ Garmin Connect can share selected data to Apple Health; no GPS route/detailed activity HR | ✅ via Health Connect where supported | ✅ stress/body-battery/etc |
| Fitbit / Google Health | ⚠️ Apple Health path exists through Google/Fitbit account flows and may be limited | ✅ via Health Connect | ✅ but rate-limited |
| Polar | ✅ | ⚠️ partial | ✅ |
| Galaxy Watch / Samsung Health | ❌ | ✅ | ✅ Samsung Health SDK |
| Coros | ✅ | ✅ | ⚠️ limited |
| Suunto | ⚠️ | ⚠️ | ✅ |
| Amazfit / Zepp | ✅ | ✅ | ⚠️ |
| Pixel Watch / Wear OS | ❌ | ✅ | n/a |

The two columns to invest in are **Apple Health** and **Health Connect**. Direct device APIs only matter when the proprietary score / metric isn't in either aggregator AND a meaningful chunk of users want it.

---

## Per-Device Deep Dives

### Oura Ring — Direct API integration

**Why bother:** Oura's *Daily Readiness*, *Daily Sleep*, and *Temperature Deviation* scores are not in Apple Health. Oura users care a lot about those numbers; Thallo's readiness score would feel weaker than Oura's if we just used the HK passthrough data.

**Difficulty: Medium-Low (3-5 days)**
- Public OAuth 2.0 API at `https://api.ouraring.com/v2`
- Self-serve developer registration (no approval queue)
- Standard auth code flow → access + refresh token per user
- Endpoints: `daily_readiness`, `daily_sleep`, `daily_activity`, `heart_rate`, `workout`, `tag`
- No webhooks — must poll (recommended daily cron)

**Implementation sketch:**
```python
# backend/app/routers/integrations/oura.py
@router.get("/oura/authorize")
def oura_authorize(user):
    state = secrets.token_urlsafe(16)
    return RedirectResponse(f"https://cloud.ouraring.com/oauth/authorize?...&state={state}")

@router.get("/oura/callback")
def oura_callback(code, state):
    token = oura_exchange_code(code)
    save_oura_tokens(user.id, token)
    return RedirectResponse("thallo://settings/health")

# Daily cron / on user open:
def sync_oura(user):
    summary = oura_get("daily_readiness", since=user.last_oura_sync)
    UserHealthDailySummary.upsert(...)
```

**Recommendation:** Build when (a) Apple Health integration is rock-solid, (b) ≥5% of beta users have an Oura. Until then, the HK passthrough covers sleep + HR + HRV reasonably well.

### WHOOP — Direct API integration

**Why bother:** *Recovery score* and *Day Strain* are proprietary and not in HK. WHOOP users also expect Thallo to surface their journal entries.

**Difficulty: Medium (1-2 weeks, mostly waiting)**
- WHOOP Developer Platform: https://developer.whoop.com
- Required: business application + WHOOP review (takes 1-3 weeks)
- OAuth 2.0 after approval
- Endpoints: `/v1/recovery`, `/v1/cycle`, `/v1/sleep`, `/v1/workout`, `/v1/user/profile`
- Webhooks supported — they push recovery/strain at sleep wake

**Cost note:** WHOOP API is *free* for approved developers, but the approval queue is opaque and prioritizes apps with paying users and a clear business case.

**Recommendation:** Re-rated higher than the old "defer / HK gets 80%" stance. The HK passthrough gives WHOOP users HR / HRV / RHR / respiratory and *asleep totals*, but **sleep stages sync unreliably (often absent), arrive hours after wake, and WHOOP's Sleep Performance score is not in HK at all** — so for a recovery-centric app the real gap is *sleep quality* plus recovery/strain, not just recovery. Still gated by WHOOP's opaque approval queue (1–3 wks, favors apps with paying users), so: **start the developer application now** so the clock is running, and build once a WHOOP cohort + paid tier justifies it. Until then, detect thin/stage-less HK sleep and prompt a direct connect (see "Sleep-source quality detection" in [`oura-integration.md`](./oura-integration.md)).

### Garmin Health API

**Why bother:** Garmin users on iOS can share selected Garmin Connect data into Apple Health, but the pipe is limited: detailed activity heart-rate graphs and GPS routes do not come through, and Garmin-only signals like Body Battery, stress details, and training readiness remain proprietary. On Android, Garmin should be handled through Health Connect first.

**Difficulty: High (3-6 weeks)**
- Garmin Health API requires a business partnership application
- Approval timeline: 2-4 weeks minimum
- OAuth 1.0a (not 2.0) — older flow, harder to debug
- Webhook-based (Garmin pushes; you don't poll)
- Need a public webhook URL with verified TLS

**Endpoints:** `/dailies`, `/sleeps`, `/activities`, `/bodyCompositions`, `/stressDetails`, `/hrvs`, `/pulseOx`, plus user-permission management.

**Recommendation:** Skip the direct API for now. Use Apple Health on iOS where Garmin Connect sharing is enabled, ship Health Connect for Android Garmin users, and revisit Garmin Health API only if a major Garmin cohort wants proprietary readiness/stress signals.

### Fitbit / Google Fit

Fitbit is primarily Android and now sits under Google Health account flows. On Android, treat Health Connect as the first-party route for Fitbit/Google Health data rather than building against older Google Fit assumptions. iOS Fitbit users may still need the Apple Health/Google Health sharing path, and coverage can be more limited.

**Difficulty: Direct API = Medium (5-10 days)**, but pointless if Health Connect is shipping anyway.
- Fitbit Web API at `https://api.fitbit.com/1`
- OAuth 2.0
- Strict rate limits: 150 requests/hour per user (you'll hit it during initial backfill)
- Sleep, steps, HR, activities, weight, food (Fitbit also tracks meals)

**Recommendation:** Skip direct integration. Health Connect (Android) covers the cohort that matters. Revisit the direct API only for a clear Fitbit-heavy cohort or a gap that Health Connect cannot fill.

### Polar Accesslink

**Why bother:** Polar is popular in endurance / coached training segments. iOS users sync to Apple Health by default; Android sync is patchier.

**Difficulty: Low-Medium (3-5 days)**
- Self-serve dev portal
- OAuth 2.0
- Transactions-based API (you fetch a "transaction" containing new data)
- Daily activity, training sessions, sleep, physical info

**Recommendation:** Skip for now. Apple Health passthrough covers most Polar users on iOS adequately. Revisit if Thallo gets traction in coached endurance.

### Samsung Health / Galaxy Watch

Galaxy Watch writes to Samsung Health which writes to Health Connect on Android.

**Difficulty: Health Connect path = same as everything else**. Direct Samsung Health SDK = High (Samsung partnership required).

**Recommendation:** Health Connect only. Direct integration is not worth the partnership process.

### Coros, Suunto, Amazfit/Zepp

Niche. Skip unless a specific user requests it. Coros and Amazfit both push to Apple Health on iOS, which is sufficient.

### Strava (adjacent, not a wearable)

**Why bother:** Strava is the social/activity layer for runners and cyclists. Importing Strava activities would let Thallo recognize runs/rides as workouts for users who track cardio elsewhere.

**Difficulty: Low (2-3 days)**
- OAuth 2.0, self-serve
- Webhook + polling supported
- Read activities, segments, athlete stats
- Generous rate limits

**Recommendation:** Consider for the endurance/hybrid cohort once subscribers exist. See [`data-import.md`](./data-import.md) for the activity-import angle.

### Pixel Watch / Wear OS (Google's native watch platform)

Same pattern as Galaxy Watch — writes to Health Connect.

**Recommendation:** Health Connect only.

---

## Decision Framework

When deciding whether to build a direct integration for device X, ask:

1. **Does the aggregator already cover the data?** If yes → skip direct integration, just extend the aggregator reader.
2. **What % of beta users have device X?** Under 5% → skip. 5-15% → consider. >15% → build.
3. **Does device X expose a *proprietary score* users care about?** If yes (Oura readiness, WHOOP recovery, Garmin body battery) → direct integration eventually pays off. If no (just HR/sleep) → aggregator is fine.
4. **Is the API approval queue / business partnership reasonable?** Self-serve dev portals (Oura, Strava, Polar) are friendly. Approval-gated APIs (WHOOP, Garmin) cost weeks of calendar time.
5. **Will the integration require server cron jobs and refresh-token management?** Almost always yes. Budget per-integration ops, not just one-time build.

---

## Recommended Phased Sequence

**Phase 1 — Already shipped (iOS).**
Apple Health + Apple Watch native. Cover Apple Watch, WHOOP, Oura, Polar, Peloton, Coros, Amazfit users through the HK pipe.

**Phase 2 — Android parity (when Android beta is real).**
Build the Health Connect reader behind `src/services/platformHealth.ts`. Reuse the same backend `/health/snapshot`, `/health/snapshot/batch`, sleep, readiness, and workout-import paths. Single integration covers Wear OS, Fitbit/Google Health, Galaxy, Garmin Android, Polar Android.

**Phase 3 — Proprietary score parity.**
Direct Oura integration first (friendliest API, distinctive readiness score), then WHOOP (only after the approval comes through). Both should write normalized rows with `DailyHealthSnapshot.source_details` provenance instead of creating parallel data structures for shared fields.

**Phase 4 — Endurance cohort.**
Strava import for runs/rides. Garmin Health API only if needed for a partnership opportunity or a large Garmin cohort emerges.

**Phase 5 — Long tail.**
Skip unless explicitly requested. Polar Accesslink, Suunto, Coros direct, Samsung Health SDK.

---

## Implementation Notes Common to All Direct APIs

- **Store OAuth tokens encrypted** in a `IntegrationCredential` table keyed by `(user_id, provider)`. Refresh tokens are bearer credentials — treat like passwords. The Strava path now wraps reads/writes in `app.field_encryption.encrypt_text` / `decrypt_text` when a field-encryption key is configured.
- **Reuse `DailyHealthSnapshot` for normalized daily fields** instead of provider-specific summary tables. Use `source_details.providers` and `source_details.fields` to preserve per-field provenance when Apple Health/Health Connect and direct providers contribute to the same day. New proprietary columns (e.g. `oura_readiness_score`, `whoop_recovery`) can still be added via idempotent `ADD COLUMN IF NOT EXISTS` migrations.
- **Background sync** should be a daemon-thread cron in `main.py` (matching `_purge_expired_soft_deletes`), not per-request work.
- **Token refresh** must be graceful — when a user's refresh fails, mark `IntegrationCredential.status="revoked"` and surface a "reconnect" CTA in Settings.
- **Rate limits** matter on initial backfill. Most APIs let you fetch ~30 days at a time; budget accordingly.
- **Webhooks are nicer than polling** but require a stable public URL + signature verification. For Garmin specifically, webhook signing is mandatory.
- **Don't trust device timestamps**. Some providers report in user local time, others in UTC. Always store UTC in the DB; render in local in the client.

---

## What NOT to do

- Don't write a native module per device. The only native modules should be HealthKit (iOS) and Health Connect (Android). Everything else is server-side OAuth + REST.
- Don't expose raw provider data to clients. The backend normalizes into Thallo's existing daily-summary shape and the frontend reads through `healthDataSummary.ts`.
- Don't add a new permission prompt on the frontend for every provider. Use a single "Connect external services" screen in Settings.
- Don't ship a Garmin integration without a clear business reason — the approval process is slow and the iOS Garmin cohort is small enough that Health Sync is a fine answer.
