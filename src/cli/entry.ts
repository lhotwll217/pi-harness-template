import { readFileSync } from "node:fs";
import { harnessPaths, isOnboardingComplete, type OnboardingMarker } from "@pi-template/contracts";
import { resolveBareInvocation } from "./args";
import { emit, withGateway } from "./commands/command";

export function requireOnboarded(): void {
  let marker: OnboardingMarker | undefined;
  try {
    marker = JSON.parse(readFileSync(harnessPaths().onboardingMarker, "utf8")) as OnboardingMarker;
  } catch {
    marker = undefined;
  }
  if (!isOnboardingComplete(marker)) {
    throw new Error("setup required before talking to the agent; run `pi-template` in an interactive terminal");
  }
}

// The daemon starts first: the agent's own `pi-template` calls reach it but never start one.
async function openInteractive(): Promise<void> {
  const { runInteractiveSession } = await import("./interactive");
  await withGateway(async () => await runInteractiveSession({}));
}

export async function runEntry(): Promise<number> {
  const destination = resolveBareInvocation({
    markerPath: harnessPaths().onboardingMarker,
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  });
  if (destination === "setup-required") {
    process.stderr.write("pi-template: setup required; run `pi-template` in an interactive terminal\n");
    return 2;
  }
  if (destination === "onboard") {
    const { onboard } = await import("./onboard");
    const result = await onboard([]);
    await emit(result);
    if (result.complete) await openInteractive();
    return 0;
  }
  if (destination === "interactive") {
    await openInteractive();
    return 0;
  }
  await withGateway(async (client) => {
    await emit({ health: client.probe.health, ready: client.probe.ready });
  });
  return 0;
}
