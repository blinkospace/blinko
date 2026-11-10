# Vector service foundation

The plugin contract is versioned independently from the host version. Start with `services.capabilities()` and use only features reported available. The foundation router exposes capability discovery and account-scoped index status; query handlers are advertised only after their complete implementation is mounted.

In capability discovery, `features['vector.status'].available` says the caller is allowed to inspect status. It does not assert index readiness. The `available` field in the status response itself says whether the index is currently usable.

`vector.status` returns nullable embedding-space, generation and corpus-revision identifiers, plus coverage and provenance. An untouched legacy database has `provenance: 'none'` and no invented space or generation. An existing verified generation can have partial account coverage: exact scoring and complete corpus coverage are different properties. Status exposes neither other accounts' counts nor model credentials.

The host-only `VectorRepository` retrieves existing body vectors directly from the same LibSQL file used by host indexing. Reading an indexed note requires no LLM or embedding model, creates no database and performs no implicit maintenance. A complete revision must match the authorized current PostgreSQL snapshot. Internal vectors and body-revision objects are not public DTOs.

The V1 query contract specifies cosine similarity in `[-1,1]`, aggregated by the maximum cosine across every source/target body chunk. Results are distinct notes. Source-note exclusion, explicit excludes and account/scope filters must apply before the final result limit. A missing threshold does not imply zero; negative similarities remain meaningful. The current LibSQL adapter is an exact scan, so explicit approximate retrieval is unsupported rather than silently changed to exact. Large scans need explicit computation/time budgets and truthful truncation metadata.

Text-query embedding is a separate paid operation. It must use the active generation's exact embedding space and the shared account ledger; dimension equality alone is insufficient. New plugin queries reject unverified legacy vectors. The pre-existing host RAG API retains its historical legacy-reading behavior during migration, including attachment compatibility. That compatibility path does not upgrade legacy provenance and is not used by the new plugin repository.

Administrators can maintain service policy through authenticated `pluginServices.admin.getPolicy` and `pluginServices.admin.setPolicy` procedures. `setPolicy` accepts limits, feature enable/disable entries, a model allowlist (`null` means no additional restriction; `[]` means no models) and an independent `dailyTokenBudget`. It requires the superadministrator role and exact service-token permission. A missing row uses defaults; a malformed row or failed policy read closes service capabilities. Current daily accounting uses UTC days; a time-zone policy change must preserve existing `budgetDay` assignments.

A representative administrator request is:

```json
{
  "limits": { "maxResults": 20, "maxOutputTokens": 1024, "maxConcurrentGeneration": 1 },
  "features": { "vector.queryByText": { "enabled": false } },
  "modelAllowlist": [1, 2],
  "dailyTokenBudget": 50000
}
```

The five public limits are actual enforced policy ceilings, not benchmark results. They do not claim a latency target. Current defaults are defined in the shared contract and are always returned by capability discovery after policy resolution. Clients cannot obtain a separate account budget by changing a plugin ID or client tag. Existing unrelated host AI entry points retain their own governance; the new ledger does not claim to cover those older APIs.
