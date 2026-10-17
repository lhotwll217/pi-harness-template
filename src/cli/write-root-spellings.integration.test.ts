import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { harnessPaths } from "@pi-template/contracts";
import { createAgentResources } from "../agent/runtime";
import { passingOnboardingDependencies } from "../../test/helpers/onboarding";
import { onboard } from "./onboard";

const spelledRoot = mkdtempSync(join(tmpdir(), "pi-template-write-root-spellings-"));
const realRoot = realpathSync(spelledRoot);
mkdirSync("/tmp/claude", { recursive: true });
const builtInRoot = mkdtempSync("/tmp/claude/pi-template-write-root-spellings-");
const faux = registerFauxProvider();
const unused = async (): Promise<never> => { throw new Error("not used"); };
const resources = { query: { listTables: unused, describeTable: unused, runQuery: unused }, notes: { createNote: unused } };
const recovery = "`pi-template onboard --sandbox-write <dir>`, or turn the sandbox off with `--sandbox-off`";
const contains = (root: string, home: string) =>
  `sandbox write root ${root} contains the harness home ${home}, so sandboxed bash could rewrite the files that set its own limits. ` +
  `Record write roots outside the home: ${recovery}`;
const misspelled = (root: string, reason: string) =>
  `sandbox write root ${root} ${reason}, so the sandbox would not read it the way the harness checks it. ` +
  `Record plain absolute write roots outside the home: ${recovery}`;
