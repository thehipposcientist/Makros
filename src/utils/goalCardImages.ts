import type { ImageSourcePropType } from 'react-native';

type GoalCardImageGender = 'male' | 'female' | 'neutral' | string | null | undefined;

type GenderedGoalCardImages = {
  male?: ImageSourcePropType;
  female?: ImageSourcePropType;
  neutral: ImageSourcePropType;
};

const GOAL_CARD_IMAGES: Partial<Record<string, GenderedGoalCardImages>> = {
  build_muscle: {
    neutral: require('../../assets/images/card-backgrounds/workout-card-generic-gym-day-neutral.jpg'),
  },
  body_recomp: {
    male: require('../../assets/images/card-backgrounds/workout-card-free-weights-day-male.jpg'),
    female: require('../../assets/images/card-backgrounds/workout-card-free-weights-day-female.jpg'),
    neutral: require('../../assets/images/card-backgrounds/workout-card-free-weights-day-male.jpg'),
  },
  lose_fat: {
    male: require('../../assets/images/card-backgrounds/workout-card-hiit-day-male.jpg'),
    female: require('../../assets/images/card-backgrounds/workout-card-hiit-day-female.jpg'),
    neutral: require('../../assets/images/card-backgrounds/workout-card-fat-loss-hiit-neutral.jpg'),
  },
  build_strength: {
    male: require('../../assets/images/card-backgrounds/workout-card-build-strength-squat-male.jpg'),
    female: require('../../assets/images/card-backgrounds/workout-card-build-strength-squat-female.jpg'),
    neutral: require('../../assets/images/card-backgrounds/workout-card-build-strength-squat-male.jpg'),
  },
  improve_cardio: {
    male: require('../../assets/images/card-backgrounds/workout-card-running-day-male.jpg'),
    female: require('../../assets/images/card-backgrounds/workout-card-running-day-female.jpg'),
    neutral: require('../../assets/images/card-backgrounds/workout-card-treadmill-day-neutral.jpg'),
  },
  improve_athleticism: {
    male: require('../../assets/images/card-backgrounds/workout-card-football-day-male.jpg'),
    female: require('../../assets/images/card-backgrounds/workout-card-football-day-female.jpg'),
    neutral: require('../../assets/images/card-backgrounds/workout-card-football-day-male.jpg'),
  },
  hyrox: {
    male: require('../../assets/images/card-backgrounds/workout-card-hyrox-competition-male.jpg'),
    female: require('../../assets/images/card-backgrounds/workout-card-hyrox-competition-sled-push.png'),
    neutral: require('../../assets/images/card-backgrounds/workout-card-hyrox-competition-male.jpg'),
  },
  longevity: {
    male: require('../../assets/images/card-backgrounds/workout-card-recovery-day-male.jpg'),
    female: require('../../assets/images/card-backgrounds/workout-card-recovery-day-female.jpg'),
    neutral: require('../../assets/images/card-backgrounds/workout-card-sauna-day.jpg'),
  },
  maintain: {
    male: require('../../assets/images/card-backgrounds/workout-card-water-break-male.jpg'),
    female: require('../../assets/images/card-backgrounds/workout-card-water-break-female.jpg'),
    neutral: require('../../assets/images/card-backgrounds/workout-card-water-break-male.jpg'),
  },
};

const FALLBACK_GOAL_CARD_IMAGE = require('../../assets/images/card-backgrounds/workout-card-generic-gym-day-neutral.jpg');

export function getGoalCardImageSource(goalId: string, gender?: GoalCardImageGender): ImageSourcePropType {
  const images = GOAL_CARD_IMAGES[goalId];
  if (!images) return FALLBACK_GOAL_CARD_IMAGE;
  if (gender === 'male' && images.male) return images.male;
  if (gender === 'female' && images.female) return images.female;
  return images.neutral;
}
