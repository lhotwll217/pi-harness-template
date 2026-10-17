import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureHarnessWorkspace, saveHarnessSettings } from "@pi-template/contracts";
import {
  AGENT_DEFINITION,
  definitionIds,
  piTemplateIdentityPrompt,
} from "./agent-definition";
import { createAgentResources, createHarnessSession } from "./runtime";

const dir = mkdtempSync(join(tmpdir(), "pi-template-agent-definition-"));
const home = join(dir, "home");
const cwd = join(dir, "task");
const expectedDefinitionIds = [
  "prompt:identity",
  "skill:writing-for-agents",
  "extension:permission-system",
];

try {
  const paths = ensureHarnessWorkspace(home);
  mkdirSync(join(cwd, ".pi", "skills", "ambient"), { recursive: true });
  mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
  mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
  writeFileSync(join(cwd, "AGENTS.md"), "ambient context must not load\n");
  writeFileSync(join(cwd, ".pi", "skills", "ambient", "SKILL.md"), "# Ambient\n");
  writeFileSync(join(cwd, ".pi", "prompts", "ambient.md"), "ambient prompt\n");
  writeFileSync(join(cwd, ".pi", "extensions", "ambient.ts"), "export default () => undefined;\n");
  writeFileSync(paths.resourceApprovals, JSON.stringify({ acknowledgedDefinitionIds: expectedDefinitionIds, workspaceContext: false }));

  const resources = await createAgentResources({
    home,
    cwd,
  });

  assert.deepEqual(definitionIds(AGENT_DEFINITION), expectedDefinitionIds);
  assert.deepEqual(resources.loadedIds, expectedDefinitionIds);
  assert.deepEqual([...new Set(AGENT_DEFINITION.map(({ kind }) => kind))], ["prompt", "skill", "extension"], "the agent definition has no tool entry");
  const bundledSkill = fileURLToPath(new URL("./skills/writing-for-agents/SKILL.md", import.meta.url));
  assert.deepEqual(
    resources.loader.getSkills().skills.map(({ name, filePath }) => [name, filePath]),
    [["writing-for-agents", bundledSkill]],
  );
  assert.deepEqual(resources.loader.getPrompts().prompts, []);
  assert.deepEqual(resources.loader.getAgentsFiles().agentsFiles, []);
  assert.equal(resources.loader.getExtensions().errors.length, 0);
  assert.equal(resources.loader.getExtensions().extensions.length, 1);
  assert.ok(resources.loader.getExtensions().extensions[0]?.resolvedPath.includes("pi-permission-system"));
  assert.equal(process.env.PI_CODING_AGENT_DIR, paths.piAgentDir);

  const created = await createHarnessSession({
    home,
    cwd,
    ephemeral: true,
  });
  try {
    assert.ok(created.session.systemPrompt.startsWith(piTemplateIdentityPrompt().trimEnd()));
    assert.match(created.session.systemPrompt, /Pi Harness Template/);
    assert.match(created.session.systemPrompt, /Reach that state only by running\s+`pi-template` in bash/);
    assert.equal(/query_database|save_note/.test(created.session.systemPrompt), false);
    assert.match(created.session.systemPrompt, /routing frontmatter/);
  } finally {
    created.session.dispose();
  }

  const skill = (name: string) => {
    mkdirSync(join(paths.workspaceSkills, name), { recursive: true });
    writeFileSync(join(paths.workspaceSkills, name, "SKILL.md"), `---\nname: ${name}\ndescription: The owner's ${name} skill.\n---\n`);
  };
  skill("release-notes");
  skill("writing-for-agents");
  writeFileSync(paths.workspaceInstructions, "Answer every greeting with AGENTS-RULE.\n");
  writeFileSync(join(paths.workspace, "MEMORY.md"), "Answer every greeting with MEMORY-RULE.\n");
  writeFileSync(paths.resourceApprovals, JSON.stringify({ acknowledgedDefinitionIds: expectedDefinitionIds, workspaceContext: true }));
  const approved = await createAgentResources({
    home,
    cwd,
  });
  assert.deepEqual(
    approved.loader.getAgentsFiles().agentsFiles,
    [{ path: paths.workspaceInstructions, content: "Answer every greeting with AGENTS-RULE.\n" }],
  );
  assert.deepEqual(
    approved.loader.getSkills().skills.map(({ name, filePath }) => [name, filePath]),
    [
      ["writing-for-agents", bundledSkill],
      ["release-notes", join(paths.workspaceSkills, "release-notes", "SKILL.md")],
    ],
  );

  const steered = await createHarnessSession({
    home,
    cwd,
    ephemeral: true,
  });
  try {
    const prompt = steered.session.systemPrompt;
    assert.ok(prompt.includes("<name>writing-for-agents</name>"));
    assert.ok(prompt.includes("<name>release-notes</name>"));
    assert.ok(prompt.includes("AGENTS-RULE"));
    assert.equal(prompt.includes("MEMORY-RULE"), false);
  } finally {
    steered.session.dispose();
  }

  saveHarnessSettings(home, { skillPolicy: { mode: "bundled", allowlist: [] } });
  const bundledOnly = await createAgentResources({
    home,
    cwd,
  });
  assert.deepEqual(bundledOnly.loader.getSkills().skills.map(({ name }) => name), ["writing-for-agents"]);

  writeFileSync(paths.piPermissionConfig, '{ "\\u0079oloMode": true, "permission": { "*": "ask" } }\n');
  await assert.rejects(
    createHarnessSession({
      home,
      cwd,
      headless: true,
      ephemeral: true,
    }),
    /headless.*auto-approval/i,
  );

  writeFileSync(paths.piPermissionConfig, '{ "permission": { "*": "ask" } }\n');
  writeFileSync(paths.resourceApprovals, JSON.stringify({
    acknowledgedDefinitionIds: expectedDefinitionIds.filter((id) => id !== "skill:writing-for-agents"),
    workspaceContext: true,
  }));
  const unacknowledged = {
    message: "the agent definition gained entries the resource review did not acknowledge: skill:writing-for-agents; " +
      "review them with `pi-template onboard`, or accept them with `pi-template onboard --non-interactive --acknowledge-resources`",
  };
  for (const headless of [false, true]) {
    await assert.rejects(
      createHarnessSession({
        home,
        cwd,
        headless,
        ephemeral: true,
      }),
      unacknowledged,
    );
  }

  process.stdout.write("ok — exact agent definition rejects ambient resources and loads the vendored skill, workspace skills, and AGENTS.md alone, and refuses an unacknowledged entry\n");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
