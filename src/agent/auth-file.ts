import { existsSync, readFileSync } from "node:fs";

/**
 * Read a Pi auth.json the way Pi's AuthStorage does (BOM stripped, JSON parsed). A file Pi
 * could not load fails closed here too, so no caller treats damaged credentials as absent.
 */
export function readAuthFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, ""));
  } catch (error) {
    throw new Error(`${path} could not be parsed; fix or remove it: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must hold a JSON object of provider credentials; fix or remove it`);
  }
  return value as Record<string, unknown>;
}
