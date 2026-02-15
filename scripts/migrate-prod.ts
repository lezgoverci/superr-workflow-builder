import { spawnSync } from "node:child_process";
import {
  databaseUrlEnvKeys,
  resolveDatabaseUrl,
} from "../lib/db/resolve-database-url";

const VERCEL_ENV = process.env.VERCEL_ENV;

if (VERCEL_ENV === "production") {
  console.log("Running database migrations for production...");

  const databaseUrl = resolveDatabaseUrl();
  if (!databaseUrl) {
    console.error(
      `Migration failed: no database URL found. Set one of: ${databaseUrlEnvKeys.join(", ")}`
    );
    process.exit(1);
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
