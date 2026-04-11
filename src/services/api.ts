import Constants from 'expo-constants';

const LOCAL_BACKEND_IP = '192.168.1.220'; // your dev machine's LAN IP

function getBaseUrl(): string {
  if (__DEV__) {
    const hostUri = Constants.expoConfig?.hostUri ?? '';
    // In tunnel mode (ngrok/exp.direct), hostUri is the ngrok domain — can't use it
    // for the backend. Fall back to the machine's actual LAN IP instead.
    const isTunnel = hostUri.includes('ngrok') || hostUri.includes('exp.direct') || !hostUri;
    const host = isTunnel ? LOCAL_BACKEND_IP : (hostUri.split(':')[0] ?? LOCAL_BACKEND_IP);
    return `http://${host}:8000`;
  }
  return 'https://your-production-api.com';
}

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

async function request<T>(path: string, options: RequestInit = {}, timeoutMs = 30000): Promise<T> {
  const maxRetries = 2;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      // Exponential backoff: 1s, 2s
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }

    const url = `${getBaseUrl()}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', ...options.headers },
      });
      clearTimeout(timer);

      // Retry on transient server errors
      if (RETRYABLE_STATUS.has(res.status) && attempt < maxRetries) {
        console.log(`[api] ${path} returned ${res.status}, retrying (${attempt + 1}/${maxRetries})`);
        lastError = new Error(`HTTP ${res.status}`);
        continue;
      }

      const data = await res.json();
      if (!res.ok) {
        const detail = Array.isArray(data.detail)
          ? data.detail.map((e: any) => `${e.loc?.join('.')}: ${e.msg}`).join(', ')
          : (typeof data.detail === 'string' ? data.detail : `HTTP ${res.status}`);
        throw new Error(detail);
      }
      return data as T;
    } catch (e: any) {
      clearTimeout(timer);
      if (e.name === 'AbortError') {
        lastError = new Error(`Request timed out. Backend: ${getBaseUrl()} — is it reachable?`);
        if (attempt < maxRetries) continue;
        throw lastError;
      }
      if (e.message === 'Network request failed') {
        lastError = new Error(`Can't reach backend at ${getBaseUrl()} — is it running?`);
        if (attempt < maxRetries) continue;
        throw lastError;
      }
      throw e;
    }
  }
  throw lastError ?? new Error('Request failed');
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


function buildLogContext(
  profile: import('../types').UserProfile,
  userLog?: import('../types').UserLogEntry[],
  extraContext?: string,
): string | undefined {
  const parts: string[] = [];
  // Onboarding context — what the user said they last trained at signup
  if (profile.lastWorkoutContext) {
    parts.push(`User's recent activity (from sign-up): ${profile.lastWorkoutContext}`);
  }
  // Any extra context built by the caller (e.g. recent workout sessions)
  if (extraContext) parts.push(extraContext);
  // User activity log
  const logLines = (userLog ?? [])
    .slice(0, 10)
    .map(e => `[${e.date.slice(0, 10)}] ${e.summary}`)
    .join('\n');
  if (logLines) parts.push(logLines);
  return parts.length ? parts.join('\n\n') : undefined;
}

function buildInjuries(profile: import('../types').UserProfile): string[] {
  const list: string[] = (profile.injuryEntries ?? [])
    .filter((e: any) => e.status !== 'resolved')
    .map((e: any) => `${e.description} (${e.bodyPart}, status: ${e.status})`);
  if (profile.injuries && list.length === 0) list.push(profile.injuries);
  return list;
}

/** Full plan — called on first sign-up or when goal/pace changes (updates both sides). */
export async function getAIPlans(
  token: string,
  profile: import('../types').UserProfile,
  options?: { userLog?: import('../types').UserLogEntry[]; extraContext?: string },
) {
  const injuriesOrLimitations = buildInjuries(profile);
  const payload = {
    goal:                   profile.goal,
    goalSelection:          profile.goalSelection ?? undefined,
    secondaryGoal:          profile.secondaryGoal,
    focusedMuscleGroup:     profile.focusedMuscleGroup,
    goalDetails:            profile.goalDetails,
    physicalStats:          profile.physicalStats,
    daysPerWeek:            profile.daysPerWeek,
    workoutDurationMinutes: profile.workoutDurationMinutes,
    equipment:              profile.equipment,
    foodsAvailable:         profile.foodsAvailable,
    supplementsAvailable:   profile.supplementsAvailable ?? [],
    experienceLevel:        profile.experienceLevel,
    injuriesOrLimitations,
    mealRoutine:            profile.mealRoutine,
    customMacros:           profile.customMacros ?? undefined,
    userContext:            buildLogContext(profile, options?.userLog, options?.extraContext),
  };

  console.log('[getAIPlans] SEND → /ai/plans', {
    goal: payload.goal, daysPerWeek: payload.daysPerWeek,
    equipment: payload.equipment?.length ?? 0, foods: payload.foodsAvailable?.length ?? 0,
  });

  const result = await request<any>('/ai/plans', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  }, 240000);

  console.log('[getAIPlans] RECV ←', {
    trainerNote: (result?.trainerNote ?? result?.workout_plan?.trainerNote)?.slice(0, 80) ?? 'MISSING',
    nutritionistNote: (result?.nutritionistNote ?? result?.nutrition_plan?.nutritionistNote)?.slice(0, 80) ?? 'MISSING',
    workoutDays: result?.workout_plan?.days?.length ?? 0,
  });
  return result;
}

