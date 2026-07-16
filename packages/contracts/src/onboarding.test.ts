// Unit: onboarding progression — ordering, resume, version gate, completion marker.
import assert from "node:assert/strict";
import {
  ONBOARDING_STAGES,
  ONBOARDING_VERSION,
  isOnboardingComplete,
  nextOnboardingStage,
} from "./onboarding";

// No progress → first stage.
assert.equal(nextOnboardingStage(undefined), "home");

// Resume from durable stage state, in declared order.
assert.equal(
  nextOnboardingStage({ version: ONBOARDING_VERSION, stages: { home: "2026-01-01T00:00:00Z" } }),
  "auth",
);

// Skipping ahead does not hide an earlier incomplete stage.
assert.equal(
  nextOnboardingStage({ version: ONBOARDING_VERSION, stages: { auth: "2026-01-01T00:00:00Z" } }),
  "home",
);

// All stages complete → null.
const all = Object.fromEntries(ONBOARDING_STAGES.map((s) => [s, "2026-01-01T00:00:00Z"]));
assert.equal(nextOnboardingStage({ version: ONBOARDING_VERSION, stages: all }), null);

// A changed trust contract reopens the flow instead of grandfathering the old progress.
assert.equal(nextOnboardingStage({ version: ONBOARDING_VERSION - 1, stages: all }), "home");

// Completion marker honors the version gate.
assert.equal(isOnboardingComplete(undefined), false);
assert.equal(isOnboardingComplete({ version: ONBOARDING_VERSION, completedAt: "2026-01-01T00:00:00Z" }), true);
assert.equal(isOnboardingComplete({ version: ONBOARDING_VERSION - 1, completedAt: "2026-01-01T00:00:00Z" }), false);

console.log("onboarding.test.ts ok");
