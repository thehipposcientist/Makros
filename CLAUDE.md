# WorkoutPal — CLAUDE.md

## Project Overview
React Native fitness app built with Expo SDK 54 and expo-router. Users complete an onboarding flow (goal, days/week, equipment, foods), then see a generated workout + nutrition plan on the home screen. All data is stored locally with AsyncStorage — no backend.

## Tech Stack
- **Expo SDK 54** with expo-router v4 (file-based routing via `app/` directory)
- **React Native 0.76.6** / React 18.3.1
- **TypeScript** throughout
- **AsyncStorage** for local persistence (no server/API)
- **No external UI library** — plain React Native StyleSheet

## File Structure
```
app/                    # expo-router pages (entry points)
  _layout.tsx           # Root Stack navigator, headerShown: false
  index.tsx             # Main logic: loads profile, routes to Onboarding or Home
src/
  screens/
    OnboardingScreen.tsx  # 4-step form: goal → days → equipment → foods
    HomeScreen.tsx        # Displays workout + nutrition plan, day selector
  components/
    WorkoutCard.tsx       # Blue card showing exercises (sets × reps, rest)
    NutritionCard.tsx     # Pink card showing meals and macros
  navigation/
    RootNavigator.tsx     # Legacy file — navigation now handled by expo-router
  utils/
    planGenerator.ts      # All plan logic — pure mock data, no API calls
  types/
    index.ts              # TypeScript interfaces (UserProfile, Exercise, etc.)
```

## Architecture Notes
- **Entry point**: `"main": "expo-router/entry"` in package.json — expo-router handles bootstrapping. `App.tsx` at root is not used.
- **Routing**: `app/index.tsx` checks AsyncStorage for a saved `userProfile`. If none → renders OnboardingScreen. If found → renders HomeScreen.
- **No navigation library**: expo-router's Stack handles the single-screen app. `src/navigation/RootNavigator.tsx` is a legacy file, not currently wired up.
- **Plan generation**: All workout/nutrition data is hardcoded mock logic in `planGenerator.ts`. No external API calls.

## Dev Commands
```bash
# Install dependencies (after any package.json change)
npm install

# Start Expo dev server
npx expo start

# If Expo Go on iPhone can't connect (firewall/network issue), use tunnel:
npx expo start --tunnel

# Clear Metro cache (use when seeing stale bundle errors)
npx expo start --clear

# Fix dependency version mismatches
npx expo install --fix
```

## Expo Go on iPhone — Troubleshooting
1. **Same WiFi** — Phone and PC must be on the same network.
2. **Windows Firewall** — Node.js / port 8081 may be blocked. Either allow it in Firewall settings, or use `--tunnel` mode (requires `@expo/ngrok`).
3. **Tunnel mode**: `npx expo start --tunnel` routes traffic through Expo's servers — works even on different networks.
4. **Scan QR code** from the Expo Go app (not the camera app).
5. **SDK mismatch**: Expo Go only supports the current SDK. If you upgrade Expo SDK, also update Expo Go from the App Store.

## Known Issues / Watchouts
- **No icon/splash assets**: The `assets/` folder is empty. Expo will use defaults. Do not add references to `app.json` until actual PNG files exist in `assets/`.
- **`src/navigation/RootNavigator.tsx`** is not used — routing is handled by expo-router via `app/`. Don't wire it back in.
- **planGenerator.ts is all mock data** — no real AI or API integration yet.

## Dependency Versions (Expo SDK 54 compatible)
| Package | Version |
|---|---|
| expo | ~54.0.8 |
| react-native | 0.76.6 |
| react | 18.3.1 |
| expo-router | ~4.0.8 |
| expo-constants | ~17.0.5 |
| expo-status-bar | ~2.0.1 |
| react-native-screens | ~4.4.0 |
| react-native-safe-area-context | 4.12.0 |
| @react-native-async-storage/async-storage | 2.1.0 |
