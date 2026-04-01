# WorkoutPal - Complete Setup Guide

## 📋 Before You Start

This guide walks you through setting up your React Native + Expo fitness app from scratch. You have all the code files ready—you just need to install dependencies and run it!

**Time Required**: ~15-20 minutes

## ✅ Step-by-Step Setup

### Step 1: Install Node.js (REQUIRED - One time only)

**Windows:**
1. Go to https://nodejs.org
2. Download the LTS (Long Term Support) version
3. Run the installer and follow prompts
4. Choose "Add to PATH" when asked
5. Restart your computer after installation

**Mac:**
```bash
brew install node
```

**Verify Installation** (run in PowerShell/Terminal):
```bash
node --version
npm --version
```

You should see version numbers like `v18.0.0` and `8.0.0`

### Step 2: Install Expo CLI Globally

Open PowerShell as Administrator and run:

```bash
npm install -g expo-cli
```

Wait for it to complete. You should see no errors.

### Step 3: Navigate to Your Project

In PowerShell, go to your project folder:

```bash
cd e:\WorkoutPal
```

Verify you're in the right place by typing:

```bash
dir
```

You should see: `App.tsx`, `app.json`, `package.json`, `src/`, etc.

### Step 4: Install Project Dependencies

This installs all libraries your app needs:

```bash
npm install
```

**This may take 2-5 minutes.** You should see:
- Lots of package installations (don't worry, that's normal)
- Ends with success message
- New `node_modules/` folder appears

### Step 5: Start the Development Server

```bash
npm start
```

You should see output like:
```
> expo start
Opening the project in Expo...

Starting Expo Go...
Tunnel ready.

│   Expo Go ready at http://localhost:8081
│
│  ›   Android:     Press 'a'
│  ›   iOS:         Press 'i'  
│  ›   Web:         Press 'w'
│  ›   Restart:     Press 'r'
│  ›   Quit:        Press 'q'
```

### Step 6: Choose Your Testing Option

#### **Option A: Web Browser (EASIEST - Recommended for First Test)**

Press `w` in the terminal.

A browser window should open. You'll see:
1. Splash screen loading
2. Onboarding flow with forms

**This is perfect for testing the UI quickly!**

#### **Option B: Android Emulator**

Requirements: Android Studio installed

Press `a` in terminal. Wait for emulator to launch (1-2 minutes).

Then the app appears in the emulator.

#### **Option C: iOS Simulator**

Requirements: Mac with Xcode

Press `i` in terminal.

iOS simulator launches with your app.

#### **Option D: Physical Phone**

1. Download "Expo Go" app from App Store or Google Play
2. Press `w` to see the QR code
3. Watch the terminal (press 's' to show QR code)
4. Scan with your phone's camera
5. Opens in Expo Go automatically

## 🎯 Testing the App

### First Screen (Onboarding)

You'll see a form with 4 steps:

**Step 1: Select Goal**
- Choose 🔥 Fat Loss, 💪 Muscle Gain, or 🏃 General Fitness
- Click "Next"

**Step 2: Training Days**
- Enter a number 1-7 (try 3-4 for beginners)
- Click "Next"

**Step 3: Equipment**
- Select fitness equipment you have (home, gym, etc.)
- Click "Next"

**Step 4: Foods**
- Enter foods you like separated by commas (optional)
- Click "Get Started"

### Home Screen

After onboarding, you see:

**Your Plan** showing:
- Today's Workout with exercises & reps
- Nutrition targets (calories, protein, carbs, fat)
- 3 meal suggestions with food ideas
- Buttons to view different days

**Try clicking the day numbers (1, 2, 3) to see different workouts!**

## 🔧 Common Issues & Solutions

### Issue: "npm not found"

**Solution:**
- Restart PowerShell or Command Prompt
- If that doesn't work, restart your computer
- Verify installation: `node --version`

### Issue: "Port 8081 already in use"

**Solution:**
```bash
expo start -c
```

The `-c` clears cache and picks a new port.

### Issue: "Module not found" or dependency errors

**Solution:**
```bash
# Delete and reinstall everything
rm -r node_modules
rm package-lock.json
npm install
```

### Issue: App won't load in browser

**Solution:**
1. Press `q` in terminal to quit
2. Clear cache: `npm install -g expo-cli@latest`
3. Try again: `npm start`

### Issue: Blank screen or stuck loading

**Solution:**
1. Press `r` in terminal to reload
2. If that doesn't work, press `q` and restart: `npm start`

## 📁 What Each File Does

| File | Purpose |
|------|---------|
| `App.tsx` | Main entry point - manages user state and navigation |
| `src/screens/OnboardingScreen.tsx` | The form screen users see first |
| `src/screens/HomeScreen.tsx` | Main app screen showing workout plan |
| `src/components/WorkoutCard.tsx` | Component displaying exercises |
| `src/components/NutritionCard.tsx` | Component displaying meals & calories |
| `src/utils/planGenerator.ts` | Logic that creates workout/nutrition plans |
| `src/navigation/RootNavigator.tsx` | Sets up navigation between screens |
| `src/types/index.ts` | TypeScript type definitions |
| `package.json` | List of all dependencies (libraries) |
| `app.json` | Expo configuration |

## 🚀 Development Tips

### Making Changes

1. Edit any `.tsx` file in `src/`
2. Save the file
3. Your app auto-refreshes! (just wait ~2 seconds)

### Example: Change splash text

Edit `src/screens/OnboardingScreen.tsx`, find:
```typescript
<Text style={styles.logo}>💪 WorkoutPal</Text>
```

Change to:
```typescript
<Text style={styles.logo}>🏋️ My Fitness App</Text>
```

Save → Refreshes automatically!

### Stop the App

Press `q` in the terminal window to stop.

### Restart the App

Press `r` in terminal (while it's running) to reload.

## 📚 Next Steps to Extend

Once you're comfortable with the setup, try:

1. **Change colors**: Edit `borderLeftColor: '#007AFF'` in component styles
2. **Add new exercises**: Edit workout arrays in `src/utils/planGenerator.ts`
3. **Customize nutrition targets**: Modify calorie calculations in same file
4. **Add a settings screen**: Create `src/screens/SettingsScreen.tsx`
5. **Connect to API**: Replace mock data with real API calls

## 🎓 Learning Resources

Start with these to understand React Native better:

- [React Native Basics](https://reactnative.dev/docs/getting-started) - 15 min read
- [React Hooks Tutorial](https://react.dev/learn) - covers useState, useEffect
- [Expo Documentation](https://docs.expo.dev/get-started/create-a-new-app/) - official guide
- [TypeScript Basics](https://www.typescriptlang.org/docs/handbook/) - if new to TypeScript

## 📞 Stuck?

1. Check the terminal for error messages (scroll up to see)
2. Check the browser/emulator - there may be an error overlay
3. Try restarting: `npm start`
4. Delete `node_modules` and reinstall (see Common Issues section)

---

**That's it! You now have a fully functional fitness app MVP ready to extend. Happy coding! 🎉**
