import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
  ScheduleKind,
  ScheduledPayloadKind,
  harnessPaths,
  type ScheduledPromptRunRequest,
} from "@pi-template/contracts";
import { createScheduledPromptRunner } from "../agent/prompt-runner";
import { createAgentResources } from "../agent/runtime";
import { formatDoctorReport, runDoctor } from "../agent/doctor";
import { createSandboxAdapter } from "../agent/sandbox";
import { passingOnboardingDependencies } from "../../test/helpers/onboarding";
import { toolResultFromTurn } from "../../test/helpers/tool-turn";
import { createInteractiveSessionRuntime } from "./interactive";
import { onboard } from "./onboard";

// mkdtemp under os.tmpdir() keeps macOS's /var spelling; its real path is under /private/var.
const spelledRoot = mkdtempSync(join(tmpdir(), "pi-template-home-write-root-"));
const realRoot = realpathSync(spelledRoot);
const faux = registerFauxProvider();
const unused = async (): Promise<never> => { throw new Error("not used"); };
const gateway = { queryDatabase: unused, createNote: unused };
const resources = { query: { listTables: unused, describeTable: unused, runQuery: unused }, notes: { createNote: unused } };
const refusal = (root: string, home: string) =>
  `sandbox write root ${root} contains the harness home ${home}, so sandboxed bash could rewrite the files that set its own limits. ` +
  "Record write roots outside the home: `pi-template onboard --sandbox-write <dir>`, or turn the sandbox off with `--sandbox-off`";

