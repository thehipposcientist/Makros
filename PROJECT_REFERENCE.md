# WorkoutPal Project - File Reference

## 📦 Dependencies Explained

Your `package.json` includes these key libraries:

- **expo** - Framework to build & run React Native apps easily
- **react-native** - Core library for iOS/Android
- **react-navigation** - Handles screen navigation
- **@react-native-async-storage** - Saves data to device
- **typescript** - Type-safe JavaScript

## 🎯 Main App Files

### Root Level
- **App.tsx** - Entry point. Loads user profile and renders navigation
- **app.json** - Expo configuration (app name, icons, settings)
- **package.json** - Dependencies list
- **tsconfig.json** - TypeScript settings

### src/screens/
- **OnboardingScreen.tsx** - Multi-step form (4 screens)
  - Step 1: Goal selection (Fat Loss / Muscle Gain / General Fitness)
  - Step 2: Days per week input
  - Step 3: Equipment selection (multi-select)
  - Step 4: Favorite foods (text input)
  - Saves profile to device

- **HomeScreen.tsx** - Main app screen
  - Shows "Today's Plan" header
  - Displays current workout
  - Displays nutrition targets
  - Day selector buttons (1, 2, 3, etc.)
  - Tips section

### src/components/
- **WorkoutCard.tsx** - Displays exercises
  - Exercise name
  - Sets × Reps
  - Rest time
  - Equipment type
  - Styled as blue card

- **NutritionCard.tsx** - Displays meals and nutrition
  - Daily targets (Calories, Protein, Carbs, Fat)
  - Breakfast, lunch, dinner suggestions
  - Meal calorie/protein breakdown
  - Styled as pink card

### src/navigation/
- **RootNavigator.tsx** - React Navigation setup
  - Conditional logic: show Onboarding OR Home based on profile
  - Stack navigator with header styling

### src/utils/
- **planGenerator.ts** - Plan generation logic
  - `generateWorkoutPlan()` - Creates workout split (3-day, PPL, or upper-lower)
  - `generateFullBodySplit()` - 3-day full body (push, pull, legs)
  - `generatePPLSplit()` - Push/Pull/Legs split
  - `generateUpperLowerSplit()` - Upper/middle/lower/lower
  - `generateDailyNutrition()` - Creates meal plan
  - `calculateNutritionTargets()` - Estimates calories/macros
  - **Note**: All mock data (no API calls yet)

### src/types/
- **index.ts** - TypeScript interfaces
  - `UserProfile` - Stores user's goal, days, equipment, foods
  - `Exercise` - Single exercise details
  - `WorkoutDay` - Group of exercises
  - `WorkoutPlan` - Full week's workouts
  - `NutritionTargets` - Daily macros
  - `MealSuggestion` - Single meal
  - `DailyNutritionPlan` - Full day nutrition

## 🔄 Data Flow

```
App.tsx (State)
    ↓
AsyncStorage (Device saves profile)
    ↓
RootNavigator (Shows Onboarding OR Home)
    ↓
IF Onboarding → OnboardingScreen
    ↓ (fills goal, days, equipment, foods)
    ↓ (saves to AsyncStorage + state)
    ↓ (navigate to Home)
    ↓
IF Home → HomeScreen
    ↓ (receives userProfile prop)
    ↓ (calls planGenerator functions)
    ↓ (displays WorkoutCard + NutritionCard)
```

## 📊 Important State Management

### App.tsx State
```typescript
const [userProfile, setUserProfile] = useState<UserProfile | null>(null)
```
- Stores user's fitness profile
- Loaded from device on app start
- Updated when user completes onboarding

## 🎨 Styling Approach

All components use React Native's `StyleSheet`:
- No CSS or external styling libraries
- Cross-platform (iOS, Android, Web)
- Color scheme:
  - Primary blue: `#007AFF`
  - Primary red (nutrition): `#ff6b6b`
  - Text: `#000` (black)
  - Borders: `#e0e0e0` (light gray)

## 🧮 Key Logic Flows

### Onboarding to Home
1. User opens app → OnboardingScreen appears
2. User fills 4-step form
3. "Get Started" clicked → saves profile
4. App state updates → RootNavigator detects profile exists
5. Home screen renders with generated plans

### Workout Generation
1. User selected 3 days/week + has gym access
2. `generateWorkoutPlan()` called
3. Returns 3-day full body split
4. Each day shown with exercises, sets, reps
5. User can cycle through days with buttons

### Nutrition Calculation
1. Estimates based on goal (fat_loss = 1800 cal, muscle_gain = 2500 cal)
2. Protein calculated: ~0.8-1g per lb of bodyweight
3. Carbs and fat split from remaining calories
4. Meals divided: 25% breakfast, 35% lunch, 40% dinner

## 🔌 How to Add Features

### Add New Exercise
Edit `src/utils/planGenerator.ts`:
```typescript
{
  name: 'Your Exercise Name',
  sets: 3,
  reps: '8-10',
  restSeconds: 60,
  equipment: 'gym'
}
```

### Add New Screen
1. Create `src/screens/YourScreen.tsx`
2. Add to RootNavigator's Stack.Screen
3. Add type to `RootStackParamList` in types/index.ts

### Change Colors
Search for color hex codes in component files:
- `#007AFF` - blue (workouts)
- `#ff6b6b` - red (nutrition)
- Adjust to your brand colors

### Store More User Data
1. Add to `UserProfile` type in `src/types/index.ts`
2. Add input fields to `OnboardingScreen.tsx`
3. Update `App.tsx` AsyncStorage save

---

## Quick Start Commands

```bash
# Install dependencies
npm install

# Start dev server
npm start

# Press w (web), a (Android), i (iOS), or q (quit)

# Restart after changes
Press 'r' in terminal

# Clear cache and restart
npm start -c
```

---

**✨ You're all set! Start with `npm install` then `npm start` then press 'w' for web!**
