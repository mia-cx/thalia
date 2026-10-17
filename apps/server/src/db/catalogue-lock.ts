import { sql } from "drizzle-orm";
import type { Database } from "./client.ts";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
const catalogueLockKey = 7_468_616;

/** Serialize identity, tree and pruning writes before taking Library or Item row locks. Never hold over network or encode work. */
export async function lockCatalogue(tx: Transaction) {
  await tx.execute(sql`select pg_advisory_xact_lock(${catalogueLockKey})`);
}
