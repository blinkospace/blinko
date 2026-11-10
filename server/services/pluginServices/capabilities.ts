import type {
  CapabilityState,
  PluginServiceFeature,
  ServicesCapabilities,
  VectorIndexStatus,
} from "../../../shared/lib/pluginServices/v1";
import { PLUGIN_SERVICES_API_VERSION, VECTOR_SNAPSHOT_LIMITS } from "../../../shared/lib/pluginServices/v1";
import type { PolicyStore, ResolvedPolicy } from "./PolicyStore";
import { hasServicePermission } from "./procedure";

export function describeServices(input: {
  hostVersion: string;
  policy: ResolvedPolicy;
  policyStore: PolicyStore;
  permissions: unknown;
  index: VectorIndexStatus;
  vectorQueryReady?: boolean;
  noteSnapshotsReady?: boolean;
  vectorText?: CapabilityState;
  ai?: Partial<Record<"ai.listModels" | "ai.generateText", CapabilityState>>;
}): ServicesCapabilities {
  const features: ServicesCapabilities["features"] = {};
  const paths: Record<PluginServiceFeature, string> = {
    "vector.status": "pluginServices.vector.status",
    "vector.queryByNote": "pluginServices.vector.query",
    "vector.queryByText": "pluginServices.vector.query",
    "vector.exact": "pluginServices.vector.query",
    "vector.approximate": "pluginServices.vector.query",
    "vector.noteLevelAggregation": "pluginServices.vector.query",
    "vector.snapshots": "pluginServices.vector.snapshots.create",
    "ai.listModels": "pluginServices.ai.listModels",
    "ai.generateText": "pluginServices.ai.generateText",
  };
  for (const feature of Object.keys(paths) as PluginServiceFeature[]) {
    const policy = input.policyStore.capability(input.policy, feature);
    const requiredPaths = feature === 'vector.snapshots'
      ? ['create', 'sample', 'readNote', 'release'].map(method => `pluginServices.vector.snapshots.${method}`)
      : feature === 'vector.noteLevelAggregation'
        ? [paths[feature], 'pluginServices.vector.snapshots.create'] : [paths[feature]];
    if (!requiredPaths.every(path => hasServicePermission(input.permissions, path)))
      features[feature] = { available: false, reason: "forbidden" };
    else if (!policy.available) features[feature] = policy;
    // This feature means the caller may query status; it does not mean the
    // index is usable. Index readiness is the status response's `available`.
    else if (feature === "vector.status") features[feature] = { available: true };
    else if (feature === 'vector.noteLevelAggregation' || feature === 'vector.snapshots') {
      const dependency = (['vector.snapshots', 'vector.noteLevelAggregation', 'vector.queryByNote', 'vector.exact'] as const)
        .map(key => input.policyStore.capability(input.policy, key)).find(state => !state.available);
      features[feature] = dependency ?? (input.noteSnapshotsReady ? { available: true } : { available: false, reason: 'index-not-ready' });
    }
    else if (feature === "vector.approximate")
      features[feature] = { available: false, reason: "unsupported" };
    else if (feature.startsWith("vector."))
      features[feature] = !input.vectorQueryReady
        ? { available: false, reason: "unsupported" }
        : !input.index.available
          ? { available: false, reason: "index-not-ready" }
          : feature === "vector.queryByText"
            ? (input.vectorText ?? { available: false, reason: "not-configured" })
            : { available: true };
    else
      features[feature] = input.ai?.[feature as "ai.listModels" | "ai.generateText"] ?? {
        available: false,
        reason: "unsupported",
      };
  }
  return {
    apiVersion: PLUGIN_SERVICES_API_VERSION,
    hostVersion: input.hostVersion,
    features,
    limits: { ...input.policy.limits },
    vectorSnapshotLimits: { ...VECTOR_SNAPSHOT_LIMITS },
  };
}
