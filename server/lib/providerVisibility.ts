// Keep model selection available without exposing instance-wide credentials.
export function visibleProvider<
  T extends {
    apiKey?: unknown;
    baseURL?: unknown;
    config?: unknown;
    models?: any[];
  },
>(provider: T, admin: boolean): T {
  return admin
    ? provider
    : {
        ...provider,
        apiKey: null,
        baseURL: null,
        config: null,
        ...(provider.models
          ? {
              models: provider.models.map((model) =>
                visibleModel(model, false),
              ),
            }
          : {}),
      };
}

export function visibleModel<T extends { config?: unknown; provider?: any }>(
  model: T,
  admin: boolean,
): T {
  if (admin) return model;
  return {
    ...model,
    config: null,
    ...(model.provider
      ? { provider: visibleProvider(model.provider, false) }
      : {}),
  };
}
