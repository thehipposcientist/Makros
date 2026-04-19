// ─── Hierarchical Goal System ────────────────────────────────────────────────
//
// Layers:
//   1. GoalCategory  — broad bucket (UI grouping)
//   2. PrimaryGoal   — single selected goal
//   3. GoalModifier   — up to 2 refinements (filtered per goal)
//   4. TargetFocus   — optional body-part / lift / activity emphasis
//   5. Constraints   — days/week, duration, equipment, experience, etc. (on UserProfile)

// ─── Categories ──────────────────────────────────────────────────────────────

export type GoalCategoryId =
  | 'muscle_physique'
  | 'fat_loss'
  | 'strength'
  | 'cardio_endurance'
  | 'athletic_performance'
  | 'health_longevity'
  | 'lifestyle_consistency';

export interface GoalCategory {
  id: GoalCategoryId;
  label: string;
  icon: string;
}

export const GOAL_CATEGORIES: GoalCategory[] = [
  { id: 'muscle_physique',       label: 'Muscle & Physique',       icon: 'body-outline' },
  { id: 'fat_loss',              label: 'Fat Loss',                icon: 'flame-outline' },
  { id: 'strength',              label: 'Compound Strength',       icon: 'trophy-outline' },
  { id: 'cardio_endurance',      label: 'Cardio & Endurance',      icon: 'heart-outline' },
  { id: 'athletic_performance',  label: 'Athletic Performance',    icon: 'flash-outline' },
  { id: 'health_longevity',      label: 'Health & Longevity',      icon: 'leaf-outline' },
  { id: 'lifestyle_consistency', label: 'Lifestyle & Consistency', icon: 'checkmark-circle-outline' },
];

// ─── Primary Goals ───────────────────────────────────────────────────────────

export interface PrimaryGoalDef {
  id: string;
  label: string;
  category: GoalCategoryId;
  description: string;
  /** True = shown as a top-level launch button in onboarding */
  launch: boolean;
}

