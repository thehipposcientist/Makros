# Health Device Integrations — Apple Health, WHOOP, Garmin

## Current State

**Apple Health**: Implemented through the local `thallo-healthkit` module and `src/services/appleHealth.ts` / `healthDataSummary.ts`, with high-level callers moving through `src/services/platformHealth.ts`. Reads sleep, heart-rate signals, steps, workouts, active energy, weight, VO2, respiratory/O2/mindful/stand signals, menstrual-flow samples, and dietary calories/protein/carbs/fat when permissioned. Writes completed Thallo workouts, including outdoor-cardio route data when Thallo captured `routeCoords`. Detected Apple Health workouts can be imported into Thallo history and then feed progress/fatigue through the normal completion pipeline. Requires a development/native build; Expo Go cannot load this module.

**WHOOP**: Not integrated. WHOOP exposes data through Apple Health on iOS — so Apple Health integration covers most WHOOP data automatically.

**Health Connect**: Not yet implemented natively. `platformHealth.ts` now gives Android a Health Connect slot, but the Kotlin module, manifest permissions, Play Console declarations, and readers/writers still need to be built before Android tracker data reaches readiness, sleep, import, or calorie-adjustment paths.

**Garmin**: Direct API not integrated. Garmin Connect can share selected data to Apple Health on iOS, but direct Garmin Health API is still required for richer proprietary signals such as Body Battery, detailed stress, and training readiness.

---

## Apple Health (iOS)

### What We Already Have
- Local `modules/thallo-healthkit` Expo module
- HealthKit entitlements and usage strings in `app.json`
- Permission request flow in onboarding, Progress, and Settings
- `readHealthSummary()` / `healthDataSummary.ts` read the categories listed above
- `healthDataSummary.ts` pushes daily snapshots and sleep rows to the backend
- `workoutAutoImport.ts` / `DetectedWorkoutsCard` import detected Health workouts
- `saveWorkoutToHealth()` writes completed Thallo workouts back to Apple Health
- Outdoor-cardio sessions can include route coordinates from phone/Watch GPS; `saveWorkout` writes those through HealthKit's route builder when present

### What's Missing
1. **Background delivery** — get notified when new health data arrives without the user opening Thallo.
2. **Real-device QA** — verify denied/partial/granted permission states, workout write behavior, and detected-workout import on TestFlight builds.
3. **Direct Garmin/WHOOP APIs** — still not implemented; Apple Health remains the bridge for those users on iOS.

### How to Test on Your Phone

**Step 1: Create a development build**
```bash
# Install EAS CLI if you haven't
npm install -g eas-cli
eas login

# Create a development build for your physical device
eas build --platform ios --profile development
```
This takes ~15 minutes. You'll get a QR code or link to install the custom app on your phone.

**Step 2: Install on your iPhone**
- Scan the QR code from the EAS build
- Or download the .ipa from the Expo dashboard
- Trust the developer certificate: Settings > General > VPN & Device Management

**Step 3: Test HealthKit**
- Open the dev build on your phone
- Go through onboarding — the Apple Health permission prompt should appear
- After granting, go to Progress > Body Check — the fitness score should populate from your real health data
- Open the Health app on your phone and verify data categories show "Thallo" as a data source

**Step 4: Verify with fake data (Simulator)**
```bash
# Build for simulator
eas build --platform ios --profile development --simulator

# Install on simulator
# Open Health app in simulator > Browse > add sample data manually
```

### Historical Implementation Sketch: Auto-Import Workouts

The old sketch below is retained as context only. The current code path is `workoutAutoImport.ts` + `DetectedWorkoutsCard` + `saveWorkoutSession` / `logWorkoutDone`, not a fresh `importRecentWorkouts()` helper.

```typescript
export async function importRecentWorkouts(): Promise<WorkoutSession[]> {
  const hk = getHealthKit();
  if (!hk) return [];

  const yesterday = new Date(Date.now() - 48 * 3600000);
  return new Promise((resolve) => {
    hk.getSamples({
      typeIdentifier: 'HKWorkoutTypeIdentifier',
      startDate: yesterday.toISOString(),
      endDate: new Date().toISOString(),
    }, (err, results) => {
      if (err || !results?.length) { resolve([]); return; }
      // Map Apple Health workout types to Thallo categories
      const sessions = results.map(w => ({
        source: 'apple_health',
        category: mapWorkoutType(w.activityName),
        duration: w.duration / 60, // seconds to minutes
        calories: w.totalEnergyBurned,
        startDate: w.startDate,
      }));
      resolve(sessions);
    });
  });
}
```

