import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import dns from "node:dns";

if (dns.setDefaultResultOrder) {
  dns.setDefaultResultOrder("ipv4first");
}
import postgres from "postgres";
import {
  migrationDatabaseUrlEnvKeys,
  resolveDatabaseUrlSource,
  resolveMigrationDatabaseUrlSource,
} from "../lib/db/resolve-database-url";

const VERCEL_ENV = process.env.VERCEL_ENV;
const SUPABASE_DIRECT_HOST_PATTERN = /^db\.[a-z0-9]+\.supabase\.co$/i;

function getDatabaseHost(databaseUrl: string): string | undefined {
  try {
    return new URL(databaseUrl).hostname;
  } catch {
    return;
  }
}

function isSupabaseDirectHost(host: string | undefined): boolean {
  if (!host) {
    return false;
  }

  return SUPABASE_DIRECT_HOST_PATTERN.test(host);
}

function buildMigrationEnv(databaseUrl: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    DATABASE_MIGRATION_URL: databaseUrl,
    DIRECT_URL: databaseUrl,
  };

  // Force IPv4 ordering to avoid ENETUNREACH on IPv6-only resolved addresses in environments without IPv6 routing
  env.NODE_OPTIONS = `${env.NODE_OPTIONS || ""} --dns-result-order=ipv4first`.trim();

  return env;
}

function runMigrationsWithUrl(databaseUrl: string): SpawnSyncReturns<string> {
  return spawnSync("pnpm", ["db:migrate"], {
    encoding: "utf8",
    env: buildMigrationEnv(databaseUrl),
  });
}

function printMigrationOutput(result: SpawnSyncReturns<string>): void {
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }

  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
}

function containsEnetUnreachError(result: SpawnSyncReturns<string>): boolean {
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return output.includes("ENETUNREACH");
}

function containsMissingSupabaseMigrationsTableError(
  result: SpawnSyncReturns<string>
): boolean {
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return output.includes(
    'relation "supabase_migrations.schema_migrations" does not exist'
  );
}

function assertMigrationSucceeded(result: SpawnSyncReturns<string>): void {
  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(
      `pnpm db:migrate exited with status ${result.status ?? "null"}`
    );
  }
}

async function ensureSupabaseMigrationMetadata(
  databaseUrl: string
): Promise<void> {
  const sql = postgres(databaseUrl, {
    max: 1,
    prepare: false,
  });

  try {
    await sql`CREATE SCHEMA IF NOT EXISTS supabase_migrations`;
    await sql`CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version text NOT NULL PRIMARY KEY)`;
    await sql`ALTER TABLE supabase_migrations.schema_migrations ADD COLUMN IF NOT EXISTS statements text[]`;
    await sql`ALTER TABLE supabase_migrations.schema_migrations ADD COLUMN IF NOT EXISTS name text`;
  } finally {
    await sql.end({
      timeout: 5,
    });
  }
}

async function runMigrationsWithSelfHealing(
  databaseUrl: string,
  sourceLabel: string
): Promise<SpawnSyncReturns<string>> {
  const migrationResult = runMigrationsWithUrl(databaseUrl);
  printMigrationOutput(migrationResult);

  const shouldBootstrapSupabaseMigrationsTable =
    migrationResult.status !== 0 &&
    containsMissingSupabaseMigrationsTableError(migrationResult);

  if (!shouldBootstrapSupabaseMigrationsTable) {
    return migrationResult;
  }

  console.warn(
    `Migration failed because supabase_migrations.schema_migrations is missing (source: ${sourceLabel}). Bootstrapping that metadata table and retrying.`
  );
  await ensureSupabaseMigrationMetadata(databaseUrl);
  const retryResult = runMigrationsWithUrl(databaseUrl);
  printMigrationOutput(retryResult);
  return retryResult;
}

async function main(): Promise<void> {
  if (VERCEL_ENV !== "production") {
    console.log(`Skipping migrations (VERCEL_ENV=${VERCEL_ENV ?? "not set"})`);
    return;
  }

  console.log("Running database migrations for production...");

  const databaseUrlSource = resolveMigrationDatabaseUrlSource();
  const runtimeDatabaseUrlSource = resolveDatabaseUrlSource();
  if (!databaseUrlSource) {
    console.error(
      `Migration failed: no database URL found. Set one of: ${migrationDatabaseUrlEnvKeys.join(", ")}`
    );
    process.exit(1);
  }

  const databaseUrl = databaseUrlSource.value;
  const databaseHost = getDatabaseHost(databaseUrl);
  console.log(
    `Using database URL from ${databaseUrlSource.key}${databaseHost ? ` (host: ${databaseHost})` : ""}`
  );

  if (databaseHost?.includes("pooler.supabase.com")) {
    console.warn(
      "Detected Supabase pooler URL. If migrations fail, set DATABASE_MIGRATION_URL (or DIRECT_URL) to the direct database URL on port 5432."
    );
  }

  try {
    const migrationResult = await runMigrationsWithSelfHealing(
      databaseUrl,
      databaseUrlSource.key
    );

    const shouldRetryWithRuntimeDatabaseUrl =
      migrationResult.status !== 0 &&
      containsEnetUnreachError(migrationResult) &&
      isSupabaseDirectHost(databaseHost) &&
      runtimeDatabaseUrlSource &&
      runtimeDatabaseUrlSource.value !== databaseUrl;

    if (shouldRetryWithRuntimeDatabaseUrl && runtimeDatabaseUrlSource) {
      const runtimeDatabaseHost = getDatabaseHost(
        runtimeDatabaseUrlSource.value
      );
      console.warn(
        `Primary migration URL (${databaseHost ?? databaseUrlSource.key}) is unreachable from Vercel (ENETUNREACH). Retrying with ${runtimeDatabaseUrlSource.key}${runtimeDatabaseHost ? ` (host: ${runtimeDatabaseHost})` : ""}.`
      );
      const retryResult = await runMigrationsWithSelfHealing(
        runtimeDatabaseUrlSource.value,
        runtimeDatabaseUrlSource.key
      );
      assertMigrationSucceeded(retryResult);
    } else {
      assertMigrationSucceeded(migrationResult);
    }

    console.log("Migrations completed successfully");
  } catch (error) {
    console.error("Migration failed:", error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Migration failed:", error);
  process.exit(1);
});
