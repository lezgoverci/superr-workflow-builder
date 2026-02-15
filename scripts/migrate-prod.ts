import { spawnSync } from "node:child_process";
import {
  migrationDatabaseUrlEnvKeys,
  resolveMigrationDatabaseUrlSource,
} from "../lib/db/resolve-database-url";

const VERCEL_ENV = process.env.VERCEL_ENV;

function getDatabaseHost(databaseUrl: string): string | undefined {
  try {
    return new URL(databaseUrl).hostname;
  } catch {
    return;
  }
}

if (VERCEL_ENV === "production") {
  console.log("Running database migrations for production...");

  const databaseUrlSource = resolveMigrationDatabaseUrlSource();
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
    const migrationResult = spawnSync("pnpm", ["db:migrate"], {
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
      },
    });

    if (migrationResult.stdout) {
      process.stdout.write(migrationResult.stdout);
    }

    if (migrationResult.stderr) {
      process.stderr.write(migrationResult.stderr);
    }

    if (migrationResult.error) {
      throw migrationResult.error;
    }

    if (migrationResult.status !== 0) {
      throw new Error(
        `pnpm db:migrate exited with status ${migrationResult.status}`
      );
    }

    console.log("Migrations completed successfully");
  } catch (error) {
    console.error("Migration failed:", error);
    process.exit(1);
  }
} else {
  console.log(`Skipping migrations (VERCEL_ENV=${VERCEL_ENV ?? "not set"})`);
}
