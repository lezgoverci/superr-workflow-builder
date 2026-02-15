const RUNTIME_DATABASE_URL_ENV_KEYS = [
  "DATABASE_URL",
  "POSTGRES_URL",
  "POSTGRES_PRISMA_URL",
  "POSTGRES_URL_NON_POOLING",
] as const;

const MIGRATION_DATABASE_URL_ENV_KEYS = [
  "DATABASE_MIGRATION_URL",
  "DIRECT_URL",
  "POSTGRES_URL_NON_POOLING",
  ...RUNTIME_DATABASE_URL_ENV_KEYS,
] as const;

const LOCAL_DATABASE_URL = "postgres://localhost:5432/workflow";

type RuntimeDatabaseUrlKey = (typeof RUNTIME_DATABASE_URL_ENV_KEYS)[number];
type MigrationDatabaseUrlKey = (typeof MIGRATION_DATABASE_URL_ENV_KEYS)[number];

export type ResolvedDatabaseUrlSource = {
  key: RuntimeDatabaseUrlKey | MigrationDatabaseUrlKey;
  value: string;
};

export const databaseUrlEnvKeys = RUNTIME_DATABASE_URL_ENV_KEYS;
export const migrationDatabaseUrlEnvKeys = MIGRATION_DATABASE_URL_ENV_KEYS;

function resolveDatabaseUrlFromKeys<T extends string>(
  envKeys: readonly T[],
  env: NodeJS.ProcessEnv
): { key: T; value: string } | undefined {
  for (const key of envKeys) {
    const value = env[key];
    if (value?.trim()) {
      return {
        key,
        value,
      };
    }
  }
}

export function resolveDatabaseUrl(
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  return resolveDatabaseUrlFromKeys(RUNTIME_DATABASE_URL_ENV_KEYS, env)?.value;
}

export function resolveDatabaseUrlWithFallback(
  env: NodeJS.ProcessEnv = process.env
): string {
  return resolveDatabaseUrl(env) ?? LOCAL_DATABASE_URL;
}

export function resolveMigrationDatabaseUrl(
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  return resolveDatabaseUrlFromKeys(MIGRATION_DATABASE_URL_ENV_KEYS, env)
    ?.value;
}

export function resolveMigrationDatabaseUrlSource(
  env: NodeJS.ProcessEnv = process.env
): ResolvedDatabaseUrlSource | undefined {
  return resolveDatabaseUrlFromKeys(MIGRATION_DATABASE_URL_ENV_KEYS, env);
}

export function resolveMigrationDatabaseUrlWithFallback(
  env: NodeJS.ProcessEnv = process.env
): string {
  return resolveMigrationDatabaseUrl(env) ?? LOCAL_DATABASE_URL;
}
