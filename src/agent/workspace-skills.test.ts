import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSkills } from "@earendil-works/pi-coding-agent";
import { ensureHarnessWorkspace, harnessPaths, saveHarnessSettings } from "@pi-template/contracts";
import { AGENT_DEFINITION, definitionIds } from "./agent-definition";
import { runDoctor } from "./doctor";
import { createAgentResources, inspectWorkspaceSkills } from "./runtime";

const write = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
const described = (path: string, name?: string) =>
  write(path, `---\n${name ? `name: ${name}\n` : ""}description: Test file ${path}.\n---\n`);

const layouts: Record<string, (skills: string, outside: string) => void> = {
  "cloned repo": (skills) => {
    described(join(skills, "repo", "CONTRIBUTING.md"));
    write(join(skills, "repo", "README.md"), "# Repo\n");
    described(join(skills, "repo", "docs", "guide.md"));
    described(join(skills, "repo", "tools", "lint", "SKILL.md"));
    write(join(skills, "repo", ".gitignore"), "private/\n");
    described(join(skills, "repo", "private", "SKILL.md"), "private-skill");
  },
  "commands folder": (skills) => {
    described(join(skills, "commands", "review.md"));
    described(join(skills, "commands", "ship.md"));
  },
  "nested skills": (skills) => {
    described(join(skills, "pack", "alpha", "SKILL.md"));
    described(join(skills, "pack", "deep", "beta", "SKILL.md"));
    described(join(skills, "pack", "gamma", "SKILL.md"));
    described(join(skills, "pack", "gamma", "inner", "SKILL.md"), "inner");
    described(join(skills, "pack", ".hidden", "SKILL.md"), "hidden");
    described(join(skills, "pack", "node_modules", "dep", "SKILL.md"), "dep");
    described(join(skills, "folder-skill", "SKILL.md"));
    described(join(skills, "folder-skill", "extra.md"), "extra");
  },
  "top-level md": (skills) => {
    described(join(skills, "loose.md"), "loose");
    described(join(skills, "unnamed.md"));
    write(join(skills, "notes.md"), "# Notes without frontmatter\n");
    write(join(skills, "LICENSE"), "MIT\n");
  },
  "links to outside folders": (skills, outside) => {
    described(join(outside, "single", "SKILL.md"));
    symlinkSync(join(outside, "single"), join(skills, "linked"));
    symlinkSync(join(outside, "single"), join(skills, "zz-alias"));
    described(join(outside, "bundle", "top.md"));
    described(join(outside, "bundle", "one", "SKILL.md"));
    symlinkSync(join(outside, "bundle", "one"), join(outside, "bundle", "two"));
    symlinkSync(join(outside, "bundle"), join(skills, "bundle"));
    described(join(outside, "loose.md"), "linked-loose");
    symlinkSync(join(outside, "loose.md"), join(skills, "linked-loose.md"));
    described(join(outside, "skill-file", "SKILL.md"), "file-link");
    mkdirSync(join(skills, "file-link"));
    symlinkSync(join(outside, "skill-file", "SKILL.md"), join(skills, "file-link", "SKILL.md"));
  },
  "root ignore file": (skills) => {
    write(join(skills, ".gitignore"), "ignored/\nskipped.md\n");
    described(join(skills, "ignored", "SKILL.md"), "ignored");
    described(join(skills, "skipped.md"), "skipped");
    described(join(skills, "kept", "SKILL.md"));
  },
  "name collision": (skills) => {
    described(join(skills, "first", "SKILL.md"), "same");
    described(join(skills, "second", "SKILL.md"), "same");
  },
  "root SKILL.md": (skills) => {
    described(join(skills, "SKILL.md"), "root-skill");
    described(join(skills, "below", "SKILL.md"));
  },
};

function newHome(): { home: string; skills: string; outside: string } {
  const home = mkdtempSync(join(tmpdir(), "pi-template-skill-parity-"));
  const paths = ensureHarnessWorkspace(home);
  writeFileSync(paths.resourceApprovals, JSON.stringify({ acknowledgedDefinitionIds: definitionIds(AGENT_DEFINITION) }));
  return { home, skills: paths.workspaceSkills, outside: join(home, "outside") };
}

function piLoads(home: string) {
  const paths = harnessPaths(home);
  const { skills, diagnostics } = loadSkills({
    cwd: paths.workspace,
    agentDir: paths.piAgentDir,
    skillPaths: [paths.workspaceSkills],
    includeDefaults: false,
  });
  return {
    loaded: skills.map(({ name }) => name).sort(),
    collisions: diagnostics.flatMap(({ collision }) => collision
      ? [{ name: collision.name, path: collision.loserPath, winner: collision.winnerPath }]
      : []),
  };
}

async function sessionSkills(home: string): Promise<string[]> {
  const session = await createAgentResources({
    home,
    cwd: home,
  });
  return session.loader.getSkills().skills.map(({ name }) => name);
}

