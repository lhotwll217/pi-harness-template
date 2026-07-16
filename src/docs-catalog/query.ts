import type {
  DocsDocument,
  DocsQueryField,
  DocsQueryMatch,
  DocsQueryResult,
} from "@pi-template/contracts";

export const DOCS_QUERY_FIELD_WEIGHTS: Readonly<Record<DocsQueryField, number>> = {
  title: 8,
  summary: 4,
  read_when: 2,
  section_heading: 1,
};

const FIELD_ORDER = Object.keys(DOCS_QUERY_FIELD_WEIGHTS) as DocsQueryField[];
const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "do",
  "does",
  "for",
  "how",
  "i",
  "in",
  "is",
  "it",
  "of",
  "on",
  "should",
  "the",
  "to",
  "up",
  "what",
  "when",
  "where",
  "which",
  "with",
]);

function terms(value: string): string[] {
  return [...new Set((value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(
    (term) => !STOP_WORDS.has(term),
  ))];
}

function sameWordFamily(left: string, right: string): boolean {
  if (left === right) return true;
  const shorterLength = Math.min(left.length, right.length);
  if (shorterLength < 5) return false;

  let commonPrefixLength = 0;
  while (
    commonPrefixLength < shorterLength &&
    left[commonPrefixLength] === right[commonPrefixLength]
  ) {
    commonPrefixLength += 1;
  }

  return (
    commonPrefixLength >= 5 &&
    (left.startsWith(right) || right.startsWith(left) || commonPrefixLength >= shorterLength - 1)
  );
}

function hitCount(questionTerms: string[], fieldValue: string): number {
  const fieldTerms = terms(fieldValue);
  return questionTerms.filter((questionTerm) =>
    fieldTerms.some((fieldTerm) => sameWordFamily(questionTerm, fieldTerm)),
  ).length;
}

function scoreDocument(document: DocsDocument, questionTerms: string[]): DocsQueryMatch | null {
  const values: Record<DocsQueryField, string> = {
    title: document.title,
    summary: document.summary,
    read_when: document.readWhen.join(" "),
    section_heading: document.sections.map(({ heading }) => heading).join(" "),
  };
  const matchedOn: DocsQueryField[] = [];
  let score = 0;

  for (const field of FIELD_ORDER) {
    const hits = hitCount(questionTerms, values[field]);
    if (hits === 0) continue;
    matchedOn.push(field);
    score += hits * DOCS_QUERY_FIELD_WEIGHTS[field];
  }

  return score === 0 ? null : { id: document.id, title: document.title, score, matchedOn };
}

export function queryDocs(
  documents: readonly DocsDocument[],
  question: string,
): DocsQueryResult {
  const questionTerms = terms(question);
  if (questionTerms.length === 0) return { matches: [], readingPlan: [] };

  const matches = documents
    .map((document) => scoreDocument(document, questionTerms))
    .filter((match): match is DocsQueryMatch => match !== null)
    .sort((left, right) => {
      if (left.score !== right.score) return right.score - left.score;
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    });

  return {
    matches,
    readingPlan: matches.slice(0, 5).map(({ id }) => id),
  };
}
