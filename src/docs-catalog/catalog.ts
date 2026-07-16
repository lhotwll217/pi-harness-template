import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join, posix, relative, sep } from "node:path";
import type { DocsDocument, DocsSection } from "@pi-template/contracts";

interface RoutingMetadata {
  title: string;
  summary: string;
  readWhen: string[];
  bodyStartIndex: number;
}

function inlineMetadataValue(value: string, field: string, sourcePath: string): string {
  if (/^[>|]/.test(value) || value === "[]" || value === "{}") {
    throw new Error(`${sourcePath}: ${field} invalid`);
  }
  const first = value[0];
  const last = value.at(-1);
  if (first === '"' || first === "'") {
    if (value.length < 2 || last !== first) throw new Error(`${sourcePath}: ${field} invalid`);
    return value.slice(1, -1);
  }
  if (last === '"' || last === "'") throw new Error(`${sourcePath}: ${field} invalid`);
  return value;
}

function requiredMetadata(source: string, sourcePath: string): RoutingMetadata {
  const lines = source.split(/\r?\n/);
  if (lines[0] !== "---") {
    throw new Error(`${sourcePath}: missing frontmatter`);
  }

  const frontmatterEnd = lines.indexOf("---", 1);
  if (frontmatterEnd === -1) {
    throw new Error(`${sourcePath}: unterminated frontmatter`);
  }

  let title = "";
  let summary = "";
  const readWhen: string[] = [];
  let collectingReadWhen = false;
  let lastScalarField: "title" | "summary" | null = null;

  for (const rawLine of lines.slice(1, frontmatterEnd)) {
    const line = rawLine.trim();
    if (line.startsWith("title:")) {
      title = inlineMetadataValue(line.slice("title:".length).trim(), "title", sourcePath);
      collectingReadWhen = false;
      lastScalarField = "title";
    } else if (line.startsWith("summary:")) {
      summary = inlineMetadataValue(line.slice("summary:".length).trim(), "summary", sourcePath);
      collectingReadWhen = false;
      lastScalarField = "summary";
    } else if (line === "read_when:") {
      collectingReadWhen = true;
      lastScalarField = null;
    } else if (collectingReadWhen && line.startsWith("- ")) {
      const trigger = inlineMetadataValue(line.slice(2).trim(), "read_when entry", sourcePath);
      if (trigger) readWhen.push(trigger);
    } else if (lastScalarField && /^\s+/.test(rawLine) && line) {
      throw new Error(`${sourcePath}: ${lastScalarField} invalid`);
    } else if (line) {
      collectingReadWhen = false;
      lastScalarField = null;
    }
  }

  if (!title) throw new Error(`${sourcePath}: title missing`);
  if (!summary) throw new Error(`${sourcePath}: summary missing`);
  if (readWhen.length === 0) throw new Error(`${sourcePath}: read_when missing or empty`);

  return { title, summary, readWhen, bodyStartIndex: frontmatterEnd + 1 };
}

function headingText(markdown: string): string {
  return markdown
    .replace(/\s+#+\s*$/, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/[`*_~]/g, "")
    .trim();
}

export function githubHeadingSlug(heading: string): string {
  return headingText(heading)
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, (character) =>
      character === "-" || character === "_" ? character : "",
    )
    .replace(/\s+/g, "-");
}

export function markdownSections(source: string, bodyStartIndex?: number): DocsSection[] {
  const sections: DocsSection[] = [];
  const occurrences = new Map<string, number>();
  let fence: { marker: "`" | "~"; length: number } | null = null;
  const lines = source.split(/\r?\n/);
  const startIndex = bodyStartIndex ?? (lines[0] === "---" ? lines.indexOf("---", 1) + 1 : 0);

  function addSection(heading: string, startLine: number): void {
    const baseId = githubHeadingSlug(heading);
    if (!heading || !baseId) return;
    const occurrence = occurrences.get(baseId) ?? 0;
    occurrences.set(baseId, occurrence + 1);
    sections.push({
      id: occurrence === 0 ? baseId : `${baseId}-${occurrence}`,
      heading,
      startLine,
    });
  }

  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index];
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0] as "`" | "~";
      if (fence === null) {
        fence = { marker, length: fenceMatch[1].length };
      } else if (fence.marker === marker && fenceMatch[1].length >= fence.length) {
        fence = null;
      }
      continue;
    }
    if (fence) continue;

    const atxHeading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*$/);
    if (atxHeading) {
      addSection(headingText(atxHeading[1]), index + 1);
      continue;
    }

    if (/^\s{0,3}(?:=+|-+)\s*$/.test(line) && index > startIndex) {
      const setextHeading = headingText(lines[index - 1]);
      if (setextHeading) addSection(setextHeading, index);
    }
  }
  return sections;
}

function markdownFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return markdownFiles(path);
      if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name === "AGENTS.md") return [];
      return [path];
    })
    .sort();
}

export function loadDocsCatalog(repositoryRoot: string): DocsDocument[] {
  const docsDirectory = join(repositoryRoot, "docs");
  const documents = markdownFiles(docsDirectory).map((fullPath) => {
    const sourcePath = posix.join("docs", relative(docsDirectory, fullPath).split(sep).join(posix.sep));
    const source = readFileSync(fullPath, "utf8");
    const metadata = requiredMetadata(source, sourcePath);
    const lines = source.split(/\r?\n/);
    const bodyLines = lines.slice(metadata.bodyStartIndex);
    if (bodyLines[0] === "") bodyLines.shift();

    return {
      id: basename(fullPath, ".md"),
      title: metadata.title,
      summary: metadata.summary,
      readWhen: metadata.readWhen,
      path: sourcePath,
      contentHash: createHash("sha256").update(source).digest("hex"),
      body: bodyLines.join("\n"),
      sections: markdownSections(source, metadata.bodyStartIndex),
    } satisfies DocsDocument;
  });

  const pathsById = new Map<string, string[]>();
  for (const document of documents) {
    const paths = pathsById.get(document.id) ?? [];
    paths.push(document.path);
    pathsById.set(document.id, paths);
  }
  for (const [id, paths] of pathsById) {
    if (paths.length > 1) throw new Error(`duplicate document id "${id}": ${paths.join(", ")}`);
  }

  return documents.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}