export const PRIMARY_GOALS: PrimaryGoalDef[] = [
  // ── Muscle & Physique ──────────────────────────────────────────────────────
  { id: 'build_muscle',        label: 'Build Muscle',             category: 'muscle_physique',      description: 'Eat in a calorie surplus and train for hypertrophy (8-12 reps). You will gain muscle and some fat. Best for people who want to get bigger.',          launch: true },
  { id: 'lean_bulk',           label: 'Lean Bulk',                category: 'muscle_physique',      description: 'Small calorie surplus (~200-300 above maintenance) with high protein. Gain muscle slowly while keeping fat gain minimal. Slower than a regular bulk but you stay leaner.',  launch: false },
  { id: 'gain_weight',         label: 'Gain Weight',              category: 'muscle_physique',      description: 'Larger calorie surplus to increase overall bodyweight. Good for underweight individuals or hardgainers who struggle to put on size.',  launch: false },
  { id: 'improve_aesthetics',  label: 'Improve Aesthetics',       category: 'muscle_physique',      description: 'Train for a balanced, proportionate physique. Targets weak points and emphasises muscle symmetry, shoulder-to-waist ratio, and definition.',  launch: false },
  { id: 'build_glutes',        label: 'Build Glutes',             category: 'muscle_physique',      description: 'Heavy hip thrusts, squats, and glute-focused accessories 3-4x/week. Nutrition supports muscle growth in the glutes specifically.',  launch: false },
  { id: 'build_upper_body',    label: 'Build Upper Body',         category: 'muscle_physique',      description: 'Extra volume for chest, back, shoulders, and arms. Lower body is maintained, not emphasised. Good if your upper body is lagging.',  launch: false },
  { id: 'build_lower_body',    label: 'Build Lower Body',         category: 'muscle_physique',      description: 'Extra volume for quads, hamstrings, glutes, and calves. Upper body is maintained. Good if your legs are a weak point.',  launch: false },
  { id: 'build_arms',          label: 'Build Arms',               category: 'muscle_physique',      description: 'Extra bicep and tricep work added to your programme. Includes direct arm training 3-4x/week with progressive overload.',  launch: false },
  { id: 'build_shoulders',     label: 'Build Shoulders',          category: 'muscle_physique',      description: 'Lateral raises, overhead pressing, and rear delt work prioritised. Builds the "capped shoulder" look and wider frame.',  launch: false },
  { id: 'body_recomp',         label: 'Body Recomposition',       category: 'muscle_physique',      description: 'Eat at or near maintenance calories with high protein (1g/lb). You lose fat and gain muscle at the same time. Scale weight may not change much, but your body composition improves. Best for beginners or those returning after a break.',  launch: true },
  { id: 'maintain_physique',   label: 'Maintain Physique',        category: 'muscle_physique',      description: 'Eat at maintenance calories. Training keeps current muscle mass and strength. No surplus or deficit. Good between bulk/cut phases or when life is busy.',  launch: false },

  // ── Fat Loss ───────────────────────────────────────────────────────────────
  { id: 'lose_fat',                  label: 'Lose Fat',                   category: 'fat_loss', description: 'Eat in a moderate calorie deficit (~500 below maintenance). You will lose about 1 lb/week. Training preserves muscle while the deficit drives fat loss.',  launch: true },
  { id: 'get_lean',                  label: 'Get Lean',                   category: 'fat_loss', description: 'Get to a low body fat percentage (10-15% men, 18-23% women) where muscle definition is clearly visible. Requires consistent deficit and high protein.',  launch: false },
  { id: 'cut',                       label: 'Cut',                        category: 'fat_loss', description: 'Aggressive short-term fat loss phase (larger deficit). For experienced lifters who want to drop fat quickly. Harder to sustain long-term but effective for 6-12 weeks.',  launch: false },
  { id: 'preserve_muscle_cutting',   label: 'Preserve Muscle While Cutting', category: 'fat_loss', description: 'Slower deficit with very high protein (1.2g/lb) and heavy compound lifts. Prioritises keeping all your muscle while losing fat. Scale moves slower but you keep your gains.',  launch: false },

  // ── Strength ───────────────────────────────────────────────────────────────
  { id: 'build_strength',        label: 'Build Strength',           category: 'strength', description: 'Train with heavy weights in the 3-6 rep range. Progressive overload on compound lifts (squat, bench, deadlift, press). You will get stronger every week.',  launch: true },
  { id: 'increase_overall',      label: 'Increase Overall Strength', category: 'strength', description: 'Balanced strength across all movement patterns — push, pull, squat, hinge, carry. No weak links.',  launch: false },
  { id: 'improve_1rm',           label: 'Improve 1RM',              category: 'strength', description: 'Peaking programme to hit new one-rep maxes. Uses heavy singles, doubles, and triples with specific percentages. Best run for 4-8 weeks.',  launch: false },
  { id: 'powerlifting',          label: 'Powerlifting',             category: 'strength', description: 'Squat, bench press, and deadlift focused programme. Trains competition lifts with periodised intensity. Includes attempts and peaking.',  launch: false },
  { id: 'improve_squat',         label: 'Improve Squat',            category: 'strength', description: 'Squat 3-4x/week with variations (front squat, pause squat, tempo). Builds leg strength and squat-specific technique.',  launch: false },
  { id: 'improve_bench',         label: 'Improve Bench',            category: 'strength', description: 'Bench press 3-4x/week with variations (close grip, pause, spoto). Builds pressing strength and chest/tricep power.',  launch: false },
  { id: 'improve_deadlift',      label: 'Improve Deadlift',         category: 'strength', description: 'Deadlift focus with variations (deficit, Romanian, paused). Builds posterior chain strength and pulling power.',  launch: false },
  { id: 'improve_ohp',           label: 'Improve Overhead Press',   category: 'strength', description: 'Overhead press priority with push press and strict press variations. Builds shoulder and tricep pressing strength.',  launch: false },
  { id: 'improve_pullups',       label: 'Improve Pull-Ups',         category: 'strength', description: 'Greasing the groove approach — frequent pull-up practice. Includes weighted pull-ups, negatives, and band-assisted progressions.',  launch: false },
  { id: 'improve_grip',          label: 'Improve Grip Strength',    category: 'strength', description: 'Dead hangs, farmer walks, thick bar work, and plate pinches. Stronger grip improves all pulling movements and daily tasks.',  launch: false },
  { id: 'functional_strength',   label: 'Build Functional Strength', category: 'strength', description: 'Carries, lunges, rotational work, and real-world movement patterns. Strength that transfers to daily life and sports.',  launch: false },
  { id: 'explosive_strength',    label: 'Explosive Strength',       category: 'strength', description: 'Power cleans, box jumps, medicine ball throws. Trains fast-twitch muscle fibres for explosive force production.',  launch: false },
  { id: 'relative_strength',     label: 'Relative Strength',        category: 'strength', description: 'Get stronger without gaining bodyweight. Eat at maintenance, train heavy with low reps. Great for weight-class sports or calisthenics.',  launch: false },

  // ── Cardio & Endurance ─────────────────────────────────────────────────────
  { id: 'improve_cardio',       label: 'Improve Cardio Fitness',    category: 'cardio_endurance', description: 'Mix of steady-state and interval cardio 3-5x/week. Improves heart health, lung capacity, and overall endurance.',  launch: true },
  { id: 'improve_conditioning', label: 'Improve Conditioning',      category: 'cardio_endurance', description: 'Circuits, HIIT, and metabolic finishers. Builds work capacity so you recover faster between sets and last longer in workouts.',  launch: false },
  { id: 'aerobic_base',         label: 'Improve Aerobic Base',      category: 'cardio_endurance', description: 'Zone 2 cardio (conversational pace) 3-5x/week for 30-60 min. Builds the aerobic engine that all other fitness depends on.',  launch: false },
  { id: 'improve_vo2',          label: 'Improve VO2 Max',           category: 'cardio_endurance', description: 'High-intensity intervals at 90-95% max heart rate. Pushes your oxygen uptake ceiling higher. Hard but effective.',  launch: false },
  { id: 'increase_stamina',     label: 'Increase Stamina',          category: 'cardio_endurance', description: 'Gradually longer sessions to build the ability to sustain effort. You will last longer in any physical activity.',  launch: false },
  { id: 'running_fitness',      label: 'Improve Running Fitness',   category: 'cardio_endurance', description: 'Structured running with easy runs, tempo runs, and intervals. Become a more efficient, faster runner.',  launch: false },
  { id: 'train_5k',             label: 'Train for a 5K',            category: 'cardio_endurance', description: 'Couch to 5K or PR your time. Structured plan building from walk/run intervals to continuous 5K runs.',  launch: false },
  { id: 'train_10k',            label: 'Train for a 10K',           category: 'cardio_endurance', description: 'Build endurance for a solid 10K. Includes long runs, tempo work, and recovery sessions.',  launch: false },
  { id: 'train_half',           label: 'Train for a Half Marathon', category: 'cardio_endurance', description: '12-16 week half marathon build-up with progressive long runs, speed work, and taper.',  launch: false },
  { id: 'train_marathon',       label: 'Train for a Marathon',      category: 'cardio_endurance', description: '16-20 week marathon plan. Long runs up to 20 miles, nutrition strategy, and race-day pacing.',  launch: false },
  { id: 'sprint_speed',         label: 'Improve Sprint Speed',      category: 'cardio_endurance', description: 'Short sprints (10-100m), hill sprints, and plyometrics. Builds top-end speed and acceleration.',  launch: false },
  { id: 'interval_perf',        label: 'Improve Interval Performance', category: 'cardio_endurance', description: 'HIIT-focused: Tabata, EMOM, and interval circuits. Better recovery between bursts of effort.',  launch: false },
  { id: 'hiking_endurance',     label: 'Improve Hiking Endurance',  category: 'cardio_endurance', description: 'Incline treadmill, stair climber, weighted vest walks, and leg endurance. Go longer on the trail with less fatigue.',  launch: false },
  { id: 'cycling_endurance',    label: 'Improve Cycling Endurance', category: 'cardio_endurance', description: 'Structured cycling with base miles, threshold work, and intervals. Better stamina and power on the bike.',  launch: false },
  { id: 'rowing_endurance',     label: 'Improve Rowing Endurance',  category: 'cardio_endurance', description: 'Row-focused conditioning with steady-state and interval pieces. Builds full-body endurance and rowing technique.',  launch: false },
  { id: 'swimming_endurance',   label: 'Improve Swimming Endurance', category: 'cardio_endurance', description: 'Lap-based swim training with drills and sets. Build efficiency in the water and swim longer without tiring.',  launch: false },
  { id: 'work_capacity',        label: 'Improve Work Capacity',     category: 'cardio_endurance', description: 'Handle more total training volume. Shorter rest periods, supersets, and density blocks. Recover faster between sessions.',  launch: false },

  // ── Athletic Performance ───────────────────────────────────────────────────
  { id: 'improve_athleticism',  label: 'Improve Athleticism',       category: 'athletic_performance', description: 'Blend of strength, speed, agility, and conditioning. Makes you a well-rounded athlete ready for any physical challenge.',  launch: true },
  { id: 'improve_speed',        label: 'Improve Speed',             category: 'athletic_performance', description: 'Sprint training, plyometrics, and hip flexor work. Run faster over short and medium distances.',  launch: false },
  { id: 'improve_agility',      label: 'Improve Agility',           category: 'athletic_performance', description: 'Cone drills, ladder work, and reactive cutting. Move quicker in all directions with better body control.',  launch: false },
  { id: 'improve_power',        label: 'Improve Power',             category: 'athletic_performance', description: 'Olympic lift variations, box jumps, and throws. Train your muscles to produce maximum force in minimum time.',  launch: false },
  { id: 'improve_vertical',     label: 'Improve Vertical Jump',     category: 'athletic_performance', description: 'Plyometrics, depth jumps, and squat strength. Increase how high you can jump for basketball, volleyball, or athletics.',  launch: false },
  { id: 'improve_acceleration', label: 'Improve Acceleration',      category: 'athletic_performance', description: 'Sled pushes, short sprints, and start mechanics. Get faster in the first 10-20 metres.',  launch: false },
  { id: 'improve_cod',          label: 'Improve Change of Direction', category: 'athletic_performance', description: 'Lateral shuffles, T-drills, and deceleration training. Cut and change direction faster with less injury risk.',  launch: false },
  { id: 'improve_coordination', label: 'Improve Coordination',      category: 'athletic_performance', description: 'Multi-planar movements, balance drills, and skill-based exercises. Better body awareness and motor control.',  launch: false },
  { id: 'improve_balance',      label: 'Improve Balance',           category: 'athletic_performance', description: 'Single-leg work, stability exercises, and proprioception drills. Better balance for sport and daily life.',  launch: false },
  { id: 'sport_performance',    label: 'Sport Performance',         category: 'athletic_performance', description: 'Training tailored to your specific sport. Builds the exact physical qualities your sport demands.',  launch: false },
  { id: 'offseason_training',   label: 'Off-Season Training',       category: 'athletic_performance', description: 'Build strength, size, and fix weaknesses when you are not competing. Higher volume, more muscle building.',  launch: false },
  { id: 'inseason_maintenance', label: 'In-Season Maintenance',     category: 'athletic_performance', description: 'Lower volume to stay strong and healthy during your competitive season without adding fatigue.',  launch: false },
  { id: 'return_to_sport',      label: 'Return to Sport Conditioning', category: 'athletic_performance', description: 'Gradual ramp-up after a break or injury. Rebuilds fitness base before full sport-specific training.',  launch: false },
  { id: 'hyrox',               label: 'HYROX / Hybrid Race',          category: 'athletic_performance', description: 'Train for HYROX, Deka, or hybrid fitness races. Running, intervals, sled push/pull, wall balls, lunges, rowing, and burpees. Conditioning-heavy with functional strength.',  launch: true },

  // ── Health & Longevity ─────────────────────────────────────────────────────
  { id: 'general_health',      label: 'General Health',             category: 'health_longevity', description: 'Balanced mix of strength, cardio, and mobility. No extreme goals — just consistent, well-rounded fitness for feeling good.',  launch: false },
  { id: 'longevity',           label: 'Longevity',                  category: 'health_longevity', description: 'Train to stay strong and mobile into old age. Emphasises bone density, muscle preservation, balance, and heart health. The "train for the next 50 years" goal.',  launch: true },
  { id: 'healthy_aging',       label: 'Healthy Aging',              category: 'health_longevity', description: 'Age-appropriate exercise with joint-friendly movements, balance work, and progressive resistance. Stay independent and active as you age.',  launch: false },
  { id: 'heart_health',        label: 'Improve Heart Health',       category: 'health_longevity', description: 'Cardio 4-5x/week at moderate intensity. Lowers blood pressure, improves cholesterol, and strengthens the heart muscle.',  launch: false },
  { id: 'metabolic_health',    label: 'Improve Metabolic Health',   category: 'health_longevity', description: 'Resistance training + walking to improve insulin sensitivity, blood sugar regulation, and metabolic rate. Great for pre-diabetic or metabolic syndrome.',  launch: false },
  { id: 'improve_energy',      label: 'Improve Energy',             category: 'health_longevity', description: 'Regular moderate exercise to boost daily energy levels. Better sleep, less afternoon crashes, and more vitality throughout the day.',  launch: false },
  { id: 'daily_function',      label: 'Improve Daily Function',     category: 'health_longevity', description: 'Exercises that make everyday tasks easier — carrying groceries, climbing stairs, playing with kids. Practical, functional movements.',  launch: false },
  { id: 'stay_active',         label: 'Stay Active',                category: 'health_longevity', description: 'Light to moderate activity most days. Walking, bodyweight exercises, and easy cardio. Keeps you moving without pushing hard.',  launch: false },
  { id: 'maintain_mobility',   label: 'Maintain Mobility',          category: 'health_longevity', description: 'Daily stretching and mobility work to keep joints moving freely. Prevents stiffness and maintains range of motion you already have.',  launch: false },
  { id: 'improve_mobility',    label: 'Improve Mobility',           category: 'health_longevity', description: 'Active stretching, loaded stretches, and joint CARs to increase range of motion. Helps if you feel stiff or restricted in movements.',  launch: false },
  { id: 'improve_flexibility', label: 'Improve Flexibility',        category: 'health_longevity', description: 'Yoga, stretching, and mobility work to improve range of motion and recovery.',  launch: false },
  { id: 'improve_posture',     label: 'Improve Posture',            category: 'health_longevity', description: 'Strengthens weak upper back and core while stretching tight chest and hip flexors. Fixes the "desk worker" posture.',  launch: false },
  { id: 'bone_health',         label: 'Bone Health',                category: 'health_longevity', description: 'Weight-bearing and resistance exercises to increase bone mineral density. Important for women and anyone over 40.',  launch: false },
  { id: 'joint_health',        label: 'Joint Health',               category: 'health_longevity', description: 'Low-impact resistance training, isometrics, and controlled mobility. Strengthens tendons and cartilage around joints.',  launch: false },
  { id: 'stress_exercise',     label: 'Reduce Stress Through Exercise', category: 'health_longevity', description: 'Moderate exercise as a stress outlet. Includes both intense sessions (to burn off stress) and calming movement (yoga, walks).',  launch: false },

  // ── Lifestyle & Consistency ────────────────────────────────────────────────
  { id: 'build_consistency',   label: 'Build Consistency',          category: 'lifestyle_consistency', description: 'Start with 2-3 short sessions/week and build up. The goal is showing up regularly — intensity increases as the habit sticks.',  launch: false },
  { id: 'beginner_fitness',    label: 'Beginner Fitness',           category: 'lifestyle_consistency', description: 'Never trained before? This starts with basic movements, light weights, and simple progressions. No experience needed.',  launch: false },
  { id: 'get_back_in_shape',   label: 'Get Back Into Shape',        category: 'lifestyle_consistency', description: 'Returning after months or years off. Starts below your old level and ramps up safely to avoid injury and burnout.',  launch: false },
  { id: 'quick_workouts',      label: 'Quick Workouts',             category: 'lifestyle_consistency', description: 'Full-body sessions in 20-30 minutes. Supersets and circuits to maximise results in minimal time.',  launch: false },
  { id: 'busy_schedule',       label: 'Exercise for Busy Schedule', category: 'lifestyle_consistency', description: 'Flexible sessions that fit around work and family. Short, effective workouts you can do whenever you have time.',  launch: false },
  { id: 'home_fitness',        label: 'Home Fitness',               category: 'lifestyle_consistency', description: 'Bodyweight, dumbbells, and bands at home. No gym membership needed. Effective programmes for any space.',  launch: false },
  { id: 'travel_training',     label: 'Travel-Friendly Training',   category: 'lifestyle_consistency', description: 'Hotel room and park-friendly workouts. Bodyweight and resistance band exercises you can do anywhere.',  launch: false },
  { id: 'low_stress_training', label: 'Low-Stress Training',        category: 'lifestyle_consistency', description: 'Easy, enjoyable movement that does not tax your recovery. Walking, light weights, yoga, and swimming. Good during high-stress life periods.',  launch: false },
  { id: 'minimal_equipment',   label: 'Minimal Equipment Fitness',  category: 'lifestyle_consistency', description: 'Just a pair of dumbbells or a pull-up bar. Smart programming to get real results with very little gear.',  launch: false },
  { id: 'habit_building',      label: 'Habit Building',             category: 'lifestyle_consistency', description: 'Focus on consistency over intensity. Even 10 minutes counts. Builds the daily exercise habit that everything else depends on.',  launch: false },
  { id: 'sustainable_routine', label: 'Sustainable Fitness Routine', category: 'lifestyle_consistency', description: 'A balanced, moderate programme you can stick with for years. Not extreme, not easy — just right for long-term health.',  launch: false },
  { id: 'maintain',            label: 'Maintain',                   category: 'lifestyle_consistency', description: 'Keep your current fitness level with minimal effort. 2-3 sessions/week at moderate intensity. No progression pressure.',  launch: true },
];