try {
  const model = faux.getModel();
  const standaloneDir = join(realRoot, "standalone-pi");
  mkdirSync(standaloneDir);
  writeFileSync(join(standaloneDir, "auth.json"), JSON.stringify({ [model.provider]: { type: "api_key", key: "faux-key" } }));
  writeFileSync(join(standaloneDir, "settings.json"), JSON.stringify({ defaultProvider: model.provider, defaultModel: model.id }));
  writeFileSync(join(standaloneDir, "models.json"), JSON.stringify({ providers: {
    [model.provider]: { api: model.api, baseUrl: "http://127.0.0.1:1", apiKey: "faux-key", models: [model] },
  } }));
  const onboardFlags = ["--non-interactive", "--auth-file", join(standaloneDir, "auth.json"), "--acknowledge-resources", "--service", "declined"];
  const sandboxed = (writeRoot: string) => [...onboardFlags, "--sandbox", "--sandbox-read", writeRoot, "--sandbox-write", writeRoot];

  const realHome = join(spelledRoot, "real-home");
  const linkHome = join(spelledRoot, "link-home");
  mkdirSync(realHome);
  symlinkSync(realHome, linkHome);
  await assert.rejects(onboard(sandboxed(spelledRoot), passingOnboardingDependencies(linkHome)), {
    message: `sandbox: ${refusal(spelledRoot, linkHome)}`,
  });
  assert.equal(existsSync(harnessPaths(linkHome).sandboxPolicy), false, "a refused write root is never recorded");

  const plainHome = join(spelledRoot, "plain-home");
  const linkParent = join(spelledRoot, "links");
  const linkedHome = join(linkParent, "home");
  mkdirSync(linkParent);
  mkdirSync(join(spelledRoot, "elsewhere"));
  symlinkSync(join(spelledRoot, "elsewhere"), linkedHome);
  for (const [home, writeRoot, label] of [
    [plainHome, plainHome, "the home itself"],
    [plainHome, spelledRoot, "the home's parent"],
    [plainHome, realRoot, "the home's parent by its real path"],
    [linkedHome, join(realRoot, "links"), "the real parent of a symlink on the home's path"],
  ] as const) {
    await assert.rejects(onboard(sandboxed(writeRoot), passingOnboardingDependencies(home)), {
      message: `sandbox: ${refusal(writeRoot, home)}`,
    }, label);
  }

  const beside = join(spelledRoot, "beside");
  mkdirSync(beside);
  assert.equal((await onboard(sandboxed(beside), passingOnboardingDependencies(linkHome))).complete, true);
  const paths = harnessPaths(linkHome);
  const session = { home: linkHome, cwd: beside };
  const probe = await createSandboxAdapter().verify(JSON.parse(readFileSync(paths.sandboxPolicy, "utf8")));
  if (probe.unavailable) {
    process.stdout.write(`SKIP — real sandbox unavailable for the sibling write root: ${probe.reason}\n`);
  } else {
    assert.equal(await toolResultFromTurn(faux, session, "bash", { command: "echo kept > note.md && cat note.md" }), "kept\n");
    assert.equal(readFileSync(join(beside, "note.md"), "utf8"), "kept\n");
  }

  assert.equal((await onboard([...onboardFlags, "--sandbox-off", "--sandbox-write", spelledRoot], passingOnboardingDependencies(plainHome))).complete, true);
  const markerBytes = readFileSync(harnessPaths(plainHome).onboardingMarker, "utf8");
  await assert.rejects(onboard([...onboardFlags, "--sandbox"], passingOnboardingDependencies(plainHome)), {
    message: `sandbox: ${refusal(spelledRoot, plainHome)}`,
  });
  const interactively = {
    ...passingOnboardingDependencies(plainHome),
    standalonePiAuthPath: join(standaloneDir, "auth.json"),
    interactiveIO: { question: async () => "", write: () => undefined },
  };
  await assert.rejects(onboard(["--sandbox"], interactively), { message: `sandbox: ${refusal(spelledRoot, plainHome)}` });
  assert.equal(readFileSync(harnessPaths(plainHome).onboardingMarker, "utf8"), markerBytes);
  assert.equal((await onboard(["--sandbox", "--sandbox-read", beside, "--sandbox-write", beside], interactively)).complete, true,
    "the recovery the refusal names works interactively");
  assert.deepEqual(JSON.parse(readFileSync(harnessPaths(plainHome).sandboxPolicy, "utf8")).filesystem.allowedWriteRoots, [beside]);

  const recorded = JSON.parse(readFileSync(paths.sandboxPolicy, "utf8"));
  writeFileSync(paths.sandboxPolicy, JSON.stringify({ ...recorded, filesystem: { ...recorded.filesystem, allowedWriteRoots: [spelledRoot] } }));
  const sessionRefusal = refusal(spelledRoot, linkHome);
  await assert.rejects(toolResultFromTurn(faux, session, "bash", { command: `rm ${linkHome}` }), { message: sessionRefusal });
  assert.equal(realpathSync(linkHome), realpathSync(realHome), "the home link is unchanged");
  await assert.rejects(createInteractiveSessionRuntime({ ...session, gateway, model }), { message: sessionRefusal });
  const prompt = { kind: ScheduledPayloadKind.Prompt, prompt: "Repoint the home", toolsAllow: [] } as const;
  const scheduled: ScheduledPromptRunRequest = {
    payload: prompt,
    cwd: beside,
    schedule: {
      id: "schedule-1",
      name: "repoint the home",
      enabled: true,
      trigger: { kind: ScheduleKind.Every, everyMs: 60_000, anchorMs: 0 },
      payload: prompt,
      cwd: beside,
      timeoutSeconds: 30,
      revision: 1,
      createdAt: "2026-10-16T12:00:00.000Z",
      updatedAt: "2026-10-16T12:00:00.000Z",
      nextRunAt: null,
    },
    runId: "run-1",
    signal: new AbortController().signal,
  };
  await assert.rejects(createScheduledPromptRunner({ home: linkHome, resources })(scheduled), { message: sessionRefusal });
  await assert.rejects(createAgentResources({ ...session, ...resources }), { message: sessionRefusal });
  const report = await runDoctor({ home: linkHome, providerModelVerifier: () => true });
  assert.deepEqual(report.checks.sandbox, { enabled: true, verified: false, reason: sessionRefusal });
  assert.equal(formatDoctorReport(report).includes(`Sandbox: on, not verified (${sessionRefusal})\n`), true);
  assert.equal(report.ok, false);

  writeFileSync(paths.sandboxPolicy, JSON.stringify({ ...recorded, filesystem: {} }));
  await assert.rejects(createScheduledPromptRunner({ home: linkHome, resources })(scheduled), {
    message: `sandbox policy is invalid under ${linkHome}`,
  }, "an unreadable policy stops a session even without bash");

  writeFileSync(paths.sandboxPolicy, JSON.stringify({ ...recorded, enabled: false, filesystem: { ...recorded.filesystem, allowedWriteRoots: [spelledRoot] } }));
  assert.equal((await runDoctor({ home: linkHome, providerModelVerifier: () => true })).ok, true, "an off sandbox has no write roots to refuse");

  process.stdout.write("ok — a sandbox write root that contains the harness home, or a link on its path, is refused at onboarding, at every session start, and by doctor; one beside the home works\n");
} finally {
  faux.unregister();
  rmSync(realRoot, { recursive: true, force: true });
}