/** Workout-only plan — called when equipment changes. No food data sent. */
export async function getAIWorkoutPlan(
  token: string,
  profile: import('../types').UserProfile,
  options?: { userLog?: import('../types').UserLogEntry[]; extraContext?: string },
) {
  const payload = {
    goal:                   profile.goal,
    secondaryGoal:          profile.secondaryGoal,
    focusedMuscleGroup:     profile.focusedMuscleGroup,
    goalDetails:            profile.goalDetails,
    physicalStats:          profile.physicalStats,
    daysPerWeek:            profile.daysPerWeek,
    workoutDurationMinutes: profile.workoutDurationMinutes,
    equipment:              profile.equipment,
    experienceLevel:        profile.experienceLevel,
    injuriesOrLimitations:  buildInjuries(profile),
    userContext:            buildLogContext(profile, options?.userLog, options?.extraContext),
  };

  console.log('[getAIWorkoutPlan] SEND → /ai/plans/workout', {
    goal: payload.goal, daysPerWeek: payload.daysPerWeek, equipment: payload.equipment.length,
  });

  const result = await request<any>('/ai/plans/workout', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  }, 240000);

  console.log('[getAIWorkoutPlan] RECV ←', {
    trainerNote: result?.trainerNote?.slice(0, 80) ?? 'MISSING',
    workoutDays: result?.workout_plan?.days?.length ?? 0,
  });
  return result;
}

/** Nutrition-only plan — called when foods change. No equipment data sent. */
export async function getAINutritionPlan(
  token: string,
  profile: import('../types').UserProfile,
  options?: { userLog?: import('../types').UserLogEntry[]; extraContext?: string },
) {
  const payload = {
    goal:                 profile.goal,
    goalDetails:          profile.goalDetails,
    physicalStats:        profile.physicalStats,
    daysPerWeek:          profile.daysPerWeek,
    foodsAvailable:       profile.foodsAvailable,
    supplementsAvailable: profile.supplementsAvailable ?? [],
    dietaryPreference:    (profile as any).dietaryPreference ?? undefined,
    allergies:            (profile as any).allergies ?? [],
    mealRoutine:          profile.mealRoutine,
    customMacros:         profile.customMacros ?? undefined,
    userContext:          buildLogContext(profile, options?.userLog, options?.extraContext),
  };

  console.log('[getAINutritionPlan] SEND → /ai/plans/nutrition', {
    goal: payload.goal, daysPerWeek: payload.daysPerWeek, foods: payload.foodsAvailable.length,
  });

  const result = await request<any>('/ai/plans/nutrition', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  }, 240000);

  console.log('[getAINutritionPlan] RECV ←', {
    nutritionistNote: result?.nutritionistNote?.slice(0, 80) ?? 'MISSING',
  });
  return result;
}

