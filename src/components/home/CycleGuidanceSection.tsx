import CycleGuidanceCard from '../PeriodSupportCard';
import type { AppThemeName, WorkoutDay } from '../../types';

interface Props {
  themeName?: AppThemeName;
  visible: boolean;
  todaysWorkout?: WorkoutDay | null;
  todayDone: boolean;
  todaySkipped: boolean;
  onUseLighterWorkout: () => Promise<void> | void;
  onUseRecoveryDay: () => Promise<void> | void;
  onAddHydration: () => Promise<void> | void;
  authToken?: string | null;
}

export default function CycleGuidanceSection({
  themeName,
  visible,
  todaysWorkout,
  todayDone,
  todaySkipped,
  onUseLighterWorkout,
  onUseRecoveryDay,
  onAddHydration,
  authToken,
}: Props) {
  if (!visible) return null;
  return (
    <CycleGuidanceCard
      themeName={themeName}
      todaysWorkout={todaysWorkout ?? null}
      isWorkoutDone={todayDone}
      isWorkoutSkipped={todaySkipped}
      onUseLighterWorkout={onUseLighterWorkout}
      onUseRecoveryDay={onUseRecoveryDay}
      onAddHydration={onAddHydration}
      authToken={authToken}
    />
  );
}
