// Public architecture guard: the Gateway is transport only. Runtime modules here may
// translate HTTP/SSE into typed calls, but may not own persistence, scheduling, model
// calls, or process execution.
import assert from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const runtime = readdirSync(here, { recursive: true, withFileTypes: false })
  .map((file) => relative(here, join(here, String(file))))
  .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"));
assert.ok(runtime.length >= 3, `Gateway runtime modules found (${runtime.length})`);

const ALLOWED_IMPORTS = new Set([
  "@pi-template/contracts",
  "node:crypto",
  "node:fs",
  "node:http",
  "./client",
  "./server",
]);

for (const file of runtime) {
  const source = readFileSync(join(here, file), "utf8");
  const imports = [
    ...source.matchAll(/\bfrom\s+["']([^"']+)["']/g),
    ...source.matchAll(/\bimport\s+["']([^"']+)["']/g),
    ...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g),
  ].map((match) => match[1]);
  for (const dependency of imports) {
    assert.ok(ALLOWED_IMPORTS.has(dependency), `${file}: Gateway runtime must not import ${dependency}`);
  }
  assert.ok(!/\b(?:setTimeout|setInterval)\s*\(|\bAbortSignal\.timeout\s*\(/.test(source),
    `${file}: timer ownership belongs outside Gateway transport`);
  assert.ok(!/\bprocess\.(?:abort|exit|kill)\s*\(/.test(source),
    `${file}: process lifecycle belongs outside Gateway transport`);
}

const server = readFileSync(join(here, "server.ts"), "utf8");
for (const seam of ["notes", "schedules", "query", "docs", "events", "diagnostics"] as const) {
  assert.match(server, new RegExp(`options\\.${seam}\\.`), `route table delegates through injected ${seam} interface`);
}
for (const implementation of ["State", "Scheduler", "loadDocsCatalog", "queryDocs", "createScheduledPromptRunner"]) {
  assert.doesNotMatch(
    server,
    new RegExp(`\\b${implementation}\\b`),
    `Gateway route table must not reach ${implementation} implementation`,
  );
}

process.stdout.write("ok — Gateway transport boundary holds\n");