const builtIn = (root: string, home: string) =>
  `the sandbox always lets bash write ${root}, which contains the harness home ${home}, so sandboxed bash could rewrite ` +
  `the files that set its own limits. Move the harness home out of ${root}, or turn the sandbox off with \`--sandbox-off\``;

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
  const beside = join(realRoot, "beside");
  mkdirSync(beside);
  const sandboxed = (writeRoot: string) => [...onboardFlags, "--sandbox", "--sandbox-read", beside, "--sandbox-write", writeRoot];
  const turnSandboxOn = (home: string, allowedWriteRoots: string[]) => {
    const { sandboxPolicy } = harnessPaths(home);
    const recorded = JSON.parse(readFileSync(sandboxPolicy, "utf8"));
    writeFileSync(sandboxPolicy, JSON.stringify({ ...recorded, enabled: true, filesystem: { ...recorded.filesystem, allowedWriteRoots } }));
  };

  const accentedParent = join(realRoot, "café");
  mkdirSync(accentedParent);
  const cases: Array<{ label: string; home: string; writeRoot: string; refusal: string }> = [
    { label: "a trailing /** glob over the home's parent", home: join(realRoot, "glob-home"), writeRoot: `${realRoot}/**`,
      refusal: misspelled(`${realRoot}/**`, "has glob characters") },
    { label: "the home's parent in another letter case",
      home: join(realRoot, "case-home"), writeRoot: join(dirname(realRoot), basename(realRoot).toUpperCase()),
      refusal: contains(join(dirname(realRoot), basename(realRoot).toUpperCase()), join(realRoot, "case-home")) },
    { label: "the home's parent in Unicode NFD", home: join(accentedParent, "home"), writeRoot: join(realRoot, "café"),
      refusal: contains(join(realRoot, "café"), join(accentedParent, "home")) },
    { label: "a home spelled through the /System/Volumes/Data firmlink",
      home: `/System/Volumes/Data${realRoot}/firmlink-home`, writeRoot: realRoot,
      refusal: contains(realRoot, `/System/Volumes/Data${realRoot}/firmlink-home`) },
    { label: "a home under the sandbox's built-in /tmp/claude write path", home: join(builtInRoot, "home"), writeRoot: beside,
      refusal: builtIn("/tmp/claude", join(builtInRoot, "home")) },
  ];
  for (const { label, home, writeRoot, refusal } of cases) {
    if (!existsSync(writeRoot.replace(/\/\*\*$/, "")) || !existsSync(dirname(home))) {
      process.stdout.write(`SKIP — ${label}: this filesystem does not resolve that spelling\n`);
      continue;
    }
    await assert.rejects(onboard(sandboxed(writeRoot), passingOnboardingDependencies(home)), { message: `sandbox: ${refusal}` }, label);
    assert.equal(existsSync(harnessPaths(home).sandboxPolicy), false, `${label}: a refused write root is never recorded`);
    assert.equal((await onboard([...onboardFlags, "--sandbox-off", "--sandbox-read", beside, "--sandbox-write", writeRoot],
      passingOnboardingDependencies(home))).complete, true, `${label}: an off sandbox may record any root`);
    await assert.rejects(onboard([...onboardFlags, "--sandbox"], passingOnboardingDependencies(home)), { message: `sandbox: ${refusal}` }, label);
    turnSandboxOn(home, [writeRoot]);
    await assert.rejects(createAgentResources({ home, cwd: beside, ...resources }), { message: refusal }, `${label} at session start`);
  }

  const editedHome = join(realRoot, "edited-home");
  assert.equal((await onboard(sandboxed(beside), passingOnboardingDependencies(editedHome))).complete, true);
  for (const [writeRoot, reason] of [
    ["~/elsewhere", "starts with ~"],
    [`${realRoot}/*`, "has glob characters"],
    ["elsewhere", "is not an absolute path"],
  ] as const) {
    turnSandboxOn(editedHome, [beside, writeRoot]);
    await assert.rejects(createAgentResources({ home: editedHome, cwd: beside, ...resources }), { message: misspelled(writeRoot, reason) },
      `a hand-edited ${writeRoot} root at session start`);
    await assert.rejects(onboard([...onboardFlags, "--sandbox"], passingOnboardingDependencies(editedHome)), {
      message: `sandbox: ${misspelled(writeRoot, reason)}`,
    }, `a hand-edited ${writeRoot} root at onboarding`);
  }

  const brokenLink = join(realRoot, "broken-link");
  symlinkSync(join(realRoot, "not-there-yet"), brokenLink);
  for (const writeRoot of [brokenLink, join(brokenLink, "below")]) {
    const refusal = misspelled(writeRoot, `passes through the broken symlink ${brokenLink}`);
    const home = join(realRoot, `broken-link-home-${basename(writeRoot)}`);
    await assert.rejects(onboard(sandboxed(writeRoot), passingOnboardingDependencies(home)), { message: `sandbox: ${refusal}` },
      `a ${writeRoot} write root at onboarding`);
    assert.equal(existsSync(harnessPaths(home).sandboxPolicy), false, `a ${writeRoot} write root is never recorded`);
    turnSandboxOn(editedHome, [beside, writeRoot]);
    await assert.rejects(createAgentResources({ home: editedHome, cwd: beside, ...resources }), { message: refusal },
      `a hand-edited ${writeRoot} root at session start`);
  }

  const interactiveHome = join(realRoot, "interactive-home");
  const questions: string[] = [];
  await assert.rejects(onboard(["--sandbox", "--sandbox-read", beside, "--sandbox-write", `${realRoot}/**`], {
    ...passingOnboardingDependencies(interactiveHome),
    standalonePiAuthPath: join(standaloneDir, "auth.json"),
    interactiveIO: { question: async (prompt) => { questions.push(prompt); return ""; }, write: () => undefined },
  }), { message: `sandbox: ${misspelled(`${realRoot}/**`, "has glob characters")}` });
  assert.deepEqual(questions, [], "interactive onboarding refuses the write root before asking anything");

  process.stdout.write("ok — a write root that reaches the harness home through a glob, letter case, Unicode form, firmlink, ~, " +
    "a broken symlink, or the sandbox's built-in paths is refused at onboarding and at session start\n");
} finally {
  faux.unregister();
  rmSync(realRoot, { recursive: true, force: true });
  rmSync(builtInRoot, { recursive: true, force: true });
}
