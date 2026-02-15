import { config } from "dotenv";
import type { Config } from "drizzle-kit";
import { resolveDatabaseUrlWithFallback } from "./lib/db/resolve-database-url";

config({ path: ".env.local" });

export default {
  schema: "./lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: resolveDatabaseUrlWithFallback(),
  },
} satisfies Config;
