import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDocsCatalog } from "./docs-catalog";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const catalog = createDocsCatalog(repositoryRoot);
const listed = catalog.list();
assert.ok(listed.some(({ id }) => id === "scheduler"));
assert.equal("body" in listed[0], false, "list is a metadata projection");
assert.equal(catalog.read("scheduler").id, "scheduler");
assert.deepEqual(catalog.read("not-a-document"), {
  code: "unknown_docs_id",
  id: "not-a-document",
  candidates: [],
});
const ambiguous = catalog.read("s");
assert.equal("code" in ambiguous && ambiguous.code, "ambiguous_docs_id");
assert.equal(catalog.query("how do I add a scheduled prompt").matches[0]?.id, "scheduler");

process.stdout.write("ok — DocsCatalog owns stable list, lookup, and ranked query behavior\n");