// ─── Quick-launch goals (shown prominently in onboarding step 1) ─────────────

export const LAUNCH_GOALS = PRIMARY_GOALS.filter(g => g.launch);

// ─── Goal → Category lookup ──────────────────────────────────────────────────

const _goalCategoryMap = new Map(PRIMARY_GOALS.map(g => [g.id, g.category]));
export function goalCategory(goalId: string): GoalCategoryId | undefined {
  return _goalCategoryMap.get(goalId);
}

// ─── Modifiers ───────────────────────────────────────────────────────────────

export interface GoalModifierDef {
  id: string;
  label: string;
  /** Which categories this modifier is relevant to */
  categories: GoalCategoryId[];
}

export const GOAL_MODIFIERS: GoalModifierDef[] = [
  // Physique
  { id: 'lean_gain',             label: 'Lean gain',             categories: ['muscle_physique'] },
  { id: 'minimize_fat_gain',     label: 'Minimise fat gain',     categories: ['muscle_physique'] },
  { id: 'aesthetic_emphasis',    label: 'Aesthetic emphasis',     categories: ['muscle_physique'] },
  { id: 'symmetry_focus',        label: 'Symmetry focus',        categories: ['muscle_physique'] },
  { id: 'preserve_muscle',       label: 'Preserve muscle',       categories: ['muscle_physique', 'fat_loss'] },
  { id: 'definition_focus',      label: 'Definition focus',      categories: ['muscle_physique', 'fat_loss'] },
  { id: 'glute_emphasis',        label: 'Glute emphasis',        categories: ['muscle_physique'] },
  { id: 'shoulder_emphasis',     label: 'Shoulder emphasis',     categories: ['muscle_physique'] },
  { id: 'vtaper_emphasis',       label: 'V-taper emphasis',      categories: ['muscle_physique'] },
  { id: 'leg_emphasis',          label: 'Leg emphasis',          categories: ['muscle_physique'] },
  { id: 'arm_growth',            label: 'Arm growth emphasis',   categories: ['muscle_physique'] },

  // Strength
  { id: 'powerlifting_style',    label: 'Powerlifting-style',    categories: ['strength'] },
  { id: 'hypertrophy_supported', label: 'Hypertrophy-supported', categories: ['strength'] },
  { id: 'compound_emphasis',     label: 'Compound lift emphasis', categories: ['strength', 'muscle_physique'] },
  { id: 'technique_emphasis',    label: 'Technique emphasis',    categories: ['strength'] },
  { id: 'barbell_focused',       label: 'Barbell focused',       categories: ['strength', 'muscle_physique'] },
  { id: 'dumbbell_focused',      label: 'Dumbbell focused',      categories: ['strength', 'muscle_physique'] },
  { id: 'machine_supported',     label: 'Machine supported',     categories: ['strength', 'muscle_physique'] },
  { id: 'joint_friendly',        label: 'Joint-friendly',        categories: ['strength', 'health_longevity'] },
  { id: 'explosive_emphasis',    label: 'Explosive emphasis',    categories: ['strength', 'athletic_performance'] },
  { id: 'relative_strength_focus', label: 'Relative strength focus', categories: ['strength'] },
  { id: 'low_rep_emphasis',      label: 'Low rep emphasis',      categories: ['strength'] },
  { id: 'accessory_emphasis',    label: 'Accessory emphasis',    categories: ['strength'] },

  // Cardio / Endurance
  { id: 'aerobic_base_focus',    label: 'Aerobic base focus',    categories: ['cardio_endurance'] },
  { id: 'tempo_focus',           label: 'Tempo focus',           categories: ['cardio_endurance'] },
  { id: 'intervals_focus',       label: 'Intervals focus',       categories: ['cardio_endurance'] },
  { id: 'zone2_emphasis',        label: 'Zone 2 emphasis',       categories: ['cardio_endurance', 'health_longevity'] },
  { id: 'speedwork_emphasis',    label: 'Speedwork emphasis',    categories: ['cardio_endurance'] },
  { id: 'long_distance',         label: 'Long-distance emphasis', categories: ['cardio_endurance'] },
  { id: 'race_specific',         label: 'Race-specific',         categories: ['cardio_endurance'] },
  { id: 'low_impact_cardio',     label: 'Low-impact cardio',     categories: ['cardio_endurance', 'health_longevity'] },
  { id: 'outdoor_focused',       label: 'Outdoor focused',       categories: ['cardio_endurance'] },
  { id: 'treadmill_friendly',    label: 'Treadmill friendly',    categories: ['cardio_endurance'] },
  { id: 'cross_training',        label: 'Cross-training emphasis', categories: ['cardio_endurance', 'athletic_performance'] },
  { id: 'hr_guided',             label: 'Heart-rate guided',     categories: ['cardio_endurance', 'health_longevity'] },
  { id: 'endurance_first',       label: 'Endurance-first',       categories: ['cardio_endurance'] },
  { id: 'conditioning_first',    label: 'Conditioning-first',    categories: ['cardio_endurance', 'athletic_performance'] },

  // Athletic
  { id: 'speed_emphasis',        label: 'Speed emphasis',        categories: ['athletic_performance'] },
  { id: 'agility_emphasis',      label: 'Agility emphasis',      categories: ['athletic_performance'] },
  { id: 'power_emphasis',        label: 'Power emphasis',        categories: ['athletic_performance', 'strength'] },
  { id: 'jump_training',         label: 'Jump training',         categories: ['athletic_performance'] },
  { id: 'sprint_mechanics',      label: 'Sprint mechanics',      categories: ['athletic_performance'] },
  { id: 'mobility_supported',    label: 'Mobility-supported',    categories: ['athletic_performance', 'health_longevity'] },
  { id: 'injury_risk_aware',     label: 'Injury-risk-aware',     categories: ['athletic_performance'] },
  { id: 'sport_specific',        label: 'Sport-specific',        categories: ['athletic_performance'] },
  { id: 'offseason_hypertrophy', label: 'Off-season hypertrophy', categories: ['athletic_performance'] },
  { id: 'inseason_maint',        label: 'In-season maintenance', categories: ['athletic_performance'] },

  // Health / Longevity
  { id: 'longevity_focused',     label: 'Longevity-focused',     categories: ['health_longevity'] },
  { id: 'heart_health_focused',  label: 'Heart-health focused',  categories: ['health_longevity'] },
  { id: 'mobility_first',        label: 'Mobility-first',        categories: ['health_longevity'] },
  { id: 'flexibility_first',     label: 'Flexibility-first',     categories: ['health_longevity'] },
  { id: 'bone_health_support',   label: 'Bone health support',   categories: ['health_longevity'] },
  { id: 'energy_focused',        label: 'Energy-focused',        categories: ['health_longevity'] },
  { id: 'stress_mgmt_focused',   label: 'Stress-management focused', categories: ['health_longevity'] },
  { id: 'low_impact',            label: 'Low-impact',            categories: ['health_longevity', 'lifestyle_consistency'] },
  { id: 'daily_movement',        label: 'Daily movement emphasis', categories: ['health_longevity'] },
  { id: 'sustainable_habit',     label: 'Sustainable habit focus', categories: ['health_longevity', 'lifestyle_consistency'] },
  { id: 'functional_movement',   label: 'Functional movement emphasis', categories: ['health_longevity'] },

  // Lifestyle
  { id: 'time_efficient',        label: 'Time-efficient',        categories: ['lifestyle_consistency'] },
  { id: '20min_workouts',        label: '20-minute workouts',    categories: ['lifestyle_consistency'] },
  { id: '30min_workouts',        label: '30-minute workouts',    categories: ['lifestyle_consistency'] },
  { id: '45min_workouts',        label: '45-minute workouts',    categories: ['lifestyle_consistency'] },
  { id: 'home_gym',              label: 'Home gym',              categories: ['lifestyle_consistency'] },
  { id: 'commercial_gym',        label: 'Commercial gym',        categories: ['lifestyle_consistency'] },
  { id: 'minimal_equip',         label: 'Minimal equipment',     categories: ['lifestyle_consistency'] },
  { id: 'bodyweight_friendly',   label: 'Bodyweight-friendly',   categories: ['lifestyle_consistency'] },
  { id: 'travel_friendly',       label: 'Travel-friendly',       categories: ['lifestyle_consistency'] },
  { id: 'parent_friendly',       label: 'Parent-friendly',       categories: ['lifestyle_consistency'] },
  { id: 'morning_friendly',      label: 'Morning-friendly',      categories: ['lifestyle_consistency'] },
  { id: 'evening_friendly',      label: 'Evening-friendly',      categories: ['lifestyle_consistency'] },
  { id: 'low_motivation',        label: 'Low motivation friendly', categories: ['lifestyle_consistency'] },
  { id: 'consistency_first',     label: 'Consistency-first',     categories: ['lifestyle_consistency'] },
  { id: 'recovery_friendly',     label: 'Recovery-friendly',     categories: ['lifestyle_consistency', 'health_longevity'] },
  { id: 'beginner_friendly',     label: 'Beginner-friendly',     categories: ['lifestyle_consistency'] },
  { id: 'advanced',              label: 'Advanced',              categories: ['lifestyle_consistency', 'strength', 'muscle_physique'] },

  // Nutrition-related (shown for any goal)
  { id: 'high_protein',          label: 'High protein',          categories: ['muscle_physique', 'fat_loss', 'strength'] },
  { id: 'higher_carb',           label: 'Higher carb',           categories: ['cardio_endurance', 'athletic_performance', 'strength'] },
  { id: 'lower_carb',            label: 'Lower carb',            categories: ['fat_loss'] },
  { id: 'balanced_diet',         label: 'Balanced diet',         categories: ['health_longevity', 'lifestyle_consistency'] },
  { id: 'meal_prep_friendly',    label: 'Meal-prep friendly',    categories: ['lifestyle_consistency', 'fat_loss', 'muscle_physique'] },
  { id: 'budget_friendly',       label: 'Budget friendly',       categories: ['lifestyle_consistency'] },
  { id: 'high_satiety',          label: 'High satiety',          categories: ['fat_loss'] },
  { id: 'appetite_control',      label: 'Appetite control',      categories: ['fat_loss'] },
  { id: 'performance_fueling',   label: 'Performance fueling',   categories: ['athletic_performance', 'cardio_endurance', 'strength'] },
  { id: 'recovery_fueling',      label: 'Recovery fueling',      categories: ['muscle_physique', 'strength', 'athletic_performance'] },
  { id: 'easy_cooking',          label: 'Easy cooking',          categories: ['lifestyle_consistency'] },
  { id: 'family_friendly_meals', label: 'Family-friendly meals', categories: ['lifestyle_consistency'] },
  { id: 'vegetarian_friendly',   label: 'Vegetarian-friendly',   categories: ['health_longevity', 'lifestyle_consistency'] },
  { id: 'vegan_friendly',        label: 'Vegan-friendly',        categories: ['health_longevity', 'lifestyle_consistency'] },
  { id: 'dairy_free',            label: 'Dairy-free',            categories: ['health_longevity', 'lifestyle_consistency'] },
  { id: 'gluten_conscious',      label: 'Gluten-conscious',      categories: ['health_longevity', 'lifestyle_consistency'] },
];

