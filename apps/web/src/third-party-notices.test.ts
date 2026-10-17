import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const app = fileURLToPath(new URL("..", import.meta.url));
const elements = join(app, "src", "components", "ai-elements");
const notices = readFileSync(join(app, "THIRD_PARTY_NOTICES"), "utf8");

describe("THIRD_PARTY_NOTICES", () => {
  it("names every AI Elements file, which states that it was changed (Apache-2.0 §4b), with the license text", () => {
    const files = readdirSync(elements).sort();
    expect(files).toEqual(["message.tsx", "prompt-input.tsx"]);
    for (const file of files) {
      expect(notices).toContain(`src/components/ai-elements/${file}`);
      expect(readFileSync(join(elements, file), "utf8")).toContain(
        "Modified from Vercel AI Elements (Apache-2.0); see apps/web/THIRD_PARTY_NOTICES.",
      );
    }
    expect(notices).toContain("Copyright 2023 Vercel, Inc.");
    expect(notices).toContain("TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION");
  });

  it("carries the MIT notices for the shadcn/ui components and the Create Next App favicon", () => {
    expect(notices).toContain("src/components/ui/");
    expect(notices).toContain("Copyright (c) 2023 shadcn");
    expect(notices).toContain("src/app/favicon.ico");
    expect(notices).toContain("Copyright (c) 2025 Vercel, Inc.");
    expect(notices).toContain("The above copyright notice and this permission notice shall be included in all");
  });
});
