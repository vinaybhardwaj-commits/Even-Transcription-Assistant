import type { Config } from "drizzle-kit";

export default {
  schema: "./db/schema.ts",
  out: "./db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.APP_DATABASE_URL ?? "",
  },
  verbose: true,
  strict: true,
} satisfies Config;
