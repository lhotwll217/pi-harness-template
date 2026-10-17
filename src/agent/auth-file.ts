import { existsSync, readFileSync } from "node:fs";

export function readAuthFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error(`${path} could not be parsed; fix or remove it: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must hold a JSON object of provider credentials; fix or remove it`);
  }
  return value as Record<string, unknown>;
}
