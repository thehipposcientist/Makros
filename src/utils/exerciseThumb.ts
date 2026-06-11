import type { ImageSourcePropType } from 'react-native';

type ExerciseThumbCandidate = {
  name?: string | null;
  slug?: string | null;
  video_id?: string | null;
  demo_exercise_db_id?: string | null;
  demoExerciseDbId?: string | null;
};

export function primeThumbnailIndex(exercises: readonly ExerciseThumbCandidate[] = []): void {
  void exercises;
}

export function exerciseThumbSmall(exercise?: ExerciseThumbCandidate | null): ImageSourcePropType | null {
  void exercise;
  return null;
}

export function exerciseThumbMedium(exercise?: ExerciseThumbCandidate | null): ImageSourcePropType | null {
  void exercise;
  return null;
}
