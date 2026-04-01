import { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Image,
  ActivityIndicator,
} from 'react-native';
import { colors, radius } from '../constants/theme';
import {
  Goal, GoalPace, Gender, UserProfile, PhysicalStats, GoalDetails,
} from '../types';
import { useMetaData, pacesForGoal } from '../hooks/useMetaData';

const logo = require('../../assets/images/logo.png');

// ─── Step logic ───────────────────────────────────────────────────────────────

type StepKey = 'goal' | 'goalDetails' | 'physicalStats' | 'trainingDays' | 'equipment' | 'foods';

function getSteps(goal: Goal, lifestyleGoals: Set<string>): StepKey[] {
  if (lifestyleGoals.has(goal)) {
    return ['goal', 'physicalStats', 'trainingDays', 'equipment', 'foods'];
  }
  return ['goal', 'goalDetails', 'physicalStats', 'trainingDays', 'equipment', 'foods'];
}

// ─── Component ────────────────────────────────────────────────────────────────

interface OnboardingScreenProps {
  onComplete: (profile: UserProfile) => void;
}

export default function OnboardingScreen({ onComplete }: OnboardingScreenProps) {
  const meta = useMetaData();

  const weightGoals   = new Set(meta.goalConfig.weight_goals);
  const timelineGoals = new Set(meta.goalConfig.timeline_goals);
  const lifestyleGoals= new Set(meta.goalConfig.lifestyle_goals);

  // Step tracking
  const [currentStep, setCurrentStep] = useState(0);

  // Step 1 — Goal
  const [goal, setGoal] = useState<Goal>('fat_loss');

  // Step 2 — Goal details
  const [pace, setPace] = useState<GoalPace>('moderate');
  const [targetWeight, setTargetWeight] = useState('');

  // Step 3 — Physical stats
  const [weightLbs, setWeightLbs] = useState('');
  const [heightFeet, setHeightFeet] = useState('');
  const [heightInches, setHeightInches] = useState('');
  const [age, setAge] = useState('');
  const [gender, setGender] = useState<Gender | ''>('');

  // Step 4 — Training days
  const [daysPerWeek, setDaysPerWeek] = useState('3');
  const [workoutDuration, setWorkoutDuration] = useState(60);

  // Step 5 — Equipment
  const [selectedEquipment, setSelectedEquipment] = useState<string[]>([]);

  // Step 6 — Foods
  const [foodsAvailable, setFoodsAvailable] = useState<string[]>([]);

  const steps = getSteps(goal, lifestyleGoals);
  const totalSteps = steps.length;
  const currentStepKey = steps[currentStep];

  const toggleEquipment = (eq: string) => {
    setSelectedEquipment(prev =>
      prev.includes(eq) ? prev.filter(e => e !== eq) : [...prev, eq]
    );
  };

  const validate = (): string | null => {
    switch (currentStepKey) {
      case 'goalDetails':
        if (weightGoals.has(goal) && targetWeight) {
          const tw = parseFloat(targetWeight);
          if (isNaN(tw) || tw < 50 || tw > 500) return 'Enter a valid target weight (50–500 lbs)';
        }
        return null;
      case 'physicalStats': {
        const w = parseFloat(weightLbs);
        const hf = parseInt(heightFeet);
        const hi = parseInt(heightInches);
        const a = parseInt(age);
        if (isNaN(w) || w < 50 || w > 600) return 'Enter a valid weight (50–600 lbs)';
        if (isNaN(hf) || hf < 3 || hf > 8) return 'Enter a valid height';
        if (isNaN(hi) || hi < 0 || hi > 11) return 'Inches must be between 0–11';
        if (isNaN(a) || a < 13 || a > 100) return 'Enter a valid age (13–100)';
        if (!gender) return 'Please select a gender option';
        return null;
      }
      case 'trainingDays': {
        const d = parseInt(daysPerWeek);
        if (isNaN(d) || d < 1 || d > 7) return 'Enter a number between 1–7';
        return null;
      }
      case 'equipment':
        if (selectedEquipment.length === 0) return 'Select at least one equipment option';
        return null;
      default:
        return null;
    }
  };

  const handleNext = () => {
    const error = validate();
    if (error) { Alert.alert('Hold on', error); return; }

    if (currentStep < totalSteps - 1) {
      if (currentStepKey === 'goal') setPace('moderate');
      setCurrentStep(s => s + 1);
    } else {
      handleComplete();
    }
  };

  const handleBack = () => {
    if (currentStep > 0) setCurrentStep(s => s - 1);
  };

  const handleComplete = () => {
    const goalDetails: GoalDetails = {
      pace,
      targetWeightLbs: weightGoals.has(goal) && targetWeight ? parseFloat(targetWeight) : undefined,
      timelineWeeks:   timelineGoals.has(goal)
        ? (meta.goalConfig.timeline_weeks[goal]?.[pace] ?? undefined)
        : undefined,
    };

    const physicalStats: PhysicalStats = {
      weightLbs:    parseFloat(weightLbs),
      heightFeet:   parseInt(heightFeet),
      heightInches: parseInt(heightInches),
      age:          parseInt(age),
      gender:       gender as Gender,
    };

    onComplete({
      goal,
      goalDetails,
      physicalStats,
      daysPerWeek:            parseInt(daysPerWeek),
      workoutDurationMinutes: workoutDuration,
      equipment:              selectedEquipment,
      foodsAvailable,
      customFoods: [],
    });
  };

  // ─── Step renderers ─────────────────────────────────────────────────────────

  const renderGoalStep = () => (
    <View style={styles.stepContainer}>
      <Text style={styles.stepTitle}>What's Your Goal?</Text>
      <Text style={styles.stepDescription}>Choose the one that best matches what you want to achieve</Text>
      {meta.loading ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: 40 }} />
      ) : (
        <View style={styles.goalGrid}>
          {meta.goals.map(opt => {
            const active = goal === opt.value;
            return (
              <TouchableOpacity
                key={opt.value}
                style={[styles.goalCard, active && styles.goalCardActive]}
                onPress={() => setGoal(opt.value as Goal)}
                activeOpacity={0.75}
              >
                <Text style={styles.goalIcon}>{opt.icon}</Text>
                <Text style={[styles.goalLabel, active && styles.goalLabelActive]}>{opt.label}</Text>
                <Text style={[styles.goalDesc, active && styles.goalDescActive]}>{opt.description}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
      )}
    </View>
  );

  const renderGoalDetailsStep = () => {
    const paceOpts = pacesForGoal(goal, meta.paces);
    const showTargetWeight = weightGoals.has(goal);
    const goalLabel = meta.goals.find(g => g.value === goal)?.label ?? '';

    return (
      <View style={styles.stepContainer}>
        <Text style={styles.stepTitle}>Set Your Target</Text>
        <Text style={styles.stepDescription}>
          How do you want to approach {goalLabel.toLowerCase()}?
        </Text>

        {showTargetWeight && (
          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>
              Target weight <Text style={styles.optional}>(optional)</Text>
            </Text>
            <View style={styles.inlineInput}>
              <TextInput
                style={[styles.input, { flex: 1 }]}
                placeholder="e.g. 160"
                placeholderTextColor={colors.textMuted}
                keyboardType="decimal-pad"
                value={targetWeight}
                onChangeText={setTargetWeight}
              />
              <Text style={styles.unit}>lbs</Text>
            </View>
          </View>
        )}

        <Text style={styles.fieldLabel}>How fast?</Text>
        <View style={styles.paceCards}>
          {paceOpts.map(opt => {
            const active = pace === opt.value;
            return (
              <TouchableOpacity
                key={opt.value}
                style={[styles.paceCard, active && styles.paceCardActive]}
                onPress={() => setPace(opt.value as GoalPace)}
                activeOpacity={0.75}
              >
                <Text style={styles.paceIcon}>{opt.icon}</Text>
                <Text style={[styles.paceLabel, active && styles.paceLabelActive]}>{opt.label}</Text>
                <Text style={[styles.paceRate, active && styles.paceRateActive]}>{opt.rate}</Text>
                <Text style={[styles.paceDesc, active && styles.paceDescActive]}>{opt.description}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>
    );
  };

  const renderPhysicalStatsStep = () => (
    <View style={styles.stepContainer}>
      <Text style={styles.stepTitle}>About You</Text>
      <Text style={styles.stepDescription}>Used to calculate your personalised calorie and macro targets</Text>

      <View style={styles.fieldGroup}>
        <Text style={styles.fieldLabel}>Current weight</Text>
        <View style={styles.inlineInput}>
          <TextInput
            style={[styles.input, { flex: 1 }]}
            placeholder="e.g. 185"
            placeholderTextColor={colors.textMuted}
            keyboardType="decimal-pad"
            value={weightLbs}
            onChangeText={setWeightLbs}
          />
          <Text style={styles.unit}>lbs</Text>
        </View>
      </View>

      <View style={styles.fieldGroup}>
        <Text style={styles.fieldLabel}>Height</Text>
        <View style={styles.heightRow}>
          <View style={[styles.inlineInput, { flex: 1 }]}>
            <TextInput
              style={[styles.input, { flex: 1 }]}
              placeholder="5"
              placeholderTextColor={colors.textMuted}
              keyboardType="number-pad"
              value={heightFeet}
              onChangeText={setHeightFeet}
              maxLength={1}
            />
            <Text style={styles.unit}>ft</Text>
          </View>
          <View style={[styles.inlineInput, { flex: 1 }]}>
            <TextInput
              style={[styles.input, { flex: 1 }]}
              placeholder="10"
              placeholderTextColor={colors.textMuted}
              keyboardType="number-pad"
              value={heightInches}
              onChangeText={setHeightInches}
              maxLength={2}
            />
            <Text style={styles.unit}>in</Text>
          </View>
        </View>
      </View>

      <View style={styles.fieldGroup}>
        <Text style={styles.fieldLabel}>Age</Text>
        <View style={styles.inlineInput}>
          <TextInput
            style={[styles.input, { flex: 1 }]}
            placeholder="e.g. 27"
            placeholderTextColor={colors.textMuted}
            keyboardType="number-pad"
            value={age}
            onChangeText={setAge}
            maxLength={3}
          />
          <Text style={styles.unit}>yrs</Text>
        </View>
      </View>

      <View style={styles.fieldGroup}>
        <Text style={styles.fieldLabel}>Gender</Text>
        <View style={styles.genderRow}>
          {([
            { value: 'male',              label: 'Male' },
            { value: 'female',            label: 'Female' },
            { value: 'nonbinary',         label: 'Non-binary' },
            { value: 'prefer_not_to_say', label: 'Prefer not to say' },
          ] as { value: Gender; label: string }[]).map(opt => (
            <TouchableOpacity
              key={opt.value}
              style={[styles.genderButton, gender === opt.value && styles.genderButtonActive]}
              onPress={() => setGender(opt.value)}
            >
              <Text style={[styles.genderText, gender === opt.value && styles.genderTextActive]}>
                {opt.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>
    </View>
  );

  const DURATION_OPTIONS = [
    { value: 30,  label: '30 min', desc: 'Express' },
    { value: 45,  label: '45 min', desc: 'Standard' },
    { value: 60,  label: '60 min', desc: 'Full' },
    { value: 75,  label: '75 min', desc: 'Extended' },
    { value: 90,  label: '90 min', desc: 'Deep' },
  ];

  const renderTrainingDaysStep = () => (
    <View style={styles.stepContainer}>
      <Text style={styles.stepTitle}>Training Schedule</Text>
      <Text style={styles.stepDescription}>How many days per week can you commit?</Text>
      <View style={styles.inlineInput}>
        <TextInput
          style={[styles.input, { flex: 1 }]}
          placeholder="3"
          placeholderTextColor={colors.textMuted}
          keyboardType="number-pad"
          value={daysPerWeek}
          onChangeText={setDaysPerWeek}
          maxLength={1}
        />
        <Text style={styles.unit}>days/week</Text>
      </View>
      <Text style={styles.hint}>Recommended: 3–4 days for optimal recovery</Text>

      <View style={styles.fieldGroup}>
        <Text style={styles.fieldLabel}>How long per session?</Text>
        <View style={styles.paceCards}>
          {DURATION_OPTIONS.map(opt => (
            <TouchableOpacity
              key={opt.value}
              style={[styles.paceCard, workoutDuration === opt.value && styles.paceCardActive]}
              onPress={() => setWorkoutDuration(opt.value)}>
              <Text style={[styles.paceLabel, workoutDuration === opt.value && styles.paceLabelActive]}>{opt.label}</Text>
              <Text style={[styles.paceDesc, workoutDuration === opt.value && styles.paceDescActive]}>{opt.desc}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>
    </View>
  );

  const renderEquipmentStep = () => (
    <View style={styles.stepContainer}>
      <Text style={styles.stepTitle}>Available Equipment</Text>
      <Text style={styles.stepDescription}>
        Select everything you have access to
        {selectedEquipment.length > 0 ? `  ·  ${selectedEquipment.length} selected` : ''}
      </Text>
      {meta.loading ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: 40 }} />
      ) : (
        meta.equipmentCategories.map(category => (
          <View key={category.label} style={styles.foodCategory}>
            <Text style={styles.foodCategoryLabel}>{category.icon}  {category.label}</Text>
            <View style={styles.foodChips}>
              {category.items.map(item => {
                const selected = selectedEquipment.includes(item.name);
                return (
                  <TouchableOpacity
                    key={item.name}
                    style={[styles.foodChip, selected && styles.foodChipActive]}
                    onPress={() => toggleEquipment(item.name)}>
                    <Text style={[styles.foodChipText, selected && styles.foodChipTextActive]}>
                      {item.name}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
        ))
      )}
    </View>
  );

  const toggleFood = (food: string) => {
    setFoodsAvailable(prev =>
      prev.includes(food) ? prev.filter(f => f !== food) : [...prev, food]
    );
  };

  const renderFoodsStep = () => (
    <View style={styles.stepContainer}>
      <Text style={styles.stepTitle}>What's in your kitchen?</Text>
      <Text style={styles.stepDescription}>
        Select foods you have available — your meal plan will be built around these
        {foodsAvailable.length > 0 ? `  ·  ${foodsAvailable.length} selected` : ''}
      </Text>

      {meta.loading ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: 40 }} />
      ) : (
        meta.foodCategories.map(category => (
          <View key={category.key} style={styles.foodCategory}>
            <Text style={styles.foodCategoryLabel}>{category.icon}  {category.label}</Text>
            <View style={styles.foodChips}>
              {category.foods.map(food => {
                const selected = foodsAvailable.includes(food.name);
                return (
                  <TouchableOpacity
                    key={food.name}
                    style={[styles.foodChip, selected && styles.foodChipActive]}
                    onPress={() => toggleFood(food.name)}>
                    <Text style={[styles.foodChipText, selected && styles.foodChipTextActive]}>
                      {food.name}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
        ))
      )}

      <Text style={styles.hint}>Skip to use default meal suggestions</Text>
    </View>
  );

  const renderStep = () => {
    switch (currentStepKey) {
      case 'goal':          return renderGoalStep();
      case 'goalDetails':   return renderGoalDetailsStep();
      case 'physicalStats': return renderPhysicalStatsStep();
      case 'trainingDays':  return renderTrainingDaysStep();
      case 'equipment':     return renderEquipmentStep();
      case 'foods':         return renderFoodsStep();
    }
  };

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView style={styles.container} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <Image source={logo} style={styles.logo} resizeMode="contain" />
          <Text style={styles.stepCounter}>Step {currentStep + 1} of {totalSteps}</Text>
        </View>

        <View style={styles.progressBar}>
          {Array.from({ length: totalSteps }).map((_, i) => (
            <View key={i} style={[styles.progressSegment, i <= currentStep && styles.progressSegmentActive]} />
          ))}
        </View>

        {renderStep()}

        <View style={styles.buttons}>
          <TouchableOpacity
            style={[styles.backButton, currentStep === 0 && styles.buttonDisabled]}
            onPress={handleBack}
            disabled={currentStep === 0}
          >
            <Text style={styles.backButtonText}>Back</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.nextButton} onPress={handleNext}>
            <Text style={styles.nextButtonText}>
              {currentStep === totalSteps - 1 ? 'Get Started' : 'Next'}
            </Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: 24, paddingBottom: 48 },
  header: { marginTop: 16, marginBottom: 16 },
  logo: { width: 160, height: 52 },
  stepCounter: { fontSize: 13, color: colors.textSecondary, marginTop: 8 },

  progressBar: { flexDirection: 'row', gap: 6, marginBottom: 32 },
  progressSegment: { flex: 1, height: 3, borderRadius: 2, backgroundColor: colors.border },
  progressSegmentActive: { backgroundColor: colors.primary },

  stepContainer: { marginBottom: 24 },
  stepTitle: { fontSize: 26, fontWeight: '700', color: colors.textPrimary, marginBottom: 8 },
  stepDescription: { fontSize: 15, color: colors.textSecondary, lineHeight: 22, marginBottom: 24 },

  goalGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  goalCard: { width: '48%', padding: 14, borderRadius: radius.lg, borderWidth: 2, borderColor: colors.border, backgroundColor: colors.surface },
  goalCardActive: { borderColor: colors.primary, backgroundColor: colors.surfaceRaised },
  goalIcon: { fontSize: 26, marginBottom: 6 },
  goalLabel: { fontSize: 14, fontWeight: '700', color: colors.textPrimary, marginBottom: 4 },
  goalLabelActive: { color: colors.primary },
  goalDesc: { fontSize: 12, color: colors.textSecondary, lineHeight: 16 },
  goalDescActive: { color: colors.primaryLight },

  paceCards: { flexDirection: 'row', gap: 8, marginTop: 8 },
  paceCard: { flex: 1, padding: 12, borderRadius: radius.lg, borderWidth: 2, borderColor: colors.border, backgroundColor: colors.surface, alignItems: 'center' },
  paceCardActive: { borderColor: colors.primary, backgroundColor: colors.surfaceRaised },
  paceIcon: { fontSize: 24, marginBottom: 6 },
  paceLabel: { fontSize: 12, fontWeight: '700', color: colors.textPrimary, textAlign: 'center', marginBottom: 2 },
  paceLabelActive: { color: colors.primary },
  paceRate: { fontSize: 11, fontWeight: '600', color: colors.textSecondary, textAlign: 'center', marginBottom: 4 },
  paceRateActive: { color: colors.primary },
  paceDesc: { fontSize: 10, color: colors.textMuted, textAlign: 'center', lineHeight: 13 },
  paceDescActive: { color: colors.primaryLight },

  fieldGroup: { marginBottom: 20 },
  fieldLabel: { fontSize: 14, fontWeight: '600', color: colors.textPrimary, marginBottom: 8 },
  optional: { fontWeight: '400', color: colors.textMuted },
  inlineInput: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  heightRow: { flexDirection: 'row', gap: 12 },
  input: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.md,
    padding: 14, fontSize: 16, backgroundColor: colors.surface, color: colors.textPrimary,
  },
  unit: { fontSize: 14, color: colors.textSecondary, fontWeight: '500', minWidth: 40 },
  hint: { fontSize: 13, color: colors.textMuted, marginTop: 8 },

  genderRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  genderButton: { paddingVertical: 10, paddingHorizontal: 16, borderRadius: radius.full, borderWidth: 2, borderColor: colors.border, backgroundColor: colors.surface },
  genderButtonActive: { borderColor: colors.primary, backgroundColor: colors.surfaceRaised },
  genderText: { fontSize: 14, color: colors.textSecondary, fontWeight: '500' },
  genderTextActive: { color: colors.primary, fontWeight: '600' },

  foodCategory:      { marginBottom: 18 },
  foodCategoryLabel: { fontSize: 13, fontWeight: '700', color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 10 },
  foodChips:         { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  foodChip:          { paddingVertical: 7, paddingHorizontal: 12, borderRadius: radius.full, borderWidth: 1.5, borderColor: colors.border, backgroundColor: colors.surface },
  foodChipActive:    { borderColor: colors.primary, backgroundColor: colors.surfaceRaised },
  foodChipText:      { fontSize: 13, color: colors.textSecondary, fontWeight: '500' },
  foodChipTextActive:{ color: colors.primary, fontWeight: '600' },

  buttons: { flexDirection: 'row', gap: 12, marginTop: 8 },
  backButton: { flex: 1, paddingVertical: 16, borderRadius: radius.md, backgroundColor: colors.surface, alignItems: 'center', borderWidth: 1, borderColor: colors.border },
  buttonDisabled: { opacity: 0.4 },
  backButtonText: { fontSize: 16, fontWeight: '600', color: colors.textSecondary },
  nextButton: { flex: 1, paddingVertical: 16, borderRadius: radius.md, backgroundColor: colors.primary, alignItems: 'center' },
  nextButtonText: { fontSize: 16, fontWeight: '600', color: colors.background },
});
