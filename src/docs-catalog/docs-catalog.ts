import type {
  DocsCatalogEntry,
  DocsDocument,
  DocsLookupError,
  DocsQueryResult,
} from "@pi-template/contracts";
import { loadDocsCatalog } from "./catalog";
import { queryDocs } from "./query";

export interface DocsCatalog {
  list(): DocsCatalogEntry[];
  read(id: string): DocsDocument | DocsLookupError;
  query(question: string): DocsQueryResult;
}

function entry(document: DocsDocument): DocsCatalogEntry {
  const { body: _body, sections: _sections, ...metadata } = document;
  return metadata;
}

export function createDocsCatalog(repositoryRoot: string): DocsCatalog {
  const documents = loadDocsCatalog(repositoryRoot);
  return {
    list: () => documents.map(entry),
    read(requestedId) {
      const id = requestedId.split("#", 1)[0];
      const exact = documents.find((document) => document.id === id);
      if (exact) return exact;
      const candidates = documents.filter((document) => document.id.startsWith(id));
      if (candidates.length === 1) return candidates[0];
      return {
        code: candidates.length === 0 ? "unknown_docs_id" : "ambiguous_docs_id",
        id: requestedId,
        candidates: candidates.map((document) => document.id),
      };
    },
    query: (question) => queryDocs(documents, question),
  };
}