### Implementation: Write Workouts to Apple Health

Add write permission for `Workout` in `HEALTH_PERMISSIONS`:
```typescript
write: ['Workout'],
```

After workout completion, save:
```typescript
export function writeWorkoutToHealth(focus: string, durationMinutes: number, calories: number) {
  const hk = getHealthKit();
  if (!hk) return;
  hk.saveWorkout({
    type: 'TraditionalStrengthTraining', // or map from focus
    startDate: new Date(Date.now() - durationMinutes * 60000).toISOString(),
    endDate: new Date().toISOString(),
    energyBurned: calories,
    energyBurnedUnit: 'calorie',
  }, (err) => { if (err) console.warn('[health] write failed:', err); });
}
```

---

## WHOOP

### How WHOOP Works
WHOOP doesn't have a public API for third-party apps. Instead, it syncs data TO Apple Health. If the user has a WHOOP and Apple Health integration enabled on their WHOOP app, the following data flows automatically:

| WHOOP Metric | Apple Health Category | Thallo Reads It? |
|-------------|----------------------|-------------------|
| Heart rate | HeartRate | Yes |
| Resting heart rate | RestingHeartRate | Yes |
| Sleep stages | SleepAnalysis | Yes |
| Strain (as workouts) | Workout | Yes (if auto-import wired) |
| Calories burned | ActiveEnergyBurned | Yes |
| HRV | HeartRateVariabilitySDNN | Yes |
| Recovery score | Not synced | No — WHOOP proprietary |

### What This Means
**You don't need a separate WHOOP integration.** Apple Health is the bridge. WHOOP users who enable Apple Health sync on their WHOOP app will automatically have their data flow into Thallo.

### What You Can't Get
- **WHOOP Recovery Score** — proprietary, not in Apple Health
- **WHOOP Strain Score** — proprietary, not in Apple Health
- **WHOOP journal entries** — proprietary, not in Apple Health

### HRV Reading

HRV is already part of the current HealthKit read set and `healthDataSummary` shape. The historical sketch below is retained as implementation context only. The permission token is:
```typescript
'HeartRateVariabilitySDNN',
```

Then add a reader:
```typescript
function readHRV(hk, start, end): Promise<number | null> {
  return new Promise((resolve) => {
    hk.getHeartRateVariabilitySamples(
      { startDate: start.toISOString(), endDate: end.toISOString(), ascending: false, limit: 7 },
      (err, results) => {
        if (err || !results?.length) { resolve(null); return; }
        const avg = results.reduce((s, r) => s + r.value, 0) / results.length;
        resolve(Math.round(avg));
      },
    );
  });
}
```

HRV is a strong recovery signal — higher = more recovered. WHOOP users typically have accurate HRV data.

### Testing WHOOP + Thallo
1. Build a development build (same as Apple Health above)
2. On your WHOOP app: Settings > Apple Health > enable all categories
3. Wear your WHOOP for a day so it syncs data
4. Open Thallo dev build — the health summary should show WHOOP-sourced data
5. Verify: open Apple Health > Browse > Heart > Sources — you should see both "WHOOP" and "Thallo"

---

## Garmin

### How Garmin Works
Garmin Connect can share selected data to Apple Health when the user enables it. That covers useful basics like steps, sleep, heart rate, energy, weight, and workouts, but it does not make Garmin a full HealthKit peer: GPS routes are not written to Apple Health and timed-activity heart-rate detail may be reduced.

Full Garmin integration requires:

1. **Garmin Health API** — partnership-gated OAuth flow
2. **Garmin webhook ingestion** — Garmin pushes dailies, sleeps, activities, stress, HRV, and related summaries after approval

