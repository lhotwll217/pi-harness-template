// Documentation discovery wire shapes. Markdown remains canonical; these values are
// deterministic projections used by every future transport (docs/docs-interface.md).
export interface DocsCatalogEntry {
  id: string;
  title: string;
  summary: string;
  readWhen: string[];
  path: string;
  contentHash: string;
}

export interface DocsSection {
  id: string;
  heading: string;
  startLine: number;
}

export interface DocsDocument extends DocsCatalogEntry {
  body: string;
  sections: DocsSection[];
}

export type DocsQueryField = "title" | "summary" | "read_when" | "section_heading";

export interface DocsQueryMatch {
  id: string;
  title: string;
  score: number;
  matchedOn: DocsQueryField[];
}

export interface DocsQueryResult {
  matches: DocsQueryMatch[];
  readingPlan: string[];
}

export interface DocsLookupError {
  code: "unknown_docs_id" | "ambiguous_docs_id";
  id: string;
  candidates: string[];
}
