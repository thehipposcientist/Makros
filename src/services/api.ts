import Constants from 'expo-constants';

function getBaseUrl(): string {
  if (__DEV__) {
    // Derive the dev machine's IP from Expo's host URI so it works on a real device
    const host = Constants.expoConfig?.hostUri?.split(':')[0] ?? '127.0.0.1';
    return `http://${host}:8000`;
  }
  return 'https://your-production-api.com';
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const url = `${getBaseUrl()}${path}`;
  console.log('[api]', options.method ?? 'GET', url);
  try {
    const res = await fetch(url, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...options.headers },
    });
    const data = await res.json();
    if (!res.ok) {
      // FastAPI 422 returns detail as an array of validation errors
      const detail = Array.isArray(data.detail)
        ? data.detail.map((e: any) => `${e.loc?.join('.')}: ${e.msg}`).join(', ')
        : (data.detail ?? 'Request failed');
      throw new Error(`${res.status} ${detail}`);
    }
    return data as T;
  } catch (e: any) {
    if (e.message === 'Network request failed') {
      throw new Error(`Can't reach backend at ${getBaseUrl()} — is it running?`);
    }
    throw e;
  }
}

export async function register(email: string, username: string, password: string) {
  return request('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, username, password }),
  });
}

export async function login(email: string, password: string): Promise<{ access_token: string }> {
  return request('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}

export async function getMe(token: string) {
  return request('/auth/me', {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function getMyProfile(token: string): Promise<import('../types').UserProfile | null> {
  try {
    const data = await request<any>('/profile/me', {
      headers: { Authorization: `Bearer ${token}` },
    });
    // Map backend snake_case → frontend UserProfile shape
    return {
      goal:       data.goal.goal_type,
      goalDetails: {
        pace:             data.goal.pace,
        targetWeightLbs:  data.goal.target_weight_lbs ?? undefined,
        timelineWeeks:    data.goal.timeline_weeks ?? undefined,
      },
      physicalStats: {
        weightLbs:    data.profile.weight_lbs,
        heightFeet:   data.profile.height_feet,
        heightInches: data.profile.height_inches,
        age:          data.profile.age,
        gender:       data.profile.gender,
      },
      daysPerWeek:            data.preferences.days_per_week,
      workoutDurationMinutes: 60,
      equipment:              data.preferences.equipment ?? [],
      foodsAvailable:         data.preferences.foods_available ?? [],
      customFoods:            [],
    };
  } catch {
    return null;
  }
}

export async function lookupFoodMacros(token: string, name: string) {
  return request<{ name: string; unit: string; calories: number; protein: number; carbs: number; fat: number }>('/ai/lookup-food', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ name }),
  });
}

export async function lookupEquipmentInfo(token: string, name: string) {
  return request<{ name: string; muscleGroups: string[]; category: string }>('/ai/lookup-equipment', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ name }),
  });
}

export async function getAIPlans(token: string, profile: import('../types').UserProfile) {
  return request<{ workout_plan: import('../types').WorkoutPlan; nutrition_plan: import('../types').DailyNutritionPlan }>('/ai/plans', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      goal:           profile.goal,
      goalDetails:    profile.goalDetails,
      physicalStats:  profile.physicalStats,
      daysPerWeek:    profile.daysPerWeek,
      equipment:      profile.equipment,
      foodsAvailable: profile.foodsAvailable,
    }),
  });
}

export async function syncOnboarding(token: string, profile: import('../types').UserProfile) {
  return request('/profile/onboarding', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      profile: {
        weight_lbs:    profile.physicalStats.weightLbs,
        height_feet:   profile.physicalStats.heightFeet,
        height_inches: profile.physicalStats.heightInches,
        age:           profile.physicalStats.age,
        gender:        profile.physicalStats.gender,
      },
      goal: {
        goal_type:         profile.goal,
        pace:              profile.goalDetails.pace,
        target_weight_lbs: profile.goalDetails.targetWeightLbs ?? null,
        timeline_weeks:    profile.goalDetails.timelineWeeks ?? null,
      },
      preferences: {
        days_per_week:   profile.daysPerWeek,
        equipment:       profile.equipment,
        foods_available: profile.foodsAvailable,
      },
    }),
  });
}