/** Return only modifiers relevant to a given goal's category */
export function modifiersForGoal(goalId: string): GoalModifierDef[] {
  const cat = goalCategory(goalId);
  if (!cat) return [];
  return GOAL_MODIFIERS.filter(m => m.categories.includes(cat));
}

// ─── Target Focus ────────────────────────────────────────────────────────────

export interface TargetFocusDef {
  id: string;
  label: string;
  group: 'muscle' | 'lift' | 'activity' | 'wellness';
}

export const TARGET_FOCUSES: TargetFocusDef[] = [
  // Muscles
  { id: 'chest',      label: 'Chest',      group: 'muscle' },
  { id: 'back',       label: 'Back',       group: 'muscle' },
  { id: 'shoulders',  label: 'Shoulders',  group: 'muscle' },
  { id: 'arms',       label: 'Arms',       group: 'muscle' },
  { id: 'biceps',     label: 'Biceps',     group: 'muscle' },
  { id: 'triceps',    label: 'Triceps',    group: 'muscle' },
  { id: 'forearms',   label: 'Forearms',   group: 'muscle' },
  { id: 'glutes',     label: 'Glutes',     group: 'muscle' },
  { id: 'quads',      label: 'Quads',      group: 'muscle' },
  { id: 'hamstrings', label: 'Hamstrings', group: 'muscle' },
  { id: 'calves',     label: 'Calves',     group: 'muscle' },
  { id: 'core',       label: 'Core',       group: 'muscle' },
  { id: 'upper_body', label: 'Upper Body', group: 'muscle' },
  { id: 'lower_body', label: 'Lower Body', group: 'muscle' },

  // Lifts
  { id: 'squat',     label: 'Squat',          group: 'lift' },
  { id: 'bench',     label: 'Bench',          group: 'lift' },
  { id: 'deadlift',  label: 'Deadlift',       group: 'lift' },
  { id: 'ohp',       label: 'Overhead Press',  group: 'lift' },
  { id: 'pullups',   label: 'Pull-Ups',        group: 'lift' },

  // Activities
  { id: 'running',   label: 'Running',     group: 'activity' },
  { id: 'sprinting', label: 'Sprinting',   group: 'activity' },
  { id: 'hiking',    label: 'Hiking',      group: 'activity' },
  { id: 'cycling',   label: 'Cycling',     group: 'activity' },
  { id: 'swimming',  label: 'Swimming',    group: 'activity' },
  { id: 'rowing',    label: 'Rowing',      group: 'activity' },

  // Wellness
  { id: 'posture',          label: 'Posture',           group: 'wellness' },
  { id: 'mobility',         label: 'Mobility',          group: 'wellness' },
  { id: 'flexibility',      label: 'Flexibility',       group: 'wellness' },
  { id: 'daily_energy',     label: 'Daily Energy',      group: 'wellness' },
  { id: 'heart_health_tf',  label: 'Heart Health',      group: 'wellness' },
  { id: 'stress_management', label: 'Stress Management', group: 'wellness' },
];