### Option A: Garmin → Apple Health Sharing (Easy)
Users can enable Garmin Connect sharing to Apple Health. Once that is running, Thallo reads the supported Garmin data through Apple Health — no custom Garmin integration needed for baseline readiness/activity signals.

**Recommendation:** Document this as the first setup step for Garmin users rather than building a Garmin API integration.

### Option B: Direct Garmin API (Complex)

**Requirements:**
1. Apply for Garmin Health API access at https://developer.garmin.com/health-api/overview/
2. Garmin reviews your app and grants API credentials (weeks-to-months timeline)
3. Implement OAuth2 flow on your backend
4. Garmin sends webhook pushbacks when new data arrives

**Data Available via Garmin Health API:**
| Metric | Endpoint |
|--------|----------|
| Daily summary (steps, calories, HR) | `/dailies` |
| Sleep | `/sleeps` |
| Activities/workouts | `/activities` |
| Body composition | `/bodyCompositions` |
| Stress | `/stressDetails` |
| HRV | `/hrvs` |
| Pulse Ox | `/pulseOx` |

**Backend Implementation:**
```python
# backend/app/services/garmin.py

GARMIN_OAUTH_URL = "https://connectapi.garmin.com/oauth-service/oauth"
GARMIN_API_URL = "https://apis.garmin.com/wellness-api/rest"

@router.get("/garmin/authorize")
def garmin_authorize(current_user):
    # Redirect user to Garmin OAuth consent screen
    ...

@router.get("/garmin/callback")
def garmin_callback(oauth_token, oauth_verifier):
    # Exchange for access token, store per user
    ...

@router.post("/garmin/webhook")
def garmin_webhook(body):
    # Garmin pushes data updates here
    # Parse activities, sleep, HR and feed into fatigue system
    ...
```

**Timeline:** 2-4 weeks for API approval + 1-2 weeks implementation.

### Testing Garmin (Option A — via Apple Health)
1. User enables Garmin Connect sharing to Apple Health.
2. User syncs their Garmin device in Garmin Connect.
3. Thallo reads the supported synced data through Apple Health.
4. Verify workout route/detailed activity-HR gaps separately; those are expected limitations.

### Testing Garmin (Option B — Direct API)
1. Apply for Garmin Health API access
2. Get sandbox credentials
3. Use Garmin's test data tool to simulate device data
4. Point webhook to your local backend (use ngrok for tunneling)

---

## Recommended Integration Order

| Priority | Integration | Effort | Impact |
|----------|------------|--------|--------|
| 1 | Apple Health auto-import | 1-2 days | High — covers Apple Watch, WHOOP, and bridged Garmin users |
| 2 | Write workouts to Apple Health | 2 hours | Medium — Thallo workouts appear in Health app |
| 3 | HRV trend surfacing | 1 day | Medium — the reader exists; the remaining work is clearer trend UI and coaching context |
| 4 | Garmin via Apple Health bridge | 0 hours (docs only) | Medium — tell Garmin users to install Health Sync |
| 5 | Direct Garmin API | 2-4 weeks | Low — only needed if you want Garmin users without iOS |

## Key Insight

**Apple Health is the universal bridge.** By building a strong Apple Health integration, you automatically support:
- Apple Watch
- WHOOP (syncs to Apple Health)
- Oura Ring (syncs to Apple Health)
- Garmin (via Health Sync bridge)
- Peloton (syncs to Apple Health)
- Any other app that writes to HealthKit

Build Apple Health well and you cover 90% of wearable users without any device-specific code.

---

## Testing Checklist

- [ ] Create EAS development build (`eas build --platform ios --profile development`)
- [ ] Install on physical iPhone
- [ ] Grant HealthKit permissions during onboarding
- [ ] Verify resting HR, steps, sleep, HRV, active energy, workout minutes, weight, nutrition summaries, and cycle-aware signals populate where permissioned
- [ ] Complete a workout in Thallo → verify it appears in Apple Health
- [ ] Complete a workout in Apple Health / Watch / another app → verify Thallo detects and can import it
- [ ] If WHOOP user: verify WHOOP data flows through Apple Health to Thallo
- [ ] If Garmin user: verify Garmin → Health Sync → Apple Health → Thallo pipeline
