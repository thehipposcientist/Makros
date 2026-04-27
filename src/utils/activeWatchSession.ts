// Module-level store for the current active watch session ID.
// Written synchronously by ActiveWorkoutScreen on mount, read by HomeScreen's
// pull_state and reachability handlers. Avoids the AsyncStorage race where
// handlers read the key before ActiveWorkoutScreen's setItem completes.

let _sessionId: string | null = null;

export function setActiveWatchSessionId(id: string | null): void {
  _sessionId = id;
}

export function getActiveWatchSessionId(): string | null {
  return _sessionId;
}
