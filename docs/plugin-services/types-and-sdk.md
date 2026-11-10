# Plugin types and the mounted SDK

The `blinko` package remains a **declarations-only** package. Import its types with
`import type`; obtain the running SDK from `window.Blinko.services`. This change
does not publish a new package version automatically.

```ts
import type { BasePlugin, PluginServicesSdk } from 'blinko';

export class Example implements BasePlugin {
  init(): void {
    const services: PluginServicesSdk = window.Blinko.services;
    void services.capabilities().then(capabilities => {
      if (capabilities.features['vector.status']?.available) {
        return services.vector.status();
      }
    });
  }
  destroy(): void {}
}
```

For scripts or type consumers without DOM globals, use the separate entry:

```ts
import type { PluginServicesSdk, VectorQueryResult } from 'blinko/services';
```

The main entry keeps the complete existing `window.Blinko.api`, stores, hooks,
`BasePlugin`, and `I18nString`. It adds `services` alongside the existing fields.
`init()` and `destroy()` retain their existing signatures and call order. The
transport reads the current tRPC client for every call, including after a session
change. A missing server procedure is detected from the actual tRPC failure;
accessing a property on its dynamic Proxy does not prove the procedure exists.

The mounted SDK surface is `capabilities`, `vector.status`, `vector.query`,
`vector.snapshots`, `ai.listModels` and `ai.generateText`. Browser hosts can also
provide optional local `context` and `files` capabilities; see
[browser host context and file URLs](./host-context.md). Administrator policy
procedures remain on the authenticated host API. A feature entry describes
permission to call it; for `vector.status`, readiness of the index is the status
response's own `available` field, not the capability entry. See
[AI generation](./ai-generation.md) for generation limits and failure codes.

## Building and checking the package

From the repository root after the normal frozen dependency install and Prisma
client generation:

```sh
bun run build:blinko:types
```

This command performs the following checks and stops on any failure:

1. Typecheck the public entry, SDK implementation, public contracts, browser
   context bindings, endpoint/fetch helpers, tRPC client type boundary and root
   router type boundary. TypeScript's `noCheck` is false.
2. Infer declarations from the real host types, emitting only files reached by
   the resulting public declarations. This avoids emitting unrelated AI tool
   implementations. It does not replace the legacy API with a handwritten subset.
3. Use the existing server `tsup` dependency to bundle the reachable declarations
   into `dist/index.d.mts` and `dist/services.d.mts`. Local aliases become relative
   imports. Retained Prisma JSON/Decimal types reference the stable runtime type
   module, so a plugin consumer does not need the host database schema or a
   generated Prisma client.
4. Create a real local `npm pack` archive and extract it as an installed package.
   Check every packed declaration with strict checking, `noCheck: false`,
   `skipLibCheck: false`, and no repository paths or base URL. Third-party
   declarations are treated as dependencies, not as this package's source.
5. Compile a legacy plugin consumer, a separate consumer with no DOM/Node
   globals, and the actual independent similar-content example. Negative
   assertions reject invalid routes, wrong argument types, public credential
   access/injection and missing lifecycle methods, catching accidental replacement
   by `any`.

The consumer fixture uses only the packed package plus its explicitly declared
local dependency versions. It does not fetch packages, run installation scripts,
call models, or access a database. The fixture uses the ordinary consumer
`skipLibCheck` setting for upstream third-party declaration incompatibilities;
the package's own declarations are checked separately without that setting.
This is a public declaration build and consumer check, not a full application
source typecheck. No full application typecheck is claimed.

`bun run test:blinko:types` reruns the packing and consumer checks against existing
build outputs. Temporary emission/consumer directories under `blinko-types` are
ignored by Git and excluded from the package's explicit files list.

The service test runner additionally covers actual `PluginManagerStore` mounting
and old lifecycle calls with isolated UI infrastructure. A separate real
PostgreSQL test uses the root router, `httpBatchLink`, `fetchRequestHandler` and
real Request/Response serialization; only the HTTP transport is kept in memory.
Neither test is a browser UI or production deployment test.
