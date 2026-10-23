/**
 * Models.dev data shape (subset used by the wizard). The real API is much
 * larger — we only type the fields we read. `status`, `release_date`, and
 * `tool_call` are optional on the wire and checked at runtime.
 */
export type ModelsDevEntry = {
  id: string;
  release_date?: string;
  tool_call?: boolean;
  status?: string;
  modalities?: { input?: string[]; output?: string[] };
};

export type ModelsDevProvider = {
  id: string;
  models: Record<string, ModelsDevEntry>;
};

export type ModelsDevData = Record<string, ModelsDevProvider>;

export type ModelEntry = {
  id: string;
  releaseDate: string;
  recommended: boolean;
};

/** Filter + sort rules per spec §Model filter / §Recommendation. */
export function filterAndSortModels(data: ModelsDevData, providerId: string): ModelEntry[] {
  const provider = data[providerId];
  if (!provider) return [];
  const entries = Object.values(provider.models ?? {});
  const filtered = entries.filter((m) => {
    if (m.tool_call !== true) return false;
    if (m.status === "deprecated") return false;
    const inputs = m.modalities?.input ?? [];
    const outputs = m.modalities?.output ?? [];
    if (!inputs.includes("text")) return false;
    if (!outputs.includes("text")) return false;
    return true;
  });
  filtered.sort((a, b) => (b.release_date ?? "").localeCompare(a.release_date ?? ""));
  return filtered.map((m) => ({
    id: m.id,
    releaseDate: m.release_date ?? "",
    recommended: false,
  }));
}

export function applyRecommendation(models: ModelEntry[], regex: RegExp | undefined): ModelEntry[] {
  if (!regex || models.length === 0) return models;
  // Input is release_date descending, so the first match is the newest.
  const pickIndex = models.findIndex((m) => regex.test(m.id));
  const pick = models[pickIndex];
  if (!pick) return models;
  return [
    { ...pick, recommended: true },
    ...models.slice(0, pickIndex),
    ...models.slice(pickIndex + 1),
  ];
}
