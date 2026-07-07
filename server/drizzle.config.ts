import "dotenv/config";
import path from "node:path";
import type { Config } from "drizzle-kit";

const dbPath = process.env.DATABASE_PATH ?? path.join(__dirname, "beacon.db");

export default {
  schema: "./src/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: dbPath,
  },
} satisfies Config;
