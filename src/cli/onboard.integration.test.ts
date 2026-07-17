import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerOAuthProvider, unregisterOAuthProvider } from "@earendil-works/pi-ai/oauth";
import { AuthStorage } from "@earendil-works/pi-coding-agent";
import { harnessPaths } from "@pi-template/contracts";
import { passingOnboardingDependencies } from "../../test/helpers/onboarding";
import { onboard } from "./onboard";

const root = mkdtempSync(join(tmpdir(), "pi-template-cli-onboard-"));
const home = join(root, "home");

function scriptedInteraction(answers: string[]): {
  io: { question(prompt: string): Promise<string>; write(value: string): void };
  transcript: () => string;
} {
  let output = "";
  return {
    io: {
      async question(prompt) {
        output += prompt;
        const answer = answers.shift();
        if (answer === undefined) throw new Error(`missing scripted answer for ${prompt}`);
        output += `${answer}\n`;
        return answer;
      },
      write(value) { output += value; },
    },
    transcript: () => output,
  };
}

try {
  const result = await onboard([
    "--non-interactive",
    "--provider", "fake",
    "--api-key", "test-secret",
    "--model", "deterministic-model",
    "--permission", "ask",
    "--service", "declined",
    "--acknowledge-resources",
    "--sandbox-read", root,
    "--sandbox-write", root,
  ], passingOnboardingDependencies(home));
  assert.equal(result.complete, true);
  assert.equal(result.marker?.version, 1);
  assert.equal(harnessPaths(home).home, home);
  assert.equal((await onboard(["--non-interactive"], passingOnboardingDependencies(home))).complete, true);

  const standaloneAuth = join(root, "standalone-pi", "auth.json");
  const ownerOperatorAuth = join(root, "owner-operator", "pi", "auth.json");
  mkdirSync(join(root, "standalone-pi"), { recursive: true });
  mkdirSync(join(root, "owner-operator", "pi"), { recursive: true });
  const standaloneBytes = '{"standalone":{"type":"api_key","key":"standalone-secret"}}\n';
  const ownerOperatorBytes = '{"owner-provider":{"type":"api_key","key":"owner-secret"}}\n';
  writeFileSync(standaloneAuth, standaloneBytes);
  writeFileSync(ownerOperatorAuth, ownerOperatorBytes);
  const importedHome = join(root, "imported-home");
  const importInteraction = scriptedInteraction([
    "n", "y", "deterministic-model", "y", "ask", "", "n", "declined",
  ]);
  const importDependencies = passingOnboardingDependencies(importedHome);
  delete importDependencies.authVerifier;
  const imported = await onboard([], {
    ...importDependencies,
    interactiveIO: importInteraction.io,
    standalonePiAuthPath: standaloneAuth,
    ownerOperatorAuthPath: ownerOperatorAuth,
  });
  assert.equal(imported.complete, true);
  assert.ok(importInteraction.transcript().includes(`Copy existing Pi authorizations from ${standaloneAuth}? [y/N]`));
  assert.ok(importInteraction.transcript().includes(`Copy existing Pi authorizations from ${ownerOperatorAuth}? [y/N]`));
  assert.deepEqual(
    JSON.parse(readFileSync(harnessPaths(importedHome).piAuth, "utf8")),
    JSON.parse(ownerOperatorBytes),
  );
  assert.equal(readFileSync(standaloneAuth, "utf8"), standaloneBytes);
  assert.equal(readFileSync(ownerOperatorAuth, "utf8"), ownerOperatorBytes);

  const fakeProviderId = "pi-template-test-oauth";
  registerOAuthProvider({
    id: fakeProviderId,
    name: "Pi Template Test OAuth",
    async login() {
      return { access: "canned-access", refresh: "canned-refresh", expires: 4_102_444_800_000 };
    },
    async refreshToken(credentials) { return credentials; },
    getApiKey(credentials) { return credentials.access; },
  });
  try {
    const loginHome = join(root, "login-home");
    const loginInteraction = scriptedInteraction([
      fakeProviderId, "deterministic-model", "y", "ask", "", "n", "declined",
    ]);
    const loginDependencies = passingOnboardingDependencies(loginHome);
    delete loginDependencies.authVerifier;
    const loggedIn = await onboard([], {
      ...loginDependencies,
      interactiveIO: loginInteraction.io,
      standalonePiAuthPath: join(root, "missing-standalone-auth.json"),
      ownerOperatorAuthPath: join(root, "missing-owner-operator-auth.json"),
    });
    assert.equal(loggedIn.complete, true);
    assert.match(loginInteraction.transcript(), /Pi Template Test OAuth/);
    assert.deepEqual(AuthStorage.create(harnessPaths(loginHome).piAuth).get(fakeProviderId), {
      type: "oauth",
      access: "canned-access",
      refresh: "canned-refresh",
      expires: 4_102_444_800_000,
    });
  } finally {
    unregisterOAuthProvider(fakeProviderId);
  }

  const manualHome = join(root, "manual-home");
  const invalidAuthPath = join(root, "invalid-auth.json");
  writeFileSync(invalidAuthPath, "{}\n");
  const manualInteraction = scriptedInteraction([
    "manual", "manual-provider", "manual-secret", "deterministic-model", "y", "ask", "", "n", "declined",
  ]);
  const manualDependencies = passingOnboardingDependencies(manualHome);
  delete manualDependencies.authVerifier;
  const manual = await onboard([], {
    ...manualDependencies,
    interactiveIO: manualInteraction.io,
    standalonePiAuthPath: invalidAuthPath,
    ownerOperatorAuthPath: join(root, "missing-owner-operator-auth.json"),
  });
  assert.equal(manual.complete, true);
  assert.ok(!manualInteraction.transcript().includes(`Copy existing Pi authorizations from ${invalidAuthPath}`));
  assert.match(manualInteraction.transcript(), /enter an API key manually/);
  assert.deepEqual(AuthStorage.create(harnessPaths(manualHome).piAuth).get("manual-provider"), {
    type: "api_key",
    key: "manual-secret",
  });
  process.stdout.write("ok — onboarding supports flags, read-only auth imports, built-in provider login, and manual keys\n");
} finally {
  rmSync(root, { recursive: true, force: true });
}
