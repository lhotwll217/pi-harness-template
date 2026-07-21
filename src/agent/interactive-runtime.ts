import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import {
  SessionManager,
  createAgentSessionRuntime,
} from "@earendil-works/pi-coding-agent";
import { ONBOARDING_VERSION, harnessPaths } from "@pi-template/contracts";
import type { AgentToolDependencies } from "./agent-definition";
import { createHarnessSession } from "./runtime";
import type { SandboxAdapter } from "./sandbox";

export interface InteractiveHarnessRuntimeOptions extends AgentToolDependencies {
  home?: string;
  cwd?: string;
  model?: Model<any>;
  sandbox?: SandboxAdapter;
}

/** Build the persisted interactive Pi runtime without starting terminal IO. */
export async function createInteractiveHarnessRuntime(options: InteractiveHarnessRuntimeOptions) {
  const paths = harnessPaths(options.home);
  const cwd = options.cwd ?? process.cwd();
  const transcriptDir = join(paths.home, "transcripts");
  mkdirSync(transcriptDir, { recursive: true });
  let loadedResourceIds: string[] = [];
  let toolNames: string[] = [];

  // Pi reuses this factory for /new, /resume, /fork, and imports. Rebuild harness-owned
  // services for every effective cwd so no replacement session falls back to ambient Pi
  // resources, unguarded tools, or a different transcript/provenance policy.
  const createRuntime: Parameters<typeof createAgentSessionRuntime>[0] = async ({
    cwd: sessionCwd,
    sessionManager,
    sessionStartEvent,
  }) => {
    const created = await createHarnessSession({
      home: paths.home,
      cwd: sessionCwd,
      sessionManager,
      sessionStartEvent,
      query: options.query,
      notes: options.notes,
      sandbox: options.sandbox,
      model: options.model,
    });
    loadedResourceIds = created.loadedResourceIds;
    toolNames = created.session.getActiveToolNames();
    sessionManager.appendCustomEntry("pi-template-provenance", {
      origin: "interactive",
      caller: "interactive",
      taskDirectory: sessionCwd,
      effectiveCapabilities: toolNames,
      trustPolicyVersion: ONBOARDING_VERSION,
      approvalPolicy: "live-owner-approval",
    });
    return created;
  };

  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd,
    agentDir: paths.piAgentDir,
    sessionManager: SessionManager.create(cwd, transcriptDir),
  });
  return { runtime, transcriptDir, loadedResourceIds, toolNames };
}
