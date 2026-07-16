// Lists every durable docs page with its routing frontmatter and fails if any page is
// missing title, summary, or read_when. AGENTS.md files are rules, not pages.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOCS_DIR = join(REPOSITORY_ROOT, "docs");

function inlineMetadataValue(value) {
  if (/^[>|]/.test(value) || value === "[]" || value === "{}") return null;
  const first = value[0];
  const last = value.at(-1);
  if (first === '"' || first === "'") {
    return value.length >= 2 && last === first ? value.slice(1, -1) : null;
  }
  return last === '"' || last === "'" ? null : value;
}

function extractMetadata(fullPath) {
  const content = readFileSync(fullPath, "utf8");
  const lines = content.split(/\r?\n/);
  if (lines[0] !== "---") return { error: "missing frontmatter" };
  const end = lines.indexOf("---", 1);
  if (end === -1) return { error: "unterminated frontmatter" };

  let title = "";
  let summary = "";
  const readWhen = [];
  let collectingReadWhen = false;
  let lastScalarField = null;
  for (const rawLine of lines.slice(1, end)) {
    const line = rawLine.trim();
    if (line.startsWith("title:")) {
      title = inlineMetadataValue(line.slice("title:".length).trim());
      if (title === null) return { error: "title invalid" };
      collectingReadWhen = false;
      lastScalarField = "title";
    } else if (line.startsWith("summary:")) {
      summary = inlineMetadataValue(line.slice("summary:".length).trim());
      if (summary === null) return { error: "summary invalid" };
      collectingReadWhen = false;
      lastScalarField = "summary";
    } else if (line === "read_when:") {
      collectingReadWhen = true;
      lastScalarField = null;
    } else if (collectingReadWhen && line.startsWith("- ")) {
      const trigger = inlineMetadataValue(line.slice(2).trim());
      if (trigger === null) return { error: "read_when entry invalid" };
      if (trigger) readWhen.push(trigger);
    } else if (lastScalarField && /^\s+/.test(rawLine) && line) {
      return { error: `${lastScalarField} invalid` };
    } else if (line) {
      collectingReadWhen = false;
      lastScalarField = null;
    }
  }
  if (!title) return { error: "title missing" };
  if (!summary) return { error: "summary missing" };
  if (readWhen.length === 0) return { error: "read_when missing or empty" };
  return { title, summary, readWhen };
}

function markdownFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return markdownFiles(path);
      if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name === "AGENTS.md") return [];
      return [path];
    })
    .sort();
}

let failed = false;
for (const fullPath of markdownFiles(DOCS_DIR)) {
  const pagePath = posix.join("docs", relative(DOCS_DIR, fullPath).split(sep).join(posix.sep));
  const { title, summary, readWhen, error } = extractMetadata(fullPath);
  if (error) {
    console.error(`${pagePath} - INVALID: ${error}`);
    failed = true;
    continue;
  }
  console.log(`${pagePath} - ${title}`);
  console.log(`  Summary: ${summary}`);
  console.log(`  Read when: ${readWhen.join("; ")}`);
}

process.exitCode = failed ? 1 : 0;
