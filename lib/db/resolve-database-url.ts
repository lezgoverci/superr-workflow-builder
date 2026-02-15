const DATABASE_URL_ENV_KEYS = [
  "DATABASE_URL",
  "POSTGRES_URL",
  "POSTGRES_PRISMA_URL",
  "POSTGRES_URL_NON_POOLING",
] as const;

const LOCAL_DATABASE_URL = "postgres://localhost:5432/workflow";

export const databaseUrlEnvKeys = DATABASE_URL_ENV_KEYS;

export function resolveDatabaseUrl(
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  for (const key of DATABASE_URL_ENV_KEYS) {
    const value = env[key];
    if (value?.trim()) {
      return value;
    }
  }

  return;
}

export function resolveDatabaseUrlWithFallback(
  env: NodeJS.ProcessEnv = process.env
): string {
  return resolveDatabaseUrl(env) ?? LOCAL_DATABASE_URL;
}
