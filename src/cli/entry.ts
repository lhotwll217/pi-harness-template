// Bare `pi-template`: set up when needed, then open the agent in a terminal, or print status as
// JSON when there is no terminal to open it in.
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

async function openInteractive(): Promise<void> {
  const { runInteractiveSession } = await import("./interactive");
  await withGateway(async (client) => await runInteractiveSession({ gateway: client }));
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
    await emit({ health: await client.health(), ready: await client.ready() });
  });
  return 0;
}