/** Filter target focuses relevant to a goal's category */
export function targetFocusesForGoal(goalId: string): TargetFocusDef[] {
  const cat = goalCategory(goalId);
  if (!cat) return TARGET_FOCUSES;
  const groupMap: Record<GoalCategoryId, TargetFocusDef['group'][]> = {
    muscle_physique:       ['muscle', 'lift'],
    fat_loss:              ['muscle', 'activity', 'wellness'],
    strength:              ['lift', 'muscle'],
    cardio_endurance:      ['activity', 'wellness'],
    athletic_performance:  ['activity', 'muscle', 'lift'],
    health_longevity:      ['wellness', 'activity'],
    lifestyle_consistency: ['wellness', 'activity', 'muscle'],
  };
  const groups = groupMap[cat] ?? ['muscle', 'lift', 'activity', 'wellness'];
  return TARGET_FOCUSES.filter(tf => groups.includes(tf.group));
}

// ─── Goal training profile (used by AI prompt) ──────────────────────────────

export interface GoalTrainingProfile {
  programStyle: string;       // e.g. "hypertrophy", "strength", "cardio-dominant"
  repRange: string;           // e.g. "6-12", "1-5", "12-20"
  restSeconds: string;        // e.g. "60-120", "120-300"
  intensity: string;          // e.g. "moderate", "high", "low"
  cardioRole: string;         // e.g. "none", "finisher", "primary"
  nutritionBias: string;      // e.g. "surplus", "deficit", "maintenance"
}

