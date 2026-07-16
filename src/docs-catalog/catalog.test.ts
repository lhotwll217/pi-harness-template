// Unit: documentation catalog loading from a repository-shaped fixture tree.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadDocsCatalog } from "./catalog";

const fixtureRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../test/fixtures/docs-catalog",
);

const documents = loadDocsCatalog(fixtureRoot);
assert.deepEqual(documents.map(({ id }) => id), ["scheduler", "state"]);

const scheduler = documents[0];
assert.equal(scheduler.path, "docs/scheduler.md");
assert.equal(scheduler.title, "Scheduled work");
assert.equal(scheduler.summary, "Runs prompts at predictable times");
assert.deepEqual(scheduler.readWhen, ["Adding a recurring prompt", "Checking run isolation"]);
assert.ok(scheduler.body.startsWith("# Scheduled work\n"));
assert.deepEqual(scheduler.sections, [
  { id: "scheduled-work", heading: "Scheduled work", startLine: 9 },
  { id: "add-a-prompt", heading: "Add a prompt", startLine: 13 },
  { id: "add-a-prompt-1", heading: "Add a prompt", startLine: 17 },
]);
assert.equal(
  scheduler.contentHash,
  "a629748999b2e90bd814bc882d54524fccafbaafb97190cd4d2e4bad2681de52",
);
assert.deepEqual(documents[1].sections, [
  { id: "durable-state", heading: "Durable state", startLine: 8 },
  { id: "where-records-live", heading: "Where records live", startLine: 12 },
]);
assert.deepEqual(loadDocsCatalog(fixtureRoot), documents);

assert.throws(
  () => loadDocsCatalog(join(fixtureRoot, "invalid/missing-title")),
  /docs\/incomplete\.md: title missing/,
);
assert.throws(
  () => loadDocsCatalog(join(fixtureRoot, "invalid/missing-summary")),
  /docs\/incomplete\.md: summary missing/,
);
assert.throws(
  () => loadDocsCatalog(join(fixtureRoot, "invalid/empty-read-when")),
  /docs\/incomplete\.md: read_when missing or empty/,
);
assert.throws(
  () => loadDocsCatalog(join(fixtureRoot, "invalid/malformed-summary")),
  /docs\/incomplete\.md: summary invalid/,
);
assert.throws(
  () => loadDocsCatalog(join(fixtureRoot, "invalid/multiline-summary")),
  /docs\/incomplete\.md: summary invalid/,
);
assert.throws(
  () => loadDocsCatalog(join(fixtureRoot, "invalid/duplicate-id")),
  /duplicate document id "shared": docs\/one\/shared\.md, docs\/two\/shared\.md/,
);

console.log("catalog.test.ts ok");
