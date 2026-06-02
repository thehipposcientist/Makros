# Wearable integrations

Thallo's wearable framework is in `backend/app/services/integrations/`.
It is a thin provider-registry pattern: every wearable subclasses
`WearableProvider`, the router (`/integrations/{provider}/...`) is
generic, and the frontend renders a uniform "Connect / Connected /
Coming soon" tile grid from `GET /integrations`.

## Provider status at a glance

| Provider | OAuth | Sync | Status |
|---|---|---|---|
| **Strava** | ✅ | ✅ | Wired via `app/strava_oauth.py`. Set `STRAVA_CLIENT_ID` + `STRAVA_CLIENT_SECRET`. |
| **Fitbit** | scaffold | stub | Easiest non-Strava to bring up — self-serve dev registration. |
| **Oura** | scaffold | stub | Self-serve at cloud.ouraring.com. |
| **WHOOP** | scaffold | stub | Requires partner agreement. |
| **Garmin** | scaffold | stub | Uses OAuth 1.0a — partner agreement required. |

"scaffold" = the `WearableProvider` class exists and the OAuth URL
builder is implemented. "stub" = `exchange_code`, `refresh`, `sync`
raise `NotImplementedError` until credentials land. The frontend
correctly renders these as "Coming soon" because `is_configured`
returns False without env vars.

## Adding a new provider end-to-end

1. **Register the OAuth app** with the provider. Capture client-id +
   client-secret. Configure the callback URL to
   `https://<your-api>/integrations/<provider>/callback`.

2. **Set env vars** in `backend/.env`:
   ```
   FITBIT_CLIENT_ID=...
   FITBIT_CLIENT_SECRET=...
   FITBIT_REDIRECT_URI=https://api.thallo.app/integrations/fitbit/callback
   ```

3. **Fill in the provider class** in
   `backend/app/services/integrations/<provider>.py`:
   - `is_configured` already checks env vars — usually no edit needed.
   - `authorize_url(state)` — usually already implemented for OAuth 2.0
     providers (scaffold builds the URL).
   - `exchange_code(code)` — POST to the provider's token endpoint and
     convert the response into a `TokenSet`.
   - `refresh(refresh_token)` — same, with `grant_type=refresh_token`.
   - `sync(db, user_id, credential, since)` — fetch new activity /
     health rows and write into existing tables (`WorkoutCompletion`,
     `DailyHealthSnapshot`, `SleepLog`). Must be idempotent.

4. **Done.** The router automatically picks up the new implementation:
   - `GET /integrations` lists it with `"configured": true`
   - `GET /integrations/<slug>/authorize` returns the OAuth URL
   - Provider callback hits `GET /integrations/<slug>/callback`
   - `POST /integrations/<slug>/sync` runs the data import
   - `DELETE /integrations/<slug>` revokes

## Per-provider data mapping

When implementing `sync()`, map the provider's payload into the
existing Thallo tables. Use these mappings as the canonical target:

### Activities → `WorkoutCompletion`
| Field | Source |
|---|---|
| `workout_date` | activity start date in user's tz |
| `duration_seconds` | activity total duration |
| `distance_miles` | converted from meters |
| `activity_category` | `"cardio"` (default) or `"strength"` |
| `activity_subtype` | `"run"`, `"ride"`, `"swim"`, `"row"`, ... |
| `calories_burned` | provider estimate |
| `hr_summary` | `{ "avgBpm": ..., "maxBpm": ..., "zoneMinutes": [Z1..Z5] }` |
| `cardio_load` | computed from `hr_summary` via `compute_cardio_load` — set automatically when `hr_summary` is present, see `_completion_hr_summary` |
| `external_source_id` | provider's activity id (for idempotency) |
| `import_source` | provider slug |

### Sleep → `SleepLog`
| Field | Source |
|---|---|
| `sleep_date` | wake date |
| `total_minutes` | total time asleep |
| `deep_minutes` | deep stage |
| `rem_minutes` | REM stage |
| `score` | provider's sleep score (0-100) |

### Daily health → `DailyHealthSnapshot`
| Field | Source |
|---|---|
| `snapshot_date` | calendar day |
| `resting_hr` | morning RHR |
| `hrv_avg` | nightly HRV |
| `vo2_max` | provider's estimate when available |
| `readiness_score` | Oura / WHOOP / Garmin's daily score |

## Idempotency rules

- `WorkoutCompletion` already has `external_source_id` + `import_source`;
  do an upsert on `(user_id, external_source_id)` to avoid duplicates
  on re-sync.
- `SleepLog` should use `(user_id, sleep_date)` as the natural key.
- `DailyHealthSnapshot` is already `(user_id, snapshot_date)` unique.

If a provider sends partial data (e.g. updates a previously-imported
activity with HR data that arrived late), prefer **merge** over
**replace** — null incoming fields don't overwrite existing values.

## Privacy + auth posture

- Refresh tokens are bearer credentials. The `IntegrationCredential`
  table encrypts them via `app/field_encryption.py` — never log them.
- The CSRF state nonce expires after 10 minutes. Stored in-process; OK
  for dev/single-replica. Move to Redis when we scale horizontally.
- Disconnecting a provider sets `status='revoked'` rather than deleting
  the row, so previously-imported activities retain attribution.
- Account deletion (`DELETE /profile/account`) deletes
  `IntegrationCredential` rows owned by the user.

## Not a wearable, but adjacent

- **Apple Health** is read via HealthKit on-device; no OAuth needed.
  Lives in `modules/thallo-healthkit` and is wired through Onboarding
  and Settings.
- **Apple Watch** is real-time companion, not a sync provider. See
  `docs/architecture/apple-watch.md`.