/**
 * Map a primary goal to its training profile for AI prompts.
 * Falls back to the category's default when no goal-specific entry exists.
 */
export function getTrainingProfile(goalId: string): GoalTrainingProfile {
  const cat = goalCategory(goalId);
  const categoryDefaults: Record<GoalCategoryId, GoalTrainingProfile> = {
    muscle_physique: {
      programStyle: 'hypertrophy',
      repRange: '6-12',
      restSeconds: '60-120',
      intensity: 'moderate-high',
      cardioRole: 'none or minimal finisher',
      nutritionBias: 'surplus',
    },
    fat_loss: {
      programStyle: 'strength-preserving deficit training',
      repRange: '8-15',
      restSeconds: '45-90',
      intensity: 'moderate',
      cardioRole: 'finisher each session or dedicated sessions',
      nutritionBias: 'deficit',
    },
    strength: {
      programStyle: 'strength / powerlifting',
      repRange: '1-6',
      restSeconds: '120-300',
      intensity: 'high',
      cardioRole: 'none',
      nutritionBias: 'surplus or maintenance',
    },
    cardio_endurance: {
      programStyle: 'endurance / conditioning',
      repRange: '12-20 for accessory',
      restSeconds: '30-60',
      intensity: 'moderate',
      cardioRole: 'primary',
      nutritionBias: 'maintenance or slight surplus',
    },
    athletic_performance: {
      programStyle: 'athletic / power-speed',
      repRange: '3-8 for power, 8-12 for accessory',
      restSeconds: '90-180',
      intensity: 'high',
      cardioRole: 'conditioning sessions',
      nutritionBias: 'maintenance or slight surplus',
    },
    health_longevity: {
      programStyle: 'balanced / joint-friendly',
      repRange: '8-15',
      restSeconds: '60-90',
      intensity: 'low-moderate',
      cardioRole: 'mixed — Zone 2 + light strength',
      nutritionBias: 'maintenance',
    },
    lifestyle_consistency: {
      programStyle: 'sustainable / habit-building',
      repRange: '8-15',
      restSeconds: '60-90',
      intensity: 'moderate',
      cardioRole: 'optional — user preference',
      nutritionBias: 'maintenance',
    },
  };

  // Goal-specific overrides
  const overrides: Record<string, Partial<GoalTrainingProfile>> = {
    body_recomp:      { nutritionBias: 'maintenance (slight deficit on rest, slight surplus on training)', repRange: '8-12' },
    lean_bulk:        { nutritionBias: 'slight surplus (+200-300)', repRange: '6-12' },
    cut:              { nutritionBias: 'aggressive deficit', intensity: 'moderate-high' },
    powerlifting:     { repRange: '1-5', restSeconds: '180-300', intensity: 'very high' },
    improve_1rm:      { repRange: '1-3 peak, 3-6 volume', restSeconds: '180-300' },
    train_5k:         { programStyle: 'running-focused with light strength', cardioRole: 'primary — run 3-4x/week' },
    train_10k:        { programStyle: 'running-focused with light strength', cardioRole: 'primary — run 4-5x/week' },
    train_half:       { programStyle: 'running-focused', cardioRole: 'primary — run 4-5x/week with long run' },
    train_marathon:   { programStyle: 'running-focused', cardioRole: 'primary — run 5-6x/week with long run' },
    longevity:        { programStyle: 'longevity — Zone 2 cardio + joint-friendly strength', cardioRole: 'Zone 2 cardio 3x/week' },
    quick_workouts:   { programStyle: 'time-efficient — supersets and circuits', restSeconds: '30-45' },
    beginner_fitness: { intensity: 'low-moderate', programStyle: 'beginner — full body, simple movements' },
    maintain:         { programStyle: 'maintenance — moderate across all modalities', nutritionBias: 'maintenance' },
  };

  const base = categoryDefaults[cat ?? 'lifestyle_consistency'];
  const goalOverrides = overrides[goalId] ?? {};
  return { ...base, ...goalOverrides };
}
