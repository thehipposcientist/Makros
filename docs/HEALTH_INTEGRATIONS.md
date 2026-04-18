# Health Device Integrations — Apple Health, WHOOP, Garmin

## Current State

**Apple Health**: Code exists (`src/services/appleHealth.ts`), permissions configured in `app.json`, reads resting HR, steps, sleep, workouts, active energy. NOT auto-importing workouts into the fatigue system yet. Requires a development build (won't work in Expo Go).

**WHOOP**: Not integrated. WHOOP exposes data through Apple Health on iOS — so Apple Health integration covers most WHOOP data automatically.

**Garmin**: Not integrated. Requires Garmin Connect API (OAuth2, webhook-based).

---

## Apple Health (iOS)

### What We Already Have
- `react-native-health` installed (v1.19.0)
- HealthKit entitlements in `app.json`
- Permission request flow in onboarding
- `readHealthSummary()` reads: resting HR, steps, sleep, workouts, active energy
- `healthScore.ts` computes a fitness score from the health data

### What's Missing
1. **Auto-import workouts** — when the user finishes a workout on their Apple Watch or another app, import it as a completed session and feed the fatigue system
2. **Write completed workouts** — save Thallo workouts back to Apple Health so they show in the Health app timeline
3. **Background delivery** — get notified when new health data arrives (currently `background-delivery` is set to `false`)

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

### Implementation: Auto-Import Workouts

To wire Apple Health workouts into the fatigue system, add to `appleHealth.ts`:

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
| HRV | HeartRateVariabilitySDNN | Not yet |
| Recovery score | Not synced | No — WHOOP proprietary |

### What This Means
**You don't need a separate WHOOP integration.** Apple Health is the bridge. WHOOP users who enable Apple Health sync on their WHOOP app will automatically have their data flow into Thallo.

### What You Can't Get
- **WHOOP Recovery Score** — proprietary, not in Apple Health
- **WHOOP Strain Score** — proprietary, not in Apple Health
- **HRV** — available in Apple Health but Thallo doesn't read it yet

### To Add HRV Reading
Add to `HEALTH_PERMISSIONS.read`:
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
Garmin uses a different approach — no Apple Health sync by default (Garmin Connect is a walled garden). Integration requires:

1. **Garmin Connect API** — OAuth2 server-to-server integration
2. **Garmin Health API** — requires a business partnership application

### Option A: Garmin → Apple Health Bridge (Easy)
Users can install **"Health Sync"** (third-party app, ~$3) that syncs Garmin Connect data to Apple Health. Once that's running, Thallo reads it through Apple Health — no custom Garmin integration needed.

**Recommendation:** Document this as a setup step for Garmin users rather than building a Garmin API integration.

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
1. User installs "Health Sync" app on iPhone
2. Configure it to sync Garmin → Apple Health
3. Thallo reads the synced data through Apple Health
4. No additional code needed in Thallo

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
| 3 | HRV reading | 1 hour | Medium — better recovery signal for WHOOP/Watch users |
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
- [ ] Verify resting HR, steps, sleep populate in fitness score
- [ ] Complete a workout in Thallo → verify it appears in Apple Health (after write is implemented)
- [ ] Complete a workout on Apple Watch → verify it auto-imports into Thallo (after auto-import is implemented)
- [ ] If WHOOP user: verify WHOOP data flows through Apple Health to Thallo
- [ ] If Garmin user: verify Garmin → Health Sync → Apple Health → Thallo pipeline