export async function getWeightRecommendation(
  token: string,
  exerciseName: string,
  goal: string,
  lastSets: import('../types').CompletedSet[],
  nextSetNumber: number,
  options?: {
    targetSets?: number;
    targetReps?: string;
    progressionPace?: 'conservative' | 'moderate' | 'aggressive';
    experienceLevel?: 'beginner' | 'intermediate' | 'advanced';
    recoveryLevel?: 'low' | 'normal' | 'high';
    phase?: 'accumulation' | 'intensification' | 'deload';
    workoutFocus?: string;
    weekNumber?: number;
    incrementLbs?: number;
  },
): Promise<{ weightLbs: number; reps: number; tip: string }> {
  return request('/ai/recommend-weight', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ exerciseName, goal, lastSets, nextSetNumber, ...options }),
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
    mode: 'trainer' | 'nutritionist';
    profile: any;
    workoutPlan?: any;
    nutritionPlan?: any;
    currentPlanContext?: {
      workoutDays: Array<{ focus: string; exercises: Array<{ name: string; sets: number; reps: string }> }>;
      todayMeals: Array<{ type: string; meal: string; foods: string[]; calories: number; protein: number }>;
      mealRoutine?: string;
    };
    progress?: any;
    conversation?: Array<{ role: 'user' | 'assistant'; content: string }>;
    image_base64?: string;
    mime_type?: string;
    userContext?: string;
  },
): Promise<{
  answer: string;
  action_items: string[];
  needs_plan_update: boolean;
  safety_note: string;
  updated_workout_plan?: any | null;
  updated_nutrition_plan?: any | null;
  updated_injuries?: any[] | null;
  injury_clarification_needed?: boolean;
}> {
  console.log('[askTrainerQuestion] SEND →', {
    mode: payload.mode,
    question: payload.question.slice(0, 120),
    hasImage: !!payload.image_base64,
    conversationLength: payload.conversation?.length ?? 0,
    hasUserContext: !!payload.userContext,
    profileKeys: Object.keys(payload.profile ?? {}),
    workoutDayCount: payload.workoutPlan?.days?.length ?? 0,
  });

  const resp = await request<{
    answer: string;
    action_items: string[];
    needs_plan_update: boolean;
    safety_note: string;
    updated_workout_plan?: any | null;
    updated_nutrition_plan?: any | null;
    updated_injuries?: any[] | null;
    injury_clarification_needed?: boolean;
  }>('/ai/trainer-question', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  }, 90000);

  console.log('[askTrainerQuestion] RECV ←', {
    answerPreview: resp.answer?.slice(0, 150),
    needs_plan_update: resp.needs_plan_update,
    hasUpdatedWorkout: !!resp.updated_workout_plan,
    hasUpdatedNutrition: !!resp.updated_nutrition_plan,
    updatedWorkoutKeys: resp.updated_workout_plan ? Object.keys(resp.updated_workout_plan) : null,
    hasInjuries: !!(resp.updated_injuries?.length),
    injuryCount: resp.updated_injuries?.length ?? 0,
  });

  return resp;
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
  console.log('[askWorkoutQuestion] SEND →', {
    question: payload.question.slice(0, 120),
    activeExercise: payload.activeExerciseName,
    currentSet: payload.currentSetNumber,
    loggedSetsCount: payload.loggedSets?.length ?? 0,
  });

  const resp = await request<{ answer: string; quick_cues: string[]; adjustment: string; safety_note: string }>('/ai/workout-question', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });

  console.log('[askWorkoutQuestion] RECV ←', {
    answerPreview: resp.answer?.slice(0, 150),
    quickCuesCount: resp.quick_cues?.length ?? 0,
    adjustment: resp.adjustment?.slice(0, 80),
  });

  return resp;
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

export async function scanFoodsPhoto(
  token: string,
  payload: {
    images: Array<{ image_base64: string; mime_type?: string }>;
    context?: string;
  },
): Promise<{
  foods: Array<{
    name: string;
    serving: string;
    calories: number;
    protein: number;
    carbs: number;
    fat: number;
  }>;
}> {
  return request('/ai/scan-foods', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
}

export async function lookupSupplementFromPhoto(
  token: string,
  payload: { image_base64: string; mime_type?: string },
): Promise<{
  found: boolean;
  name: string;
  category?: string;
  tagline?: string;
  whatItDoes?: string;
  evidence?: 'strong' | 'moderate' | 'limited';
  dose?: string;
  timing?: string;
  goodFor?: string[];
  cautions?: string;
}> {
  return request('/ai/supplement-photo', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
}

export async function lookupSupplement(
  token: string,
  name: string,
): Promise<{
  found: boolean;
  name: string;
  category?: string;
  tagline?: string;
  whatItDoes?: string;
  evidence?: 'strong' | 'moderate' | 'limited';
  dose?: string;
  timing?: string;
  goodFor?: string[];
  cautions?: string;
}> {
  return request('/ai/supplement-info', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ name }),
  });
}

export async function scanEquipmentPhoto(
  token: string,
  payload: { image_base64: string; mime_type?: string },
): Promise<{ equipment: string[] }> {
  return request('/ai/scan-equipment', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
}

export async function getWorkoutSummary(
  token: string,
  payload: {
    exercises: import('../types').SessionExercise[];
    durationSeconds: number;
    focus: string;
    goal: string;
    weightLbs?: number;
  },
): Promise<import('../types').WorkoutSummary> {
  return request('/ai/workout-summary', {
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

