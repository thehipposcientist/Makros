// Legacy free-exercise-db real-person photo frames were intentionally removed.
// Keep this empty map so old demo ids can still exist in API payloads while
// demoFrameSource() safely returns null.

type Frames = readonly [number, number];

export const DEMO_FRAMES: Readonly<Record<string, Frames>> = {};
