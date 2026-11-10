import { createClient } from "@libsql/client";
import { closeSync, fsyncSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import path from "node:path";
import { VECTOR_DB_FILE_PATH } from "../../shared/lib/sharedConstant";
import {
  hostIndex,
  hostModelResolver,
  hostNoteSource,
  markHostNoteIndexed,
} from "../services/pluginServices/HostIndex";
import { IndexLifecycle } from "../services/pluginServices/IndexLifecycle";
import { decodeGeneration } from "../services/pluginServices/VectorRepository";
import { rollbackIndexMetadata, INDEX_SCHEMA_VERSION } from "../services/pluginServices/indexMigrations";
import { NoteQualificationRegistry } from '../services/pluginServices/NoteQualification';

import { applyWeightedPreparation, planWeightedPreparation } from "../services/pluginServices/WeightedIndexPreparation";
import { ServiceError } from "../services/pluginServices/errors";

// Local host-operator tool. Run with the application's database environment and
// the same server working directory. Only explicitly confirmed prepare-weighted
// execution may call the configured embedding provider; preview never does.
const [command, ...args] = process.argv.slice(2);
const allowed = [
  "status",
  "migrate",
  "recover",
  "activate",
  "rollback-metadata",
  "attest-legacy",
  "prepare-weighted",
  "initialize-qualification",
  "maintain-qualification",
  "certify-existing",
];
if (!command || !allowed.includes(command)) {
  console.error(
    "Usage: bun scripts/plugin-services-index.ts status|migrate|recover|activate|rollback-metadata|attest-legacy|prepare-weighted|initialize-qualification|maintain-qualification|certify-existing [options]",
  );
  process.exit(1);
}
function option(name: string): string {
  const position = args.indexOf("--" + name);
  const value = position < 0 ? undefined : args[position + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing --${name}`);
  return value;
}
function integer(name: string): number {
  const value = Number(option(name));
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`Invalid --${name}`);
  return value;
}
let client: ReturnType<typeof createClient> | undefined;
try {
  if (command === 'initialize-qualification' || command === 'maintain-qualification') {
    if (args.length) throw new ServiceError('INVALID_INPUT');
    const { prisma } = await import('../prisma');
    const registry = new NoteQualificationRegistry(prisma);
    const result = command === 'initialize-qualification' ? await registry.initialize() : await registry.maintain();
    console.log(JSON.stringify({ ...result, providerCalls: 0 }));
    if (!result.ready) process.exitCode = 2;
  } else if (command === "prepare-weighted") {
    // Reject misspellings and repeated flags rather than silently dropping a budget.
    const seen = new Set<string>();
    const valued = new Set(["--account", "--notes", "--max-requests", "--max-input-chars", "--confirm-plan", "--journal"]);
    for (let i = 0; i < args.length; i++) {
      const flag = args[i];
      if (seen.has(flag) || (!valued.has(flag) && flag !== "--allow-provider-calls"))
        throw new ServiceError("INVALID_INPUT");
      seen.add(flag);
      if (valued.has(flag) && (!args[++i] || args[i].startsWith("--"))) throw new ServiceError("INVALID_INPUT");
    }
    const execute = seen.has("--confirm-plan") || seen.has("--journal") || seen.has("--allow-provider-calls");
    if (execute && !["--confirm-plan", "--journal", "--allow-provider-calls"].every(flag => seen.has(flag)))
      throw new ServiceError("FORBIDDEN");
    if (!process.env.DATABASE_URL) throw new ServiceError("INVALID_INPUT");
    const deps = {
      url: VECTOR_DB_FILE_PATH,
      sourceIdentity: process.env.DATABASE_URL,
      readNote: hostNoteSource.readNote,
      readInstance: hostNoteSource.readInstance,
      resolveEmbedding: () => hostModelResolver.resolveEmbedding(),
      markIndexed: markHostNoteIndexed,
    };
    const plan = await planWeightedPreparation(deps, {
      accountId: integer("account"), noteIds: JSON.parse(option("notes")),
      maxRequests: Number(option("max-requests")), maxInputChars: Number(option("max-input-chars")),
    });
    if (!execute) console.log(JSON.stringify({ preview: true, providerCalls: 0, plan }));
    else {
      // Exclusive creation refuses an existing run, including a crashed/unknown one.
      // Keep the journal even on failure. No raw inputs, URLs or provider errors enter it.
      if (option("confirm-plan") !== plan.planId) throw new ServiceError("INDEX_CHANGED");
      const journal = openSync(path.resolve(option("journal")), "wx", 0o600);
      try {
        const result = await applyWeightedPreparation(deps, plan, {
          confirmPlan: option("confirm-plan"), allowProviderCalls: true,
          journal(event) {
            writeFileSync(journal, JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n");
            fsyncSync(journal);
          },
        });
        console.log(JSON.stringify(result));
        if (result.status !== "complete") process.exitCode = 2;
      } finally { closeSync(journal); }
    }
  } else if (command === "status") {
    const accountId = integer("account");
    console.log(
      JSON.stringify(
        await hostIndex.withReader(async (repository) =>
          repository
            ? repository.readStatus(accountId)
            : { available: false, reason: "index-not-ready" },
        ),
      ),
    );
  } else {
    mkdirSync(path.dirname(VECTOR_DB_FILE_PATH.slice(5)), { recursive: true });
    client = createClient({ url: VECTOR_DB_FILE_PATH });
    const lifecycle = new IndexLifecycle(client, hostNoteSource);
    if (command === "rollback-metadata") {
      await rollbackIndexMetadata(client);
      console.log(JSON.stringify({ rolledBack: true, vectorsRetained: true }));
    } else {
      await lifecycle.initialize();
      if (command === "migrate")
        console.log(
          JSON.stringify({
            schemaVersion: INDEX_SCHEMA_VERSION,
            legacyOwnershipRows: await lifecycle.inventoryLegacy(),
            legacyProvenance: "unverified",
          }),
        );
      else if (command === 'certify-existing') {
        if (args.length !== 4 || !args.includes('--account') || !args.includes('--notes')) throw new ServiceError('INVALID_INPUT');
        const accountId = integer('account'), ids: unknown = JSON.parse(option('notes'));
        if (!Array.isArray(ids) || !ids.length || ids.length > 128 || !ids.every(id => Number.isSafeInteger(id) && id > 0) || new Set(ids).size !== ids.length) throw new ServiceError('INVALID_INPUT');
        const { prisma } = await import('../prisma');
        const registry = new NoteQualificationRegistry(prisma);
        await registry.ensureReady(accountId);
        const { VectorRepository } = await import('../services/pluginServices/VectorRepository');
        const generation = await new VectorRepository(client).readActiveGeneration();
        if (!generation) throw new ServiceError('INDEX_NOT_READY');
        const published: number[] = [];
        for (const id of ids) {
          const note = await hostNoteSource.readNote(id);
          if (!note || note.accountId !== accountId || note.isRecycle) throw new ServiceError('NOT_FOUND_OR_FORBIDDEN');
          if (!await lifecycle.certifyExisting(note, generation)) throw new ServiceError('SOURCE_INDEX_STALE');
          published.push(id);
        }
        console.log(JSON.stringify({ published, providerCalls: 0 }));
      }
      else if (command === "recover")
        console.log(JSON.stringify(await lifecycle.recover()));
      else if (command === "activate") {
        await lifecycle.activateGeneration(option("generation"));
        console.log(JSON.stringify({ activated: true }));
      } else if (command === "attest-legacy") {
        if (!args.includes("--confirm-model"))
          throw new Error(
            "Explicit --confirm-model is required for historical provenance.",
          );
        const note = await hostNoteSource.readNote(integer("note"));
        if (!note || note.accountId !== integer("account"))
          throw new Error("Note not found for the account.");
        const rows = await client.execute({
          sql: "SELECT * FROM blinko_ps_generations WHERE generation=?",
          args: [option("generation")],
        });
        if (!rows.rows.length) throw new Error("Unknown generation.");
        const vectorIds: unknown = JSON.parse(option("vector-ids"));
        if (
          !Array.isArray(vectorIds) ||
          !vectorIds.every((value) => typeof value === "string")
        )
          throw new Error(
            "Expected an ordered JSON list of legacy vector IDs.",
          );
        const published = await lifecycle.attestLegacy({
          note,
          generation: decodeGeneration(rows.rows[0]),
          vectorIds,
          administratorId: integer("administrator"),
          confirmed: true,
          evidence: option("evidence"),
        });
        console.log(
          JSON.stringify({ published, provenance: "legacy-attested" }),
        );
      }
    }
  }
} catch (error) {
  if (command !== "prepare-weighted") throw error;
  console.error(JSON.stringify({ status: "rejected", error: error instanceof ServiceError ? error.code :
    (error as NodeJS.ErrnoException)?.code === "EEXIST" ? "JOURNAL_ALREADY_EXISTS" : "PREPARATION_REJECTED" }));
  process.exitCode = 1;
} finally {
  client?.close();
  const { prisma } = await import("../prisma");
  await prisma.$disconnect();
}
