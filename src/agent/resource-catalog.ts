import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentToolId } from "@pi-template/contracts";
import type { DatabaseQueryInterface } from "./tools/query-database";
import { createQueryDatabaseTool } from "./tools/query-database";
import type { NoteWriter } from "./tools/save-note";
import { createSaveNoteTool } from "./tools/save-note";

export interface CatalogToolDependencies {
  query: DatabaseQueryInterface;
  notes: NoteWriter;
}

export type AgentResourceCatalogEntry =
  | {
      id: `tool:${AgentToolId}`;
      kind: "tool";
      name: AgentToolId;
      description: string;
      create(dependencies: CatalogToolDependencies): ReturnType<typeof createQueryDatabaseTool> | ReturnType<typeof createSaveNoteTool>;
    }
  | {
      id: `extension:${string}`;
      kind: "extension";
      name: string;
      description: string;
      path(): string;
    }
  | {
      id: `prompt:${string}`;
      kind: "prompt";
      name: string;
      description: string;
      path: string;
    }
  | {
      id: `skill:${string}`;
      kind: "skill";
      name: string;
      description: string;
      path: string;
    };

const permissionPackage = "@gotgenes/pi-permission-system";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const identityPromptPath = join(repositoryRoot, "src", "agent", "prompts", "pi-template.md");

export const piTemplateIdentityPrompt = (): string => readFileSync(identityPromptPath, "utf8");

/** Resolve the package-declared Pi extension instead of relying on ambient package discovery. */
export function permissionSystemExtensionPath(): string {
  let directory = dirname(fileURLToPath(import.meta.resolve(permissionPackage)));
  for (;;) {
    try {
      const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as {
        name?: string;
        pi?: { extensions?: unknown[] };
      };
      if (manifest.name === permissionPackage) {
        const extension = manifest.pi?.extensions?.find((entry): entry is string => typeof entry === "string");
        if (!extension) throw new Error(`${permissionPackage} does not declare a Pi extension`);
        return resolve(directory, extension);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`cannot locate ${permissionPackage} package manifest`);
    directory = parent;
  }
}

/** Ordered source for runtime loading, onboarding review, diagnostics, and exact-set tests. */
export const AGENT_RESOURCE_CATALOG: readonly AgentResourceCatalogEntry[] = Object.freeze([
  {
    id: "prompt:identity",
    kind: "prompt",
    name: "identity",
    description: "Define the Pi Harness Template agent and its bundled capability policy.",
    path: identityPromptPath,
  },
  {
    id: `tool:${AgentToolId.QueryDatabase}`,
    kind: "tool",
    name: AgentToolId.QueryDatabase,
    description: "Read-only progressive disclosure over durable harness state.",
    create: ({ query }: CatalogToolDependencies) => createQueryDatabaseTool(query),
  },
  {
    id: `tool:${AgentToolId.SaveNote}`,
    kind: "tool",
    name: AgentToolId.SaveNote,
    description: "Persist the notes worked example through the State writer.",
    create: ({ notes }: CatalogToolDependencies) => createSaveNoteTool(notes),
  },
  {
    id: "extension:permission-system",
    kind: "extension",
    name: "permission-system",
    description: "Apply the reviewed Pi permission policy to every tool call.",
    path: permissionSystemExtensionPath,
  },
]);

export const catalogIds = (catalog: readonly AgentResourceCatalogEntry[]): string[] =>
  catalog.map(({ id }) => id);

export interface AgentResourceCatalogSummary {
  id: string;
  kind: AgentResourceCatalogEntry["kind"];
  name: string;
  description: string;
}

export const resourceCatalogSummary = (): AgentResourceCatalogSummary[] =>
  AGENT_RESOURCE_CATALOG.map(({ id, kind, name, description }) => ({ id, kind, name, description }));
