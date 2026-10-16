import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { harnessPaths, savePermissionMode } from "@pi-template/contracts";
import { enforcedSandboxPolicy } from "../agent/runtime";
import { commandEnvironment, createSandboxAdapter, type SandboxPolicy } from "../agent/sandbox";
import { State } from "../state";
import { passingOnboardingDependencies } from "../../test/helpers/onboarding";
import { toolResultFromTurn } from "../../test/helpers/tool-turn";
import { onboard } from "./onboard";

const spelledRoot = mkdtempSync(join(tmpdir(), "pi-template-control-files-"));
const root = realpathSync(spelledRoot);
const home = join(root, "home");
const faux = registerFauxProvider();

try {
  const model = faux.getModel();
  const standaloneDir = join(root, "standalone-pi");
  mkdirSync(standaloneDir);
  writeFileSync(join(standaloneDir, "auth.json"), JSON.stringify({ [model.provider]: { type: "api_key", key: "faux-key" } }));
  writeFileSync(join(standaloneDir, "settings.json"), JSON.stringify({ defaultProvider: model.provider, defaultModel: model.id }));
  writeFileSync(join(standaloneDir, "models.json"), JSON.stringify({ providers: {
    [model.provider]: { api: model.api, baseUrl: "http://127.0.0.1:1", apiKey: "faux-key", models: [model] },
  } }));
  assert.equal((await onboard([
    "--non-interactive", "--auth-file", join(standaloneDir, "auth.json"), "--acknowledge-resources", "--service", "declined", "--sandbox",
  ], passingOnboardingDependencies(home))).complete, true);

  const paths = harnessPaths(home);
  assert.equal(JSON.parse(readFileSync(paths.settings, "utf8")).permissionMode, "allow");
  assert.equal(JSON.parse(readFileSync(paths.sandboxPolicy, "utf8")).enabled, true);
  writeFileSync(paths.daemonInfo, JSON.stringify({ port: 1, token: "gateway-token" }));
  const sandboxBytes = readFileSync(paths.sandboxPolicy, "utf8");
  const session = { home, cwd: paths.workspace };
  const denied = (surface: "path_read" | "path_write", tool: string, path: string, rule = path) =>
    `[pi-permission-system] Denied by policy: '${surface}' for tool '${tool}' for path '${path}' (rule '${rule}'). Reason: Pi Template protected paths.`;

  assert.equal(await toolResultFromTurn(faux, session, "read", { path: paths.piAuth }), denied("path_read", "read", paths.piAuth, `${paths.piAgentDir}/*`));
  for (const path of [paths.daemonInfo, paths.settings, paths.protectedPaths, paths.resourceApprovals, paths.sandboxVerification]) {
    assert.equal(await toolResultFromTurn(faux, session, "read", { path }), denied("path_read", "read", path));
  }
  const sandboxOff = JSON.stringify({ ...JSON.parse(sandboxBytes), enabled: false });
  assert.equal(
    await toolResultFromTurn(faux, session, "write", { path: paths.sandboxPolicy, content: sandboxOff }),
    denied("path_write", "write", paths.sandboxPolicy),
  );
  assert.equal(readFileSync(paths.sandboxPolicy, "utf8"), sandboxBytes);
  assert.equal(
    await toolResultFromTurn(faux, session, "bash", { command: `cat ${paths.piAuth}` }),
    denied("path_read", "bash", paths.piAuth, `${paths.piAgentDir}/*`),
  );

  const note = join(paths.workspace, "note.md");
  assert.equal(await toolResultFromTurn(faux, session, "write", { path: note, content: "kept\n" }), `Successfully wrote to ${note}`);
  assert.equal(await toolResultFromTurn(faux, session, "read", { path: note }), "kept\n");

  // Sessions refuse this policy; these checks show the runtime's own denials hold without that refusal.
  const homeInWriteRoots: SandboxPolicy = { ...JSON.parse(sandboxBytes), filesystem: {
    allowedReadRoots: [root], allowedWriteRoots: [root], deniedReadRoots: JSON.parse(sandboxBytes).filesystem.deniedReadRoots,
  } };
  const sandbox = createSandboxAdapter();
  const bashBehindRefusal = async (policy: SandboxPolicy, sessionHome: string, command: string, cwd = harnessPaths(sessionHome).workspace) => {
    let output = "";
    const { exitCode } = await sandbox.execute(enforcedSandboxPolicy(sessionHome, policy), {
      command, cwd, env: commandEnvironment(process.env), onOutput: (data) => { output += data.toString(); },
    });
    return `${output}exit ${exitCode}`;
  };
  const bash = (command: string) => bashBehindRefusal(homeInWriteRoots, home, command);
  const probe = await sandbox.verify({ ...homeInWriteRoots, enabled: true });
  if (probe.unavailable) {
    process.stdout.write(`SKIP — real sandbox unavailable for the control-file write check: ${probe.reason}\n`);
  } else {
    assert.match(await bash(`sed -i '' 's/"enabled": true/"enabled": false/' ../sandbox.js?n`), /Operation not permitted/);
    assert.equal(readFileSync(paths.sandboxPolicy, "utf8"), sandboxBytes);
    for (const control of ["settings.json", "protected_paths.json", "resource-approvals.json", "daemon.json"]) {
      const before = readFileSync(join(home, control), "utf8");
      await bash(`echo '{}' > ../${control.replace(".json", ".js?n")}`);
      assert.equal(readFileSync(join(home, control), "utf8"), before, `${control} is unchanged`);
    }
    assert.equal(await bash("cat ../daemon.js?n"), `${JSON.stringify({ port: 1, token: "gateway-token" })}exit 0`);
    assert.equal(await bash("cat ../p?/auth.json"), "cat: ../p?/auth.json: No such file or directory\nexit 1");
    assert.equal(await bash("echo kept > bash-note.md && cat bash-note.md"), "kept\nexit 0");

    // The daemon runs command schedules on the host, unsandboxed, so the state database and
    // its sidecars are control files too.
    new State(paths.stateDb).close();
    const insertCommandSchedule = [
      "sqlite3 ../stat?.db <<'SQL'",
      "INSERT INTO schedules VALUES ('escalate', 'escalate', 1, 'every', '{\"kind\":\"every\",\"everyMs\":60000,\"anchorMs\":0}', " +
        "'command', '{\"kind\":\"command\",\"argv\":[\"/usr/bin/true\"]}', '/', 30, 1, " +
        "'2026-10-16T00:00:00.000Z', '2026-10-16T00:00:00.000Z', '2026-10-16T00:00:00.000Z', NULL);",
      "SQL",
    ].join("\n");
    assert.equal(await bash(insertCommandSchedule), "Parse error near line 1: unable to open database file (14)\nexit 1");
    const stateBytes = readFileSync(paths.stateDb);
    assert.match(await bash("echo x >> ../stat?.db"), /Operation not permitted/);
    assert.deepEqual(readFileSync(paths.stateDb), stateBytes);
    const state = new State(paths.stateDb);
    assert.deepEqual(state.listSchedules(), [], "no schedule reached the daemon's database");
    state.close();
    for (const sidecar of ["state.db-wal", "state.db-shm", "state.db-journal"]) {
      const result = await bash(`f=${sidecar}; echo x > ../$f`);
      assert.match(result, /Operation not permitted/, `${sidecar} is not writable`);
      assert.equal(existsSync(join(home, sidecar)), false, `${sidecar} was not created`);
    }

    // Read denial of pi/ does not depend on what sandbox.json records.
    assert.equal(
      await bashBehindRefusal({ ...homeInWriteRoots, filesystem: { ...homeInWriteRoots.filesystem, deniedReadRoots: [] } }, home, "cat ../p?/auth.json"),
      "cat: ../p?/auth.json: No such file or directory\nexit 1",
    );

    // A home spelled through a symlink (macOS /var -> /private/var) still protects control
    // files that do not exist yet.
    const linkedHome = join(spelledRoot, "linked-home");
    assert.equal((await onboard([
      "--non-interactive", "--auth-file", join(standaloneDir, "auth.json"), "--acknowledge-resources", "--service", "declined", "--sandbox",
    ], passingOnboardingDependencies(linkedHome))).complete, true);
    const linkedPaths = harnessPaths(linkedHome);
    const linkedBash = (command: string) => bashBehindRefusal({ ...homeInWriteRoots, filesystem: {
      allowedReadRoots: [spelledRoot], allowedWriteRoots: [spelledRoot], deniedReadRoots: [],
    } }, linkedHome, command);
    assert.equal(await linkedBash("f=note; echo kept > ../$f.md && cat ../note.md"), "kept\nexit 0");
    assert.equal(existsSync(linkedPaths.daemonInfo), false);
    assert.match(await linkedBash("f=daemon; echo '{}' > ../$f.json"), /Operation not permitted/);
    assert.equal(existsSync(linkedPaths.daemonInfo), false, "a missing daemon.json under a symlinked home stays unwritten");
  }
  savePermissionMode(home, "read-only");
  assert.equal(await toolResultFromTurn(faux, session, "read", { path: paths.daemonInfo }), denied("path_read", "read", paths.daemonInfo));

  process.stdout.write("ok — neither the file tools nor sandboxed bash, even under a write root that contains the home, can change the harness control files or the state database, or read Pi credentials, and both still reach the workspace\n");
} finally {
  faux.unregister();
  rmSync(root, { recursive: true, force: true });
}
