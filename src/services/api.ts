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
  try {
    const res = await fetch(url, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...options.headers },
    });
    const data = await res.json();
    if (!res.ok) {
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
      savedMeals:             [],
    };
  } catch {
    return null;
  }
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

export async function getWeightRecommendation(
  token: string,
  exerciseName: string,
  goal: string,
  lastSets: import('../types').CompletedSet[],
  nextSetNumber: number,
): Promise<{ weightLbs: number; reps: number; tip: string }> {
  return request('/ai/recommend-weight', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ exerciseName, goal, lastSets, nextSetNumber }),
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

// ============================================================================
// Meta API Endpoints — Reference Data (Foods, Equipment, Goals, Paces)
// ============================================================================

export async function getFoods(category?: string) {
  const params = category ? `?category=${category}` : '';
  return request<any[]>(`/meta/foods${params}`);
}

export async function getFoodCategories() {
  return request<Record<string, { label: string; icon: string }>>('/meta/food-categories');
}

export async function getEquipment(category?: string) {
  const params = category ? `?category=${category}` : '';
  return request<any[]>(`/meta/equipment${params}`);
}

export async function getGoals() {
  return request<any[]>('/meta/goals');
}

export async function getExercises(params?: { muscle?: string; equipment?: string }) {
  const qp = new URLSearchParams();
  if (params?.muscle) qp.set('muscle', params.muscle);
  if (params?.equipment) qp.set('equipment', params.equipment);
  const suffix = qp.toString() ? `?${qp.toString()}` : '';
  return request<any[]>(`/meta/exercises${suffix}`);
}

export async function getPaces(goal?: string) {
  const params = goal ? `?goal=${goal}` : '';
  return request<any[]>(`/meta/paces${params}`);
}

export async function logWorkoutDone(
  token: string,
  workout_date: string,
  focus_label: string,
  duration_seconds: number,
) {
  return request('/workouts/complete', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ workout_date, focus_label, duration_seconds }),
  });
}

export async function getWorkoutStatus(
  token: string,
  workout_date: string,
): Promise<{ done: boolean }> {
  return request(`/workouts/status?workout_date=${workout_date}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function getGoalConfig() {
  return request<{
    weight_goals: string[];
    timeline_goals: string[];
    lifestyle_goals: string[];
    timeline_weeks: Record<string, Record<string, number>>;
  }>('/meta/goal-config');
}

export async function getDayState(token: string, dayKey: string) {
  return request<any>(`/profile/day-state/${dayKey}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function upsertDayState(
  token: string,
  dayKey: string,
  payload: { skipped_focus?: string | null; meal_checks?: Record<string, boolean>; nutrition_plan?: any },
) {
  return request('/profile/day-state/' + dayKey, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
}

export async function submitWeeklyCheckin(
  token: string,
  body: { checkin_date: string; weight_lbs: number; waist_in?: number; energy: number; sleep: number; adherence: number; notes?: string },
) {
  return request('/profile/checkin', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

export async function getInsights(token: string) {
  return request('/profile/insights', {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function getGuardrails(token: string) {
  return request<{ warnings: string[] }>('/profile/guardrails', {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function getCoachMemory(token: string) {
  return request<any[]>('/profile/coach-memory', {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function getProgressionInsights(token: string, exerciseName: string) {
  return request<any>(`/workouts/progression/${encodeURIComponent(exerciseName)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function getGroceryList(token: string, days = 3) {
  return request<{ days: number; items: Array<{ food: string; frequency: number }> }>(`/meals/grocery-list?days=${days}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function getMealSwap(token: string, meal_type: string, foods: string[]) {
  const foodsQuery = foods.map(f => `foods=${encodeURIComponent(f)}`).join('&');
  return request<{ meal_type: string; original: string[]; suggested: string[] }>(`/meals/swap?meal_type=${encodeURIComponent(meal_type)}&${foodsQuery}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function askTrainerQuestion(
  token: string,
  payload: {
    question: string;
    profile: any;
    workoutPlan?: any;
    nutritionPlan?: any;
    progress?: any;
    conversation?: Array<{ role: 'user' | 'assistant'; content: string }>;
  },
): Promise<{
  answer: string;
  action_items: string[];
  needs_plan_update: boolean;
  safety_note: string;
  updated_workout_plan?: any | null;
  updated_nutrition_plan?: any | null;
}> {
  return request('/ai/trainer-question', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
}

export async function askWorkoutQuestion(
  token: string,
  payload: {
    question: string;
    workout: any;
    activeExerciseName?: string;
    currentSetNumber?: number;
    loggedSets?: any[];
  },
): Promise<{ answer: string; quick_cues: string[]; adjustment: string; safety_note: string }> {
  return request('/ai/workout-question', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
}

export async function analyzeFoodPhoto(
  token: string,
  payload: { image_base64: string; mime_type?: string },
): Promise<{
  meal_name: string;
  items: string[];
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
}> {
  return request('/ai/food-photo', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
}

export async function analyzeWorkoutFormPhoto(
  token: string,
  payload: { image_base64: string; mime_type?: string; exercise_name?: string; question?: string },
): Promise<{
  answer: string;
  quick_cues: string[];
  likely_target: string;
  red_flags: string[];
  safety_note: string;
}> {
  return request('/ai/form-photo', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
}

