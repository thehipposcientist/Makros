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
} from 'react-native';
import {
  Goal, GoalPace, Gender, Equipment, UserProfile, PhysicalStats, GoalDetails,
} from '../types';
import {
  GOAL_OPTIONS, PACE_OPTIONS, TIMELINE_WEEKS,
  WEIGHT_GOALS, TIMELINE_GOALS, LIFESTYLE_GOALS,
} from '../constants/goals';

// ─── Step logic ───────────────────────────────────────────────────────────────

type StepKey = 'goal' | 'goalDetails' | 'physicalStats' | 'trainingDays' | 'equipment' | 'foods';

function getSteps(goal: Goal): StepKey[] {
  if (LIFESTYLE_GOALS.has(goal)) {
    return ['goal', 'physicalStats', 'trainingDays', 'equipment', 'foods'];
  }
  return ['goal', 'goalDetails', 'physicalStats', 'trainingDays', 'equipment', 'foods'];
}

// ─── Component ────────────────────────────────────────────────────────────────

interface OnboardingScreenProps {
  onComplete: (profile: UserProfile) => void;
}

export default function OnboardingScreen({ onComplete }: OnboardingScreenProps) {
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

  // Step 5 — Equipment
  const [selectedEquipment, setSelectedEquipment] = useState<Equipment[]>(['home']);

  // Step 6 — Foods
  const [foodsAvailable, setFoodsAvailable] = useState('');

  const steps = getSteps(goal);
  const totalSteps = steps.length;
  const currentStepKey = steps[currentStep];

  const toggleEquipment = (eq: Equipment) => {
    setSelectedEquipment(prev =>
      prev.includes(eq) ? prev.filter(e => e !== eq) : [...prev, eq]
    );
  };

  const validate = (): string | null => {
    switch (currentStepKey) {
      case 'goalDetails':
        if (WEIGHT_GOALS.has(goal) && targetWeight) {
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
      // When goal changes on step 0, reset pace so it's fresh for the new goal
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
      targetWeightLbs: WEIGHT_GOALS.has(goal) && targetWeight ? parseFloat(targetWeight) : undefined,
      timelineWeeks: TIMELINE_GOALS.has(goal) ? TIMELINE_WEEKS[goal][pace] : undefined,
    };

    const physicalStats: PhysicalStats = {
      weightLbs: parseFloat(weightLbs),
      heightFeet: parseInt(heightFeet),
      heightInches: parseInt(heightInches),
      age: parseInt(age),
      gender: gender as Gender,
    };

    onComplete({
      goal,
      goalDetails,
      physicalStats,
      daysPerWeek: parseInt(daysPerWeek),
      equipment: selectedEquipment,
      foodsAvailable: foodsAvailable.split(',').map(f => f.trim()).filter(Boolean),
    });
  };

  // ─── Step renderers ─────────────────────────────────────────────────────────

  const renderGoalStep = () => (
    <View style={styles.stepContainer}>
      <Text style={styles.stepTitle}>What's Your Goal?</Text>
      <Text style={styles.stepDescription}>Choose the one that best matches what you want to achieve</Text>
      <View style={styles.goalGrid}>
        {GOAL_OPTIONS.map(opt => {
          const active = goal === opt.value;
          return (
            <TouchableOpacity
              key={opt.value}
              style={[styles.goalCard, active && styles.goalCardActive]}
              onPress={() => setGoal(opt.value)}
              activeOpacity={0.75}
            >
              <Text style={styles.goalIcon}>{opt.icon}</Text>
              <Text style={[styles.goalLabel, active && styles.goalLabelActive]}>{opt.label}</Text>
              <Text style={[styles.goalDesc, active && styles.goalDescActive]}>{opt.description}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );

  const renderGoalDetailsStep = () => {
    const paceOpts = PACE_OPTIONS[goal] ?? PACE_OPTIONS['strength'];
    const showTargetWeight = WEIGHT_GOALS.has(goal);
    const goalLabel = GOAL_OPTIONS.find(g => g.value === goal)?.label ?? '';

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
                placeholderTextColor="#999"
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
                onPress={() => setPace(opt.value)}
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
            placeholderTextColor="#999"
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
          <View style={styles.inlineInput}>
            <TextInput
              style={[styles.input, { flex: 1 }]}
              placeholder="5"
              placeholderTextColor="#999"
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
              placeholderTextColor="#999"
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
            placeholderTextColor="#999"
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

  const renderTrainingDaysStep = () => (
    <View style={styles.stepContainer}>
      <Text style={styles.stepTitle}>Training Days</Text>
      <Text style={styles.stepDescription}>How many days per week can you commit to training?</Text>
      <View style={styles.inlineInput}>
        <TextInput
          style={[styles.input, { flex: 1 }]}
          placeholder="3"
          placeholderTextColor="#999"
          keyboardType="number-pad"
          value={daysPerWeek}
          onChangeText={setDaysPerWeek}
          maxLength={1}
        />
        <Text style={styles.unit}>days/week</Text>
      </View>
      <Text style={styles.hint}>Recommended: 3–4 days for optimal recovery</Text>
    </View>
  );

  const renderEquipmentStep = () => (
    <View style={styles.stepContainer}>
      <Text style={styles.stepTitle}>Available Equipment</Text>
      <Text style={styles.stepDescription}>Select everything you have access to</Text>
      <View style={styles.equipmentGrid}>
        {([
          { value: 'home',       icon: '🏠', label: 'Home' },
          { value: 'gym',        icon: '🏋️', label: 'Gym' },
          { value: 'dumbbells',  icon: '⚡', label: 'Dumbbells' },
          { value: 'bodyweight', icon: '🤸', label: 'Bodyweight' },
          { value: 'other',      icon: '🎯', label: 'Other' },
        ] as { value: Equipment; icon: string; label: string }[]).map(eq => (
          <TouchableOpacity
            key={eq.value}
            style={[styles.equipmentButton, selectedEquipment.includes(eq.value) && styles.equipmentButtonActive]}
            onPress={() => toggleEquipment(eq.value)}
          >
            <Text style={styles.equipmentIcon}>{eq.icon}</Text>
            <Text style={styles.equipmentLabel}>{eq.label}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );

  const renderFoodsStep = () => (
    <View style={styles.stepContainer}>
      <Text style={styles.stepTitle}>Favourite Foods</Text>
      <Text style={styles.stepDescription}>Enter foods you enjoy (comma separated, optional)</Text>
      <TextInput
        style={[styles.input, styles.multilineInput]}
        placeholder="e.g. chicken, rice, broccoli, eggs"
        placeholderTextColor="#999"
        value={foodsAvailable}
        onChangeText={setFoodsAvailable}
        multiline
        numberOfLines={4}
      />
      <Text style={styles.hint}>Leave blank to use default meal suggestions</Text>
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
          <Text style={styles.logo}>makros</Text>
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
  container: { flex: 1, backgroundColor: '#fff' },
  content: { padding: 24, paddingBottom: 48 },
  header: { marginTop: 16, marginBottom: 16 },
  logo: { fontSize: 28, fontWeight: '800', color: '#007AFF', letterSpacing: -0.5 },
  stepCounter: { fontSize: 13, color: '#999', marginTop: 4 },

  progressBar: { flexDirection: 'row', gap: 6, marginBottom: 32 },
  progressSegment: { flex: 1, height: 3, borderRadius: 2, backgroundColor: '#e0e0e0' },
  progressSegmentActive: { backgroundColor: '#007AFF' },

  stepContainer: { marginBottom: 24 },
  stepTitle: { fontSize: 26, fontWeight: '700', color: '#000', marginBottom: 8 },
  stepDescription: { fontSize: 15, color: '#666', lineHeight: 22, marginBottom: 24 },

  // Goal grid
  goalGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  goalCard: { width: '48%', padding: 14, borderRadius: 14, borderWidth: 2, borderColor: '#e0e0e0', backgroundColor: '#f9f9f9' },
  goalCardActive: { borderColor: '#007AFF', backgroundColor: '#E8F4FF' },
  goalIcon: { fontSize: 26, marginBottom: 6 },
  goalLabel: { fontSize: 14, fontWeight: '700', color: '#000', marginBottom: 4 },
  goalLabelActive: { color: '#007AFF' },
  goalDesc: { fontSize: 12, color: '#888', lineHeight: 16 },
  goalDescActive: { color: '#4a90d9' },

  // Pace cards
  paceCards: { flexDirection: 'row', gap: 8, marginTop: 8 },
  paceCard: { flex: 1, padding: 12, borderRadius: 14, borderWidth: 2, borderColor: '#e0e0e0', backgroundColor: '#f9f9f9', alignItems: 'center' },
  paceCardActive: { borderColor: '#007AFF', backgroundColor: '#E8F4FF' },
  paceIcon: { fontSize: 24, marginBottom: 6 },
  paceLabel: { fontSize: 12, fontWeight: '700', color: '#000', textAlign: 'center', marginBottom: 2 },
  paceLabelActive: { color: '#007AFF' },
  paceRate: { fontSize: 11, fontWeight: '600', color: '#666', textAlign: 'center', marginBottom: 4 },
  paceRateActive: { color: '#007AFF' },
  paceDesc: { fontSize: 10, color: '#999', textAlign: 'center', lineHeight: 13 },
  paceDescActive: { color: '#4a90d9' },

  // Form fields
  fieldGroup: { marginBottom: 20 },
  fieldLabel: { fontSize: 14, fontWeight: '600', color: '#333', marginBottom: 8 },
  optional: { fontWeight: '400', color: '#999' },
  inlineInput: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  heightRow: { flexDirection: 'row', gap: 12 },
  input: {
    borderWidth: 1, borderColor: '#e0e0e0', borderRadius: 12,
    padding: 14, fontSize: 16, backgroundColor: '#f9f9f9', color: '#000',
  },
  multilineInput: { minHeight: 100, textAlignVertical: 'top' },
  unit: { fontSize: 14, color: '#666', fontWeight: '500', minWidth: 40 },
  hint: { fontSize: 13, color: '#999', marginTop: 8 },

  // Gender
  genderRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  genderButton: { paddingVertical: 10, paddingHorizontal: 16, borderRadius: 20, borderWidth: 2, borderColor: '#e0e0e0', backgroundColor: '#f9f9f9' },
  genderButtonActive: { borderColor: '#007AFF', backgroundColor: '#E8F4FF' },
  genderText: { fontSize: 14, color: '#666', fontWeight: '500' },
  genderTextActive: { color: '#007AFF', fontWeight: '600' },

  // Equipment
  equipmentGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  equipmentButton: { width: '48%', paddingVertical: 16, borderRadius: 12, borderWidth: 2, borderColor: '#e0e0e0', backgroundColor: '#f9f9f9', alignItems: 'center' },
  equipmentButtonActive: { borderColor: '#007AFF', backgroundColor: '#E8F4FF' },
  equipmentIcon: { fontSize: 28, marginBottom: 4 },
  equipmentLabel: { fontSize: 14, fontWeight: '500', color: '#666' },

  // Buttons
  buttons: { flexDirection: 'row', gap: 12, marginTop: 8 },
  backButton: { flex: 1, paddingVertical: 16, borderRadius: 12, backgroundColor: '#e0e0e0', alignItems: 'center' },
  buttonDisabled: { opacity: 0.4 },
  backButtonText: { fontSize: 16, fontWeight: '600', color: '#666' },
  nextButton: { flex: 1, paddingVertical: 16, borderRadius: 12, backgroundColor: '#007AFF', alignItems: 'center' },
  nextButtonText: { fontSize: 16, fontWeight: '600', color: '#fff' },
});
