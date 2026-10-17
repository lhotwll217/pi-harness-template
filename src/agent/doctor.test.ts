import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ONBOARDING_VERSION,
  ensureHarnessWorkspace,
  reconcilePermissionSettings,
  saveHarnessSettings,
} from "@pi-template/contracts";
import { AGENT_DEFINITION, definitionIds } from "./agent-definition";
import { formatDoctorReport, runDoctor } from "./doctor";

const home = mkdtempSync(join(tmpdir(), "pi-template-doctor-"));
const secret = "never-print-this-provider-secret";

try {
  const paths = ensureHarnessWorkspace(home);
  writeFileSync(paths.piAuth, JSON.stringify({ fake: { type: "api_key", key: secret } }));
  writeFileSync(paths.piSettings, JSON.stringify({ defaultProvider: "fake", defaultModel: "model" }));
  writeFileSync(join(home, "sandbox-verification.json"), JSON.stringify({ ok: true, reason: "verified" }));
  const policy = {
    enabled: true,
    filesystem: { allowedReadRoots: [paths.workspace], allowedWriteRoots: [paths.workspace], deniedReadRoots: [] },
    process: { allowSubprocesses: true },
    network: { mode: "deny", allowedDomains: [] },
  };
  writeFileSync(join(home, "sandbox.json"), JSON.stringify(policy));
  saveHarnessSettings(home, { alwaysOn: "declined", permissionMode: "ask" });
  reconcilePermissionSettings(home);
  writeFileSync(paths.onboardingProgress, JSON.stringify({ version: ONBOARDING_VERSION, stages: { resources: "2026-10-16T12:00:00.000Z" } }));
  writeFileSync(paths.resourceApprovals, JSON.stringify({ acknowledgedDefinitionIds: definitionIds(AGENT_DEFINITION), workspaceContext: false }));
  const agentSocket = createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(request.url === "/health" ? { pid: process.pid } : { ready: true }));
  });
  await new Promise<void>((resolveListen) => agentSocket.listen(paths.agentSocket, resolveListen));

  const report = await runDoctor({
    home,
    installRoot: "/install/root",
    taskCwd: "/task/root",
    providerModelVerifier: () => true,
  });
  assert.deepEqual(Object.keys(report.checks), [
    "roots",
    "provider",
    "model",
    "resources",
    "permission",
    "protectedPaths",
    "sandbox",
    "daemon",
    "agentCli",
  ]);
  const reached = { reachable: true, reason: `the agent's bash reaches the daemon through ${paths.agentSocket}` };
  assert.deepEqual(report.checks.agentCli, reached, "sandbox on, on macOS");
  assert.match(formatDoctorReport(report), new RegExp(`^Agent CLI: reachable \\(the agent's bash reaches the daemon through ${paths.agentSocket.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)$`, "m"));
  assert.equal(report.checks.provider.available, true);
  assert.equal(report.checks.model.available, true);
  assert.equal(report.checks.daemon.configuration, "declined");
  const output = formatDoctorReport(report);
  assert.equal(output.includes(secret), false);
  assert.match(output, /fake\/model/);
  assert.deepEqual(report.checks.sandbox, { enabled: true, verified: true, reason: "verified" });
  assert.match(output, /^Sandbox: on, verified \(verified\)$/m);
  assert.equal(report.ok, true);

  const skill = (dir: string, name: string) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: The ${name} test skill.\n---\n`);
  };
  skill(join(paths.workspaceSkills, "dropped"), "dropped");
  skill(join(home, "linked-source"), "linked");
  symlinkSync(join(home, "linked-source"), join(paths.workspaceSkills, "linked"));
  symlinkSync(join(home, "moved-skill"), join(paths.workspaceSkills, "stale"));
  symlinkSync(join(home, "linked-source"), join(paths.workspaceSkills, "relinked"));
  skill(join(paths.workspaceSkills, "writing-for-agents"), "writing-for-agents");
  const skills = await runDoctor({ home, providerModelVerifier: () => true });
  const vendoredSkill = fileURLToPath(new URL("./skills/writing-for-agents/SKILL.md", import.meta.url));
  assert.deepEqual(skills.checks.resources.skillPolicy, { mode: "all-workspace", allowlist: [] });
  assert.deepEqual(skills.checks.resources.workspaceSkills, ["dropped", "linked"]);
  assert.deepEqual(skills.checks.resources.brokenSkillLinksNotLoaded, [{ name: "stale", target: join(home, "moved-skill") }]);
  assert.deepEqual(skills.checks.resources.skippedSkillLinks, []);
  assert.deepEqual(skills.checks.resources.skillNameCollisionsNotLoaded, [{
    name: "writing-for-agents",
    path: join(paths.workspaceSkills, "writing-for-agents", "SKILL.md"),
    winner: vendoredSkill,
  }]);
  assert.ok(formatDoctorReport(skills).includes(
    "Workspace skills (all-workspace): dropped, linked\n" +
    `  broken link, not loaded: stale -> ${join(home, "moved-skill")}\n` +
    `  name collision, not loaded: ${join(paths.workspaceSkills, "writing-for-agents", "SKILL.md")} (${vendoredSkill} wins)\n`,
  ));
  assert.deepEqual(skills.checks.resources.notices, []);
  assert.equal(skills.ok, true);

  symlinkSync(".", join(paths.workspaceSkills, "a"));
  symlinkSync(".", join(paths.workspaceSkills, "b"));
  mkdirSync(join(paths.workspaceSkills, "bundle"));
  symlinkSync("..", join(paths.workspaceSkills, "bundle", "x"));
  symlinkSync("..", join(paths.workspaceSkills, "bundle", "y"));
  mkdirSync(join(paths.workspaceSkills, "nested", "inner"), { recursive: true });
  symlinkSync("..", join(paths.workspaceSkills, "nested", "inner", "up"));
  writeFileSync(join(paths.workspaceSkills, "LICENSE"), "MIT\n");
  writeFileSync(join(paths.workspaceSkills, "package.json"), "{}\n");
  writeFileSync(join(paths.workspaceSkills, "loose.md"), "---\nname: loose\ndescription: A top-level Markdown skill.\n---\n");
  const loopProbe = `
    const { runDoctor, createAgentResources } = await import(${JSON.stringify(fileURLToPath(new URL("./index.ts", import.meta.url)))});
    const doctor = await runDoctor({ home: process.env.LOOP_HOME, providerModelVerifier: () => true });
    const session = await createAgentResources({
      home: process.env.LOOP_HOME,
      cwd: process.env.LOOP_HOME,
    });
    process.stdout.write(JSON.stringify({
      skipped: doctor.checks.resources.skippedSkillLinks,
      sessionSkills: session.loader.getSkills().skills.map(({ name }) => name).sort(),
      diagnostics: session.loader.getSkills().diagnostics.filter(({ type }) => type !== "collision").map(({ message }) => message),
    }));
  `;
  const looped = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", loopProbe], {
    env: { ...process.env, LOOP_HOME: home },
    encoding: "utf8",
    timeout: 30_000,
    killSignal: "SIGKILL",
  });
  assert.equal(looped.signal, null, "doctor and a session finish within 30 s with loop links in and under workspace/skills");
  assert.equal(looped.status, 0, looped.stderr);
  assert.deepEqual(JSON.parse(looped.stdout), {
    skipped: [
      { name: "a", target: ".", reason: "loops back to workspace/skills" },
      { name: "b", target: ".", reason: "loops back to workspace/skills" },
      { name: "bundle/x", target: "..", reason: "loops back to workspace/skills, so bundle is not loaded" },
      { name: "bundle/y", target: "..", reason: "loops back to workspace/skills, so bundle is not loaded" },
      { name: "nested/inner/up", target: "..", reason: "loops back to nested, so nested is not loaded" },
    ],
    sessionSkills: ["dropped", "linked", "loose", "writing-for-agents"],
    diagnostics: [],
  });
  for (const entry of ["a", "b", "bundle", "nested", "LICENSE", "package.json", "loose.md"]) {
    rmSync(join(paths.workspaceSkills, entry), { recursive: true });
  }

  writeFileSync(join(paths.workspace, "MEMORY.md"), "# Memory\n");
  saveHarnessSettings(home, { skillPolicy: { mode: "bundled", allowlist: [] } });
  const bundledOnly = await runDoctor({ home, providerModelVerifier: () => true });
  assert.deepEqual(bundledOnly.checks.resources.workspaceSkills, []);
  assert.deepEqual(bundledOnly.checks.resources.notices, [
    `${join(paths.workspace, "MEMORY.md")} is no longer loaded; ${paths.workspaceInstructions} is the instructions file`,
    "skill policy is bundled, so no workspace skill loads; load them with " +
      "`pi-template onboard --non-interactive --acknowledge-resources --workspace-skills all`",
  ]);
  assert.match(formatDoctorReport(bundledOnly), /^Workspace skills \(bundled\): none$/m);
  assert.ok(formatDoctorReport(bundledOnly).includes(`Notice: ${join(paths.workspace, "MEMORY.md")} is no longer loaded`));
  assert.equal(bundledOnly.ok, true);
  saveHarnessSettings(home, { skillPolicy: { mode: "allowlist", allowlist: ["dropped"] } });
  assert.match(formatDoctorReport(await runDoctor({ home, providerModelVerifier: () => true })),
    /^Workspace skills \(allowlist: dropped\): dropped$/m);
  unlinkSync(join(paths.workspace, "MEMORY.md"));

  writeFileSync(paths.resourceApprovals, JSON.stringify({
    acknowledgedDefinitionIds: definitionIds(AGENT_DEFINITION).filter((id) => id !== "skill:writing-for-agents"),
    workspaceContext: false,
  }));
  const upgraded = await runDoctor({ home, providerModelVerifier: () => true });
  assert.equal(upgraded.ok, false);
  assert.equal(upgraded.checks.resources.reviewed, false);
  assert.deepEqual(upgraded.checks.resources.unacknowledged, ["skill:writing-for-agents"]);
  assert.deepEqual(upgraded.checks.resources.notices, [
    "the agent definition gained entries the resource review did not acknowledge: skill:writing-for-agents; " +
      "review them with `pi-template onboard`, or accept them with `pi-template onboard --non-interactive --acknowledge-resources`",
  ]);
  rmSync(paths.resourceApprovals);
  assert.deepEqual((await runDoctor({ home, providerModelVerifier: () => true })).checks.resources.notices, [
    "no resource review has acknowledged the agent definition; review it with `pi-template onboard`",
  ]);
  writeFileSync(paths.resourceApprovals, JSON.stringify({ acknowledgedDefinitionIds: definitionIds(AGENT_DEFINITION), workspaceContext: false }));

  writeFileSync(join(home, "sandbox.json"), JSON.stringify({ ...policy, enabled: false }));
  const off = await runDoctor({ home, providerModelVerifier: () => true });
  assert.deepEqual(off.checks.sandbox, {
    enabled: false, verified: false, reason: "turned off in sandbox.json; bash runs on the host",
  });
  assert.match(formatDoctorReport(off), /^Sandbox: off \(turned off in sandbox.json; bash runs on the host\)$/m);
  assert.equal(off.ok, true);
  assert.deepEqual(off.checks.protectedPaths, { readable: true, reason: "none recorded" });
  assert.deepEqual((await runDoctor({ home, providerModelVerifier: () => true, platform: "linux" })).checks.agentCli, reached,
    "sandbox off: the platform does not matter");

  unlinkSync(join(home, "sandbox.json"));
  const missing = await runDoctor({ home, providerModelVerifier: () => true });
  assert.deepEqual(missing.checks.sandbox, {
    enabled: false, verified: false, reason: "no sandbox policy; bash runs on the host",
  });
  assert.equal(missing.ok, true);

  writeFileSync(join(home, "sandbox.json"), JSON.stringify({ network: { mode: "deny" } }));
  const invalid = await runDoctor({ home, providerModelVerifier: () => true });
  assert.deepEqual(invalid.checks.sandbox, {
    enabled: true, verified: false, reason: `sandbox policy is invalid under ${home}`,
  });
  assert.equal(invalid.ok, false);

  writeFileSync(join(home, "sandbox.json"), JSON.stringify({ ...policy, enabled: false }));
  writeFileSync(paths.protectedPaths, JSON.stringify({ paths: ["/a", "/b"], repos: ["Personal"] }));
  const recorded = await runDoctor({ home, providerModelVerifier: () => true });
  assert.deepEqual(recorded.checks.protectedPaths, { readable: true, reason: "2 paths, 1 repo" });
  assert.match(formatDoctorReport(recorded), /^Protected paths: 2 paths, 1 repo$/m);
  assert.equal(recorded.ok, true);
  writeFileSync(paths.protectedPaths, `{ "paths": ["/a"], }`);
  const damaged = await runDoctor({ home, providerModelVerifier: () => true });
  const damage = `protected paths are not valid JSON at ${paths.protectedPaths}; the agent will not start without the owner's protected paths. ` +
    "Fix the file, or record them again with `pi-template onboard` (non-interactive: `pi-template onboard --non-interactive --protected-path <dir>`)";
  assert.deepEqual(damaged.checks.protectedPaths, { readable: false, reason: damage });
  assert.equal(formatDoctorReport(damaged).includes(`Protected paths: unreadable (${damage})\n`), true);
  assert.equal(damaged.ok, false);
  unlinkSync(paths.protectedPaths);

  writeFileSync(paths.piAuth, `\uFEFF${JSON.stringify({ fake: { type: "api_key", key: secret } })}`);
  const bom = await runDoctor({ home, providerModelVerifier: () => true });
  assert.deepEqual(bom.checks.provider, { available: true, configuredCount: 1 });
  assert.match(formatDoctorReport(bom), /^Providers: 1 configured$/m);
  writeFileSync(paths.piAuth, "[]");
  const damagedAuth = await runDoctor({ home, providerModelVerifier: () => true });
  const authDamage = `${paths.piAuth} must hold a JSON object of provider credentials; fix or remove it`;
  assert.deepEqual(damagedAuth.checks.provider, { available: false, configuredCount: 0, problem: authDamage });
  assert.equal(formatDoctorReport(damagedAuth).includes(`Providers: unreadable (${authDamage})\n`), true);
  assert.equal(damagedAuth.ok, false);

  writeFileSync(paths.piAuth, JSON.stringify({ anthropic: { type: "api_key", key: secret } }));
  writeFileSync(paths.piSettings, JSON.stringify({ defaultProvider: "anthropic", defaultModel: "claude-sonnet-5" }));
  assert.equal((await runDoctor({ home })).checks.model.available, true);
  writeFileSync(paths.piSettings, JSON.stringify({ defaultProvider: "anthropic", defaultModel: "no-such-model" }));
  assert.equal((await runDoctor({ home })).checks.model.available, false);

  saveHarnessSettings(home, { alwaysOn: "declined" });
  writeFileSync(paths.piSettings, JSON.stringify({ defaultProvider: "fake", defaultModel: "model" }));
  writeFileSync(join(home, "sandbox.json"), JSON.stringify(policy));
  const linux = await runDoctor({ home, providerModelVerifier: () => true, platform: "linux" });
  assert.deepEqual(linux.checks.agentCli, {
    reachable: false,
    reason: "the sandbox admits one unix socket only on macOS, so sandboxed bash on linux cannot reach the daemon",
  });
  assert.equal(linux.ok, false);
  assert.equal((await runDoctor({ home, providerModelVerifier: () => true, platform: "darwin" })).ok, true);
  await new Promise<void>((resolveClose) => agentSocket.close(() => resolveClose()));
  const stopped = await runDoctor({ home, providerModelVerifier: () => true, platform: "darwin" });
  assert.deepEqual(stopped.checks.agentCli, {
    reachable: false,
    reason: `the daemon does not answer on the agent socket ${paths.agentSocket} (ENOENT)`,
  });
  assert.equal(stopped.ok, false);
  assert.match(formatDoctorReport(stopped), /^Agent CLI: unreachable \(the daemon does not answer on the agent socket .* \(ENOENT\)\)$/m);
  // macOS listens on a 104-byte socket path and refuses 105.
  const limitHome = join(home, "y".repeat(104 - Buffer.byteLength(join(home, "y", "agent.sock")) + 1));
  ensureHarnessWorkspace(limitHome);
  assert.equal(Buffer.byteLength(join(limitHome, "agent.sock")), 104);
  assert.deepEqual((await runDoctor({ home: limitHome, providerModelVerifier: () => true, platform: "darwin" })).checks.agentCli, {
    reachable: false,
    reason: `the daemon does not answer on the agent socket ${join(limitHome, "agent.sock")} (ENOENT)`,
  });
  const longHome = join(home, "y".repeat(104 - Buffer.byteLength(join(home, "y", "agent.sock")) + 2));
  ensureHarnessWorkspace(longHome);
  assert.deepEqual((await runDoctor({ home: longHome, providerModelVerifier: () => true, platform: "darwin" })).checks.agentCli, {
    reachable: false,
    reason: `the agent socket ${join(longHome, "agent.sock")} is longer than a unix socket path may be; move the harness home to a shorter path`,
  });

  process.stdout.write("ok — doctor reports readiness shape without secret material and names the sandbox state, skipped workspace skills, notices, and unacknowledged entries\n");
} finally {
  rmSync(home, { recursive: true, force: true });
}
