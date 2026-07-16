// Unit: real documentation tree metadata, identifiers, and relative link integrity.
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDocsCatalog, markdownSections } from "./catalog";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

function displayPath(path: string): string {
  return relative(repositoryRoot, path).split(sep).join("/");
}

function markdownWithoutCode(markdown: string): string {
  let fence: { marker: "`" | "~"; length: number } | null = null;
  return markdown
    .split(/\r?\n/)
    .map((line) => {
      const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
      if (fenceMatch) {
        const marker = fenceMatch[1][0] as "`" | "~";
        if (fence === null) {
          fence = { marker, length: fenceMatch[1].length };
        } else if (fence.marker === marker && fenceMatch[1].length >= fence.length) {
          fence = null;
        }
        return "";
      }
      if (fence) return "";

      let visible = "";
      for (let index = 0; index < line.length;) {
        if (line[index] !== "`") {
          visible += line[index];
          index += 1;
          continue;
        }
        let delimiterEnd = index;
        while (line[delimiterEnd] === "`") delimiterEnd += 1;
        const delimiter = line.slice(index, delimiterEnd);
        const closing = line.indexOf(delimiter, delimiterEnd);
        if (closing === -1) {
          visible += delimiter;
          index = delimiterEnd;
        } else {
          index = closing + delimiter.length;
        }
      }
      return visible;
    })
    .join("\n");
}

function linkDestination(rawDestination: string): string {
  const destination = rawDestination.trim();
  if (destination.startsWith("<")) {
    const closingBracket = destination.indexOf(">");
    return closingBracket === -1 ? destination : destination.slice(1, closingBracket);
  }

  let depth = 0;
  let end = destination.length;
  for (let index = 0; index < destination.length; index += 1) {
    const character = destination[index];
    if (character === "\\") {
      index += 1;
    } else if (character === "(") {
      depth += 1;
    } else if (character === ")" && depth > 0) {
      depth -= 1;
    } else if (/\s/.test(character) && depth === 0) {
      end = index;
      break;
    }
  }
  return destination.slice(0, end).replace(/\\([\s()])/g, "$1");
}

function markdownLinkTargets(markdown: string): { targets: string[]; missingReferences: string[] } {
  const visibleMarkdown = markdownWithoutCode(markdown);
  const referenceTargets = new Map<string, string>();
  for (const line of visibleMarkdown.split("\n")) {
    const definition = line.match(/^\s{0,3}\[([^\]]+)\]:\s*(.+)$/);
    if (!definition) continue;
    referenceTargets.set(definition[1].trim().toLowerCase(), linkDestination(definition[2]));
  }

  const targets = [...referenceTargets.values()];
  const missingReferences: string[] = [];
  for (const reference of visibleMarkdown.matchAll(/\[([^\]]+)\]\[([^\]]*)\]/g)) {
    const label = (reference[2] || reference[1]).trim().toLowerCase();
    if (!referenceTargets.has(label)) missingReferences.push(label);
  }

  for (let index = 0; index < visibleMarkdown.length; index += 1) {
    if (visibleMarkdown[index] !== "]" || visibleMarkdown[index + 1] !== "(") continue;
    const destinationStart = index + 2;
    let depth = 1;
    let destinationEnd = destinationStart;
    for (; destinationEnd < visibleMarkdown.length; destinationEnd += 1) {
      const character = visibleMarkdown[destinationEnd];
      if (character === "\\") {
        destinationEnd += 1;
      } else if (character === "(") {
        depth += 1;
      } else if (character === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    if (depth === 0) {
      targets.push(linkDestination(visibleMarkdown.slice(destinationStart, destinationEnd)));
      index = destinationEnd;
    }
  }
  return { targets, missingReferences };
}

assert.deepEqual(
  markdownLinkTargets([
    "[reference][guide]",
    "[guide]: guides/state.md#where-records-live",
    "[balanced](guides/guide_(draft).md)",
    "`[ignored](missing-inline.md)`",
    "```markdown",
    "[ignored](missing-fenced.md)",
    "```",
  ].join("\n")),
  {
    targets: ["guides/state.md#where-records-live", "guides/guide_(draft).md"],
    missingReferences: [],
  },
);
assert.deepEqual(markdownLinkTargets("[missing][unknown]").missingReferences, ["unknown"]);

const documents = loadDocsCatalog(repositoryRoot);
const ids = documents.map(({ id }) => id);
assert.equal(new Set(ids).size, ids.length, "documentation IDs must be unique");

const documentsByPath = new Map(
  documents.map((document) => [normalize(join(repositoryRoot, document.path)), document]),
);

for (const sourceDocument of documents) {
  const sourcePath = join(repositoryRoot, sourceDocument.path);
  const links = markdownLinkTargets(sourceDocument.body);
  assert.deepEqual(
    links.missingReferences,
    [],
    `${displayPath(sourcePath)} contains undefined reference links`,
  );
  for (const target of links.targets) {
    if (/^[a-z][a-z+.-]*:/i.test(target) || target.startsWith("//") || target.startsWith("/")) {
      continue;
    }

    const [encodedPath, encodedAnchor] = target.split("#", 2);
    const targetPath = encodedPath
      ? resolve(dirname(sourcePath), decodeURIComponent(encodedPath))
      : sourcePath;
    assert.ok(existsSync(targetPath), `${displayPath(sourcePath)} links to missing ${target}`);
    assert.ok(statSync(targetPath).isFile(), `${displayPath(sourcePath)} link is not a file: ${target}`);

    if (encodedAnchor === undefined) continue;
    const targetDocument = documentsByPath.get(normalize(targetPath));
    const anchor = decodeURIComponent(encodedAnchor).toLowerCase();
    const targetSections = targetDocument?.sections ?? markdownSections(readFileSync(targetPath, "utf8"));
    assert.ok(
      targetSections.some(({ id }) => id === anchor),
      `${displayPath(sourcePath)} links to missing heading ${target}`,
    );
  }
}

console.log("docs-drift.test.ts ok");
