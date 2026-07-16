// Onboarding stage vocabulary and pure progression rules (docs/onboarding.md). The flow is a
// versioned, resumable state machine: stages complete in order, each records a timestamp, and
// the completion marker is written only after every required stage succeeds. Persistence and
// stage side effects live with the agent module; this file owns only the shared shape.

/** Bumped when the flow gains a stage the owner must be re-walked through. */
export const ONBOARDING_VERSION = 1;

export type OnboardingStage =
  | "home"
  | "auth"
  | "model"
  | "resources"
  | "capabilities"
  | "protected-paths"
  | "sandbox"
  | "service"
  | "readiness";

export const ONBOARDING_STAGES: readonly OnboardingStage[] = Object.freeze([
  "home",
  "auth",
  "model",
  "resources",
  "capabilities",
  "protected-paths",
  "sandbox",
  "service",
  "readiness",
]);

/** Durable stage progress; resuming starts from this, never from guesses about files. */
export interface OnboardingProgress {
  version: number;
  /** ISO completion time per finished stage. */
  stages: Partial<Record<OnboardingStage, string>>;
}

/** Written only after every required stage succeeds. Its presence at the current version
 * is what un-gates headless and model-driven work (docs/onboarding.md#fail-closed-rule). */
export interface OnboardingMarker {
  version: number;
  completedAt: string;
}

/** The first incomplete stage in order, or null when all stages are done. A version
 * mismatch restarts progression: an old trust contract never grandfathers a new one. */
export function nextOnboardingStage(progress: OnboardingProgress | undefined): OnboardingStage | null {
  if (!progress || progress.version !== ONBOARDING_VERSION) return ONBOARDING_STAGES[0];
  for (const stage of ONBOARDING_STAGES) {
    if (!progress.stages[stage]) return stage;
  }
  return null;
}

export function isOnboardingComplete(marker: OnboardingMarker | undefined): boolean {
  return !!marker && marker.version === ONBOARDING_VERSION && !!marker.completedAt;
}
