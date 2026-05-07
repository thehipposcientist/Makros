# Tech Stack & Deployment Strategy

## Current Tech Stack

### Frontend
| Technology | Version | Why |
|-----------|---------|-----|
| **React Native** | 0.81.5 | Cross-platform mobile (iOS + Android from one codebase) |
| **Expo SDK** | ~54 | Managed workflow — handles native builds, OTA updates, push notifications without touching Xcode/Android Studio directly |
| **expo-router** | ~6.0.23 | File-based routing — simpler than React Navigation for this app's structure |
| **TypeScript** | ~5.9.2 | Type safety across the entire frontend |
| **AsyncStorage** | 2.2.0 | Local persistence for plans, history, preferences |

### Backend
| Technology | Version | Why |
|-----------|---------|-----|
| **FastAPI** | 0.115.6 | Python async API — fast, typed, auto-docs at /docs |
| **SQLModel** | 0.0.37 | SQLAlchemy + Pydantic in one — typed ORM for PostgreSQL |
| **PostgreSQL** | 16 | Production-grade relational DB — handles complex queries for history, performance profiles |
| **Docker Compose** | — | Local dev: 2 containers (backend + DB). Same setup scales to production |

### AI / External Services
| Service | Purpose | Cost |
|---------|---------|------|
| **OpenAI gpt-4o-mini** | Nutrition plans, coach chat, text parsing/search fallback | Low-cost text model |
| **OpenAI gpt-5.4-mini** | Dedicated image-analysis endpoints (food, supplement, equipment, form, body scans) | $0.75/1M input, $4.50/1M output |
| **USDA FoodData Central** | Food nutrition search (primary) | Free (1000 req/hr) |
| **wger.de** | Exercise images + exercise search | Free |
| **OpenFoodFacts** | Barcode lookup for packaged foods | Free |

### Key Native Dependencies
| Package | Purpose | Expo Go? | Needs Native Build? |
|---------|---------|----------|-------------------|
| expo-camera | Barcode scanning | Yes | No |
| expo-haptics | Tactile feedback | Yes | No |
| expo-notifications | Push notifications | Yes | No |
| expo-image-picker | Food photo scanning | Yes | No |
| expo-secure-store | Token storage | Yes | No |
| react-native-gesture-handler | Swipe gestures | Yes | No |
| react-native-reanimated | Animations | Yes | No |
| react-native-svg | SVG rendering | Yes | No |
| thallo-healthkit | Apple Health bridge | **No** | **Yes — local native module** |
| thallo-watch-bridge | WCSession phone/watch bridge | **No** | **Yes — local native module + Watch target** |
| thallo-live-activity | ActivityKit rest timer Live Activity | **No** | **Yes — local native module + widget target** |

## Will Expo Work for Production?

**Yes.** Expo is used by major apps (Discord, Shopify, Coinbase). Here's what matters:

### What Works in Expo Go (Development)
JS-only UI iteration and backend-connected flows that do not touch custom native modules. Expo Go cannot load the local `thallo-*` modules, Watch targets, ActivityKit Live Activity, Apple Health bridge, or entitlement-dependent native flows.

### What Requires a Development Build
Apple Health, Watch sync, Live Activity rest timers, Apple Sign In, and the local `thallo-healthkit` / `thallo-watch-bridge` / `thallo-live-activity` modules require an **EAS Development Build** or `npx expo run:ios` so the native code and targets are compiled into the app.

### What Requires a Production Build
App Store submission requires a production IPA/APK built through **EAS Build**. This is Expo's build service — you push code, they build the native binary in the cloud and give you the file to submit.

## Deployment Strategy

### Phase 1: TestFlight (Internal Testing)

```bash
# 1. Install EAS CLI
npm install -g eas-cli

# 2. Login to Expo account
eas login

# 3. Configure the project
eas build:configure

# 4. Build for iOS (TestFlight)
eas build --platform ios --profile preview

# 5. Submit to TestFlight
eas submit --platform ios
```

**What you need:**
- Apple Developer account ($99/year)
- App Store Connect set up
- App icon (1024x1024 PNG) and splash screen
- Privacy policy URL

**Timeline:** First TestFlight build takes ~30 min. After that, OTA updates push in seconds.

### Phase 2: App Store Submission

```bash
# Production build
eas build --platform ios --profile production

# Submit to App Store review
eas submit --platform ios --latest
```

**App Store requirements:**
- App icon, screenshots (6.7" and 5.5" at minimum)
- Privacy policy, terms of service
- App description, keywords, category (Health & Fitness)
- HealthKit usage descriptions (already in app.json)
- Camera usage description (for barcode scanning)

### Phase 3: Android (Google Play)

```bash
# Build APK/AAB
eas build --platform android --profile production

# Submit to Google Play
eas submit --platform android
```