const homes: string[] = [];
try {
  const everything = newHome();
  homes.push(everything.home);
  for (const [layout, build] of Object.entries(layouts)) {
    if (layout !== "root SKILL.md") build(everything.skills, everything.outside);
    const single = newHome();
    homes.push(single.home);
    build(single.skills, single.outside);
    const { loaded, collisions } = inspectWorkspaceSkills(single.home);
    assert.deepEqual({ loaded, collisions }, piLoads(single.home), `${layout}: the harness loads what Pi loads from workspace/skills`);
  }
  const combined = inspectWorkspaceSkills(everything.home);
  assert.deepEqual({ loaded: combined.loaded, collisions: combined.collisions }, piLoads(everything.home));
  assert.deepEqual(combined.loaded, [
    "alpha", "beta", "file-link", "folder-skill", "gamma", "kept", "linked", "linked-loose", "lint", "loose", "one", "same", "skills",
  ]);

  symlinkSync("..", join(everything.skills, "pack", "deep", "up"));
  const looped = inspectWorkspaceSkills(everything.home);
  assert.deepEqual(looped.skippedLinks, [
    { name: "pack/deep/up", target: "..", reason: "loops back to pack, so pack is not loaded" },
  ]);
  rmSync(join(everything.skills, "pack"), { recursive: true });
  assert.deepEqual(looped.loaded, piLoads(everything.home).loaded, "only the looping entry is left out");

  const chain = newHome();
  homes.push(chain.home);
  const levels = 18;
  for (let level = 0; level < levels; level += 1) {
    mkdirSync(join(chain.outside, `level-${level}`), { recursive: true });
    mkdirSync(join(chain.outside, `level-${level + 1}`), { recursive: true });
    symlinkSync(`../level-${level + 1}`, join(chain.outside, `level-${level}`, "left"));
    symlinkSync(`../level-${level + 1}`, join(chain.outside, `level-${level}`, "right"));
  }
  described(join(chain.outside, `level-${levels}`, "SKILL.md"), "bottom");
  symlinkSync(join(chain.outside, "level-0"), join(chain.skills, "chain"));
  described(join(chain.skills, "fine", "SKILL.md"));
  const probe = `
    const { runDoctor, createAgentResources } = await import(${JSON.stringify(fileURLToPath(new URL("./index.ts", import.meta.url)))});
    const started = Date.now();
    const doctor = await runDoctor({ home: process.env.CHAIN_HOME, providerModelVerifier: () => true });
    const session = await createAgentResources({
      home: process.env.CHAIN_HOME,
      cwd: process.env.CHAIN_HOME,
    });
    process.stdout.write(JSON.stringify({
      seconds: (Date.now() - started) / 1000,
      workspaceSkills: doctor.checks.resources.workspaceSkills,
      skippedEntries: doctor.checks.resources.skippedSkillEntries,
      sessionSkills: session.loader.getSkills().skills.map(({ name }) => name),
    }));
  `;
  const run = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", probe], {
    env: { ...process.env, CHAIN_HOME: chain.home },
    encoding: "utf8",
    timeout: 30_000,
    killSignal: "SIGKILL",
  });
  assert.equal(run.signal, null, "doctor and a session finish within 30 s over 18 stacked two-link levels");
  assert.equal(run.status, 0, run.stderr);
  const bounded = JSON.parse(run.stdout);
  assert.ok(bounded.seconds < 10, `doctor and a session took ${bounded.seconds} s`);
  assert.deepEqual({ ...bounded, seconds: undefined }, {
    seconds: undefined,
    workspaceSkills: ["fine"],
    skippedEntries: [{ name: "chain", reason: "Pi would walk more than 5000 folders in chain, so chain is not loaded" }],
    sessionSkills: ["writing-for-agents", "fine"],
  });

  const locked = newHome();
  homes.push(locked.home);
  described(join(locked.skills, "hidden-by-mode", "SKILL.md"));
  chmodSync(locked.skills, 0o000);
  try {
    assert.deepEqual(inspectWorkspaceSkills(locked.home).loaded, []);
    assert.deepEqual(await sessionSkills(locked.home), ["writing-for-agents"]);
    const doctor = await runDoctor({ home: locked.home, providerModelVerifier: () => true });
    assert.deepEqual(doctor.checks.resources.workspaceSkills, []);
    assert.ok(doctor.checks.resources.notices.includes(
      `${locked.skills} is unreadable (EACCES), so no workspace skill loads`,
    ), JSON.stringify(doctor.checks.resources.notices));
  } finally {
    chmodSync(locked.skills, 0o755);
  }

  for (const mode of [0o644, 0o444]) {
    const listed = newHome();
    homes.push(listed.home);
    described(join(listed.skills, "inside", "SKILL.md"));
    described(join(listed.skills, "nested", "deeper", "SKILL.md"));
    described(join(listed.outside, "target", "SKILL.md"));
    symlinkSync(join(listed.outside, "target"), join(listed.skills, "linked"));
    chmodSync(listed.skills, mode);
    const label = `workspace/skills at mode ${mode.toString(8)}`;
    try {
      assert.deepEqual(piLoads(listed.home).loaded, [], `${label}: Pi loads no skill`);
      assert.deepEqual(await sessionSkills(listed.home), ["writing-for-agents"], `${label}: a session starts with no workspace skill`);
      const doctor = await runDoctor({ home: listed.home, providerModelVerifier: () => true });
      assert.deepEqual(doctor.checks.resources.workspaceSkills, [], label);
      assert.deepEqual(doctor.checks.resources.brokenSkillLinksNotLoaded, [], label);
      assert.ok(doctor.checks.resources.notices.includes(
        `${listed.skills} is unreadable (EACCES), so no workspace skill loads`,
      ), `${label}: ${JSON.stringify(doctor.checks.resources.notices)}`);
    } finally {
      chmodSync(listed.skills, 0o755);
    }
  }

  const partly = newHome();
  homes.push(partly.home);
  described(join(partly.skills, "fine", "SKILL.md"));
  described(join(partly.skills, "listed-pack", "inner", "SKILL.md"));
  described(join(partly.skills, "sealed", "SKILL.md"));
  chmodSync(join(partly.skills, "listed-pack"), 0o644);
  chmodSync(join(partly.skills, "sealed"), 0o000);
  try {
    assert.deepEqual(inspectWorkspaceSkills(partly.home).loaded, piLoads(partly.home).loaded);
    assert.deepEqual(await sessionSkills(partly.home), ["writing-for-agents", "fine"]);
    const doctor = await runDoctor({ home: partly.home, providerModelVerifier: () => true });
    assert.deepEqual(doctor.checks.resources.skippedSkillEntries, [
      { name: "listed-pack", reason: "unreadable (EACCES), so nothing in it loads" },
      { name: "sealed", reason: "unreadable (EACCES), so nothing in it loads" },
    ]);
  } finally {
    chmodSync(join(partly.skills, "listed-pack"), 0o755);
    chmodSync(join(partly.skills, "sealed"), 0o755);
  }

  for (const mode of [0o644, 0o444]) {
    const enterless = newHome();
    homes.push(enterless.home);
    described(join(enterless.skills, "fine", "SKILL.md"));
    described(join(enterless.skills, "direct", "SKILL.md"));
    chmodSync(join(enterless.skills, "direct"), mode);
    const label = `direct at mode ${mode.toString(8)}`;
    try {
      assert.deepEqual(inspectWorkspaceSkills(enterless.home).loaded, piLoads(enterless.home).loaded, label);
      assert.deepEqual(await sessionSkills(enterless.home), ["writing-for-agents", "fine"], label);
      const doctor = await runDoctor({ home: enterless.home, providerModelVerifier: () => true });
      assert.deepEqual(doctor.checks.resources.skippedSkillEntries, [
        { name: "direct", reason: "unreadable (EACCES), so nothing in it loads" },
      ], label);
    } finally {
      chmodSync(join(enterless.skills, "direct"), 0o755);
    }
  }

  const aliased = newHome();
  homes.push(aliased.home);
  described(join(aliased.skills, "holder", "SKILL.md"), "a");
  described(join(aliased.outside, "nameless", "SKILL.md"));
  symlinkSync(join(aliased.outside, "nameless"), join(aliased.skills, "a"));
  symlinkSync(join(aliased.outside, "nameless"), join(aliased.skills, "b"));
  saveHarnessSettings(aliased.home, { skillPolicy: { mode: "allowlist", allowlist: ["holder", "a", "b"] } });
  assert.deepEqual(await sessionSkills(aliased.home), ["writing-for-agents", "a"], "the session drops a second path to the same file");
  const aliasedReport = inspectWorkspaceSkills(aliased.home);
  assert.deepEqual({ loaded: aliasedReport.loaded, collisions: aliasedReport.collisions }, {
    loaded: ["a"],
    collisions: [{ name: "a", path: join(aliased.skills, "a", "SKILL.md"), winner: join(aliased.skills, "holder", "SKILL.md") }],
  }, "doctor reports what the session loads");

  const wide = newHome();
  homes.push(wide.home);
  let bottom = join(wide.skills, "deep");
  for (let level = 0; level < 400; level += 1) bottom = join(bottom, "d");
  for (let index = 0; index < 4500; index += 1) mkdirSync(join(bottom, `w${index}`), { recursive: true });
  described(join(bottom, "w0", "SKILL.md"), "bottom");
  const wideStarted = Date.now();
  assert.deepEqual(inspectWorkspaceSkills(wide.home).loaded, ["bottom"]);
  const wideSeconds = (Date.now() - wideStarted) / 1000;
  assert.ok(wideSeconds < 5, `walking 400 folders deep and 4,500 wide took ${wideSeconds} s`);

  process.stdout.write("ok — workspace skills load as Pi loads workspace/skills, bounded, and an unreadable folder loads none\n");
} finally {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
}
