import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureHarnessWorkspace } from "@pi-template/contracts";
import {
  AGENT_RESOURCE_CATALOG,
  catalogIds,
  piTemplateIdentityPrompt,
} from "./resource-catalog";
import { createAgentResources, createHarnessSession } from "./runtime";

const dir = mkdtempSync(join(tmpdir(), "pi-template-resource-catalog-"));
const home = join(dir, "home");
const cwd = join(dir, "task");
const expectedCatalogIds = [
  "prompt:identity",
  "tool:query_database",
  "tool:save_note",
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

  const resources = await createAgentResources({
    home,
    cwd,
    query: {
      listTables: () => [],
      describeTable: () => ({ description: "", columns: [] }),
      runQuery: () => ({ rows: [], truncated: false }),
    },
    notes: {
      createNote: () => ({ id: "n", body: "", createdAt: "", updatedAt: "" }),
    },
  });

  assert.deepEqual(catalogIds(AGENT_RESOURCE_CATALOG), expectedCatalogIds);
  assert.deepEqual(resources.loadedIds, expectedCatalogIds);
  assert.deepEqual(resources.tools.map(({ name }) => name), ["query_database", "save_note"]);
  assert.deepEqual(resources.loader.getSkills().skills, []);
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
    toolsAllow: [],
    query: {
      listTables: () => [],
      describeTable: () => ({ description: "", columns: [] }),
      runQuery: () => ({ rows: [], truncated: false }),
    },
    notes: { createNote: () => ({ id: "n", body: "", createdAt: "", updatedAt: "" }) },
  });
  try {
    assert.ok(created.session.systemPrompt.startsWith(piTemplateIdentityPrompt().trimEnd()));
    assert.match(created.session.systemPrompt, /Pi Harness Template/);
    assert.match(created.session.systemPrompt, /list_tables.*describe_table.*bounded `SELECT`/s);
    assert.match(created.session.systemPrompt, /single State writer/);
    assert.match(created.session.systemPrompt, /routing frontmatter/);
  } finally {
    created.session.dispose();
  }

  writeFileSync(join(home, "resource-approvals.json"), JSON.stringify({ workspaceContext: true }));
  const approved = await createAgentResources({
    home,
    cwd,
    query: {
      listTables: () => [],
      describeTable: () => ({ description: "", columns: [] }),
      runQuery: () => ({ rows: [], truncated: false }),
    },
    notes: { createNote: () => ({ id: "n", body: "", createdAt: "", updatedAt: "" }) },
  });
  assert.deepEqual(
    approved.loader.getAgentsFiles().agentsFiles.map(({ path }) => path),
    [paths.workspaceInstructions, paths.workspaceMemory],
  );

  writeFileSync(paths.piPermissionConfig, '{ "\\u0079oloMode": true, "permission": { "*": "ask" } }\n');
  await assert.rejects(
    createHarnessSession({
      home,
      cwd,
      headless: true,
      ephemeral: true,
      query: {
        listTables: () => [],
        describeTable: () => ({ description: "", columns: [] }),
        runQuery: () => ({ rows: [], truncated: false }),
      },
      notes: { createNote: () => ({ id: "n", body: "", createdAt: "", updatedAt: "" }) },
    }),
    /headless.*auto-approval/i,
  );

  process.stdout.write("ok — exact catalog rejects ambient resources and loads only approved workspace context\n");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