**Note:** Thallo's current Health integration is iOS-only through `thallo-healthkit`. Android would need a Health Connect module/path later.

## Backend Deployment

### Option A: Railway (Recommended for MVP)
- One-click Docker deploy from GitHub
- PostgreSQL add-on included
- $5/month for hobby tier
- Auto-deploys on git push
- Free SSL

```bash
# railway.toml
[deploy]
  dockerfile = "backend/Dockerfile"
  startCommand = "uvicorn app.main:app --host 0.0.0.0 --port 8000"

[environments.production.variables]
  DATABASE_URL = "${{Postgres.DATABASE_URL}}"
```

### Option B: Render
- Similar to Railway, free tier available
- PostgreSQL free for 90 days, then $7/month
- Auto-deploy from GitHub

### Option C: AWS (Scale Later)
- ECS Fargate for the FastAPI container
- RDS for PostgreSQL
- More complex, more control
- Only worth it at 10k+ users

### Option D: VPS (Cheapest)
- DigitalOcean/Hetzner $6-12/month
- Run Docker Compose directly
- You manage updates, backups, SSL

### Recommended Path
**Railway for launch.** Move to AWS when you have revenue and need to optimize costs at scale.

## Environment Configuration

### Production .env (Backend)
```bash
SECRET_KEY=<64-char random string>
ALGORITHM=HS256
ACCESS_TOKEN_EXPIRE_MINUTES=10080

OPENAI_API_KEY=<your key>
USDA_FDC_API_KEY=<your key from fdc.nal.usda.gov>

# Current production defaults
MODEL_PLAN_GENERATION=gpt-4o-mini
MODEL_CHAT=gpt-4o-mini
MODEL_MEAL_PARSING=gpt-4o-mini
MODEL_IMAGE=gpt-5.4-mini

PLAN_REVIEW_ENABLED=0
NUTRITION_REVIEW_ENABLED=0
```

### Production app.json additions needed
```json
{
  "expo": {
    "ios": {
      "bundleIdentifier": "com.thallo.app",
      "buildNumber": "1",
      "supportsTablet": false,
      "infoPlist": {
        "NSCameraUsageDescription": "Thallo uses the camera to scan food barcodes and take food photos for nutrition tracking.",
        "NSHealthShareUsageDescription": "...",
        "NSHealthUpdateUsageDescription": "..."
      }
    },
    "android": {
      "package": "com.thallo.app",
      "versionCode": 1,
      "adaptiveIcon": {
        "foregroundImage": "./assets/images/adaptive-icon.png",
        "backgroundColor": "#0D0F14"
      }
    }
  }
}
```

## EAS Configuration

Create `eas.json` in project root:

```json
{
  "cli": {
    "version": ">= 5.0.0"
  },
  "build": {
    "development": {
      "developmentClient": true,
      "distribution": "internal",
      "ios": {
        "simulator": true
      }
    },
    "preview": {
      "distribution": "internal",
      "ios": {
        "simulator": false
      }
    },
    "production": {
      "autoIncrement": true
    }
  },
  "submit": {
    "production": {
      "ios": {
        "appleId": "sawyerhannel8@gmail.com",
        "ascAppId": "<from App Store Connect>",
        "appleTeamId": "<your team ID>"
      }
    }
  }
}
```

## OTA Updates (Post-Launch)

Expo's biggest advantage: **JavaScript updates push instantly** without going through App Store review.

```bash
# Push a JS-only update to all users
eas update --branch production --message "Fixed meal tracking bug"
```

**What can be OTA updated:** All JavaScript/TypeScript code, styles, images, assets.
**What requires a new native build:** New native modules, Expo SDK upgrades, native config changes.

In practice, 95% of your updates will be OTA — only new native dependencies need a full rebuild.

## Pre-Launch Checklist

- [ ] Get USDA API key (replace DEMO_KEY)
- [ ] Generate production SECRET_KEY
- [ ] Design app icon (1024x1024)
- [ ] Design splash screen (1284x2778)
- [ ] Create Apple Developer account ($99/year)
- [ ] Set up App Store Connect
- [ ] Write privacy policy
- [ ] Add Sentry error monitoring
- [ ] Create `eas.json`
- [ ] Run `eas build:configure`
- [ ] Build first TestFlight
- [ ] Test on real device via TestFlight
- [ ] Prepare App Store screenshots
- [ ] Submit for App Store review

## Cost Summary (MVP Launch)

| Item | Monthly Cost |
|------|-------------|
| Apple Developer | $8.25 ($99/year) |
| Railway backend | $5 |
| Railway PostgreSQL | included |
| OpenAI API | ~$5-20 (depends on users) |
| USDA API | Free |
| wger.de | Free |
| OpenFoodFacts | Free |
| EAS Build | Free tier (30 builds/month) |
| Sentry | Free tier |
| **Total** | **~$18-33/month** |
