// Unit: transparent model-free ranking over fixture and real repository documentation.
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDocsCatalog } from "./catalog";
import { queryDocs } from "./query";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const fixtureRoot = join(repositoryRoot, "test/fixtures/docs-catalog");
const fixtureDocuments = loadDocsCatalog(fixtureRoot);

const fixtureResult = queryDocs(fixtureDocuments, "when should I add a recurring prompt");
assert.deepEqual(fixtureResult.matches[0], {
  id: "scheduler",
  title: "Scheduled work",
  score: 10,
  matchedOn: ["summary", "read_when", "section_heading"],
});
assert.deepEqual(fixtureResult.readingPlan, ["scheduler"]);

// Only routed metadata and headings participate; incidental body prose does not.
assert.deepEqual(queryDocs(fixtureDocuments, "private").matches, []);
assert.deepEqual(queryDocs(fixtureDocuments, "the and where").readingPlan, []);

const repositoryDocuments = loadDocsCatalog(repositoryRoot);
assert.equal(
  queryDocs(repositoryDocuments, "how do I add a scheduled prompt").matches[0]?.id,
  "scheduler",
);
assert.equal(
  queryDocs(repositoryDocuments, "where does durable state live").matches[0]?.id,
  "state-and-sessions",
);
assert.equal(
  queryDocs(repositoryDocuments, "how do I set up onboarding").matches[0]?.id,
  "onboarding",
);

const broadResult = queryDocs(repositoryDocuments, "designing");
assert.ok(broadResult.matches.length > 5);
// The plan is bounded and ordered by score; its exact tail may legitimately
// shift as pages are added, so only the bound and ranking rule are contract.
assert.equal(broadResult.readingPlan.length, 5);
assert.equal(broadResult.readingPlan[0], broadResult.matches[0]?.id);
const planScores = broadResult.readingPlan.map(
  (id) => broadResult.matches.find((match) => match.id === id)?.score ?? -1,
);
assert.deepEqual(planScores, [...planScores].sort((a, b) => b - a));

console.log("query.test.ts ok");
