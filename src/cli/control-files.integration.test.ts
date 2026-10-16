import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { harnessPaths, savePermissionMode } from "@pi-template/contracts";
import { passingOnboardingDependencies } from "../../test/helpers/onboarding";
import { toolResultFromTurn } from "../../test/helpers/tool-turn";
import { onboard } from "./onboard";

const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-template-control-files-")));
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

  savePermissionMode(home, "read-only");
  assert.equal(await toolResultFromTurn(faux, session, "read", { path: paths.daemonInfo }), denied("path_read", "read", paths.daemonInfo));

  process.stdout.write("ok — the agent's file tools cannot read or change the harness control files or Pi credentials, and still reach the workspace\n");
} finally {
  faux.unregister();
  rmSync(root, { recursive: true, force: true });
}
