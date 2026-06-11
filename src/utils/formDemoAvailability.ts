export type FormDemoAvailability = {
  hasMoveKitDemo: boolean;
  hasHostedDemo: boolean;
  hasPrimaryDemo: boolean;
  shouldFetchHostedDemo: boolean;
};

export function resolveFormDemoAvailability(opts: {
  hasMoveKitMatch: boolean;
  moveKitFailed?: boolean;
  hasWorkoutXGif: boolean;
  workoutxFailed?: boolean;
}): FormDemoAvailability {
  const hasMoveKitDemo = opts.hasMoveKitMatch && !opts.moveKitFailed;
  const hasHostedDemo = !hasMoveKitDemo && opts.hasWorkoutXGif && !opts.workoutxFailed;

  return {
    hasMoveKitDemo,
    hasHostedDemo,
    hasPrimaryDemo: hasMoveKitDemo || hasHostedDemo,
    shouldFetchHostedDemo: !hasMoveKitDemo,
  };
}
