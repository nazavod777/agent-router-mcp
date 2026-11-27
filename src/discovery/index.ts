/** Public surface of the model auto-discovery service (NEW in Wave 2). Not imported by the MCP run path. */
export * from "./types.js";
export { buildCandidates, mergeDiscoveredModels, normalizeRoute, routeKey } from "./enrich.js";
export type { BuildCandidatesInput, BuildCandidatesOutput, EnrichConfig, ModelRoute } from "./enrich.js";
export { readLocalModels } from "./local-readers.js";
export { buildProbeEnv, defaultExecProbe, probeCliModels } from "./cli-probes.js";
export {
  OFFLINE_HINT_DEADLINE_MS, applyDiscovery, discoverModels, effectiveDiscovery, isCustomHarness, offlineDiscoveryHints, previewDiscovery,
} from "./service.js";
export type { ApplyDiscoveryResult, ApplyDiscoverySelection, DiscoveryConfig, DiscoveryDeps, DiscoveryHints } from "./service.js";
