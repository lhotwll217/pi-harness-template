import { writeFileSync } from "node:fs";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { HarnessPaths } from "@pi-template/contracts";

/** Make a faux model the harness home's authorized default. */
export function seedFauxProviderHome(paths: HarnessPaths, model: Model<Api>): void {
  writeFileSync(paths.piAuth, JSON.stringify({ [model.provider]: { type: "api_key", key: "faux-key" } }));
  // Pi authorizes only providers it knows, so declare the faux provider like a models.json entry.
  writeFileSync(paths.piModels, JSON.stringify({ providers: {
    [model.provider]: { api: model.api, baseUrl: "http://127.0.0.1:1", apiKey: "faux-key", models: [model] },
  } }));
  writeFileSync(paths.piSettings, JSON.stringify({ defaultProvider: model.provider, defaultModel: model.id }));
}
