# WorkoutPal - Fitness & Nutrition Planning App

A simple React Native + Expo fitness and nutrition planning application built with TypeScript.

## Project Structure

```
WorkoutPal/
├── src/
│   ├── screens/
│   │   ├── OnboardingScreen.tsx    # User onboarding with form inputs
│   │   └── HomeScreen.tsx          # Main app showing daily plan
│   ├── components/
│   │   ├── WorkoutCard.tsx         # Displays workout details
│   │   └── NutritionCard.tsx       # Displays nutrition targets & meals
│   ├── navigation/
│   │   └── RootNavigator.tsx       # React Navigation setup
│   ├── types/
│   │   └── index.ts                # TypeScript interfaces & types
│   └── utils/
│       └── planGenerator.ts        # Mock plan generation logic
├── App.tsx                         # Main app component
├── app.json                        # Expo configuration
├── package.json                    # Project dependencies
├── tsconfig.json                   # TypeScript configuration
└── babel.config.js                 # Babel configuration
```

## File Purpose Reference

### Screens
- **OnboardingScreen.tsx**: Multi-step form where users input their fitness goal, training days/week, available equipment, and favorite foods
- **HomeScreen.tsx**: Displays "Today's Plan" with workout and nutrition information

### Components
- **WorkoutCard.tsx**: Renders individual workout day with exercises, sets, reps, and rest periods
- **NutritionCard.tsx**: Shows nutrition targets and meal suggestions for the day

### Navigation
- **RootNavigator.tsx**: Sets up React Navigation stack. Shows Onboarding first, then Home after profile creation

### Utils
- **planGenerator.ts**: Generates mock workout plans (full-body, PPL, upper-lower splits based on days available) and nutrition plans with calorie/protein targets

### Types
- **index.ts**: Defines all TypeScript interfaces (UserProfile, Exercise, WorkoutDay, NutritionTargets, etc.)

## Setup Instructions

### 1. Prerequisites

First, install Node.js and npm on your machine:
- **Windows**: Download from https://nodejs.org/ (LTS recommended)
- **Mac**: `brew install node`
- **Linux**: `sudo apt install nodejs npm`

Verify installation:
```bash
node --version
npm --version
```

### 2. Install Expo CLI

```bash
npm install -g expo-cli
```

### 3. Install Dependencies

Navigate to the project folder and install dependencies:

```bash
cd e:\WorkoutPal
npm install
```

This installs all packages defined in `package.json`.

### 4. Run the App

Start the Expo development server:

```bash
npm start
```

This will show a menu with options:

```
i - run on iOS simulator
a - run on Android emulator
w - run on web
```

**Choose an option:**

- **Web (Fastest for testing)**: Press `w` to open in your browser
- **iOS**: Press `i` (requires Mac with Xcode)
- **Android**: Press `a` (requires Android Studio)

### 5. Test on Phone (Optional)

Download the **Expo Go** app from your phone's app store, then scan the QR code shown in the terminal.

## How the App Works

### Onboarding Flow
1. User selects fitness goal (Fat Loss / Muscle Gain / General Fitness)
2. Enter training days per week (1-7)
3. Select available equipment
4. Input favorite foods (optional)
5. User profile is saved to device storage

### Home Screen
- Displays today's workout with exercises and reps
- Shows nutrition targets (calories, protein, carbs, fat)
- Displays meal suggestions for the day
- Allows cycling through different workout days

## Key Features

✅ **TypeScript**: Fully typed for better development experience
✅ **Local Storage**: User profile persisted on device using AsyncStorage
✅ **Mock Data**: Generates realistic plans without API
✅ **Responsive UI**: Clean, beginner-friendly interface
✅ **Navigation**: Simple onboarding → home flow

## Workout Plans Generated

Based on days per week available:
- **1-3 days**: Full body split (3 days)
- **4-5 days**: Push/Pull/Legs split (3 days shown)
- **6-7 days**: Upper/Lower split (4 days)

## Nutrition Calculation

Simple estimates (in production, would need more user data):
- Fat Loss Goal: ~1800 calories/day
- Muscle Gain Goal: ~2500 calories/day
- Protein: 0.8-1g per pound of bodyweight
- Meals split: 25% breakfast, 35% lunch, 40% dinner

## Next Steps for Extension

- Add backend API for personalized plans
- Implement exercise tracking (sets/reps logged per session)
- Add progress photos and measurements
- Integrate with health APIs (Apple Health, Google Fit)
- Add meal logging and calorie tracking
- Social features (share progress, find workout buddies)
- Authentication system

## Troubleshooting

### Port already in use
If you get "Port 8081 already in use":
```bash
expo start -c
```
(The `-c` flag clears cache and can help)

### Dependencies not installing
```bash
rm -rf node_modules package-lock.json
npm install
```

### TypeScript errors
Make sure `tsconfig.json` is correct by checking `src/` is in `include`

## Resources

- [React Native Docs](https://reactnative.dev/)
- [Expo Documentation](https://docs.expo.dev/)
- [React Navigation Docs](https://reactnavigation.org/)
- [TypeScript Handbook](https://www.typescriptlang.org/docs/)

## License

MIT
