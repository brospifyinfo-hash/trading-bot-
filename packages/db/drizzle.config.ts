import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/schema/index.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL ?? "postgres://localhost:5432/sae" },
  // Vorwaerts-only: Migrationen werden nie rueckwaerts gefahren. Ein Rollback in
  // einer Datenbank, die Handelshistorie fuehrt, verliert Forschungsdaten.
  strict: true,
});
