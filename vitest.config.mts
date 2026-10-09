import path from "node:path";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

// Pruebas de integración contra una PostgreSQL REAL (las reglas críticas
// —aislamiento entre negocios, stock atómico, consecutivos, rollback— viven en
// la base y no se pueden probar con mocks).
//
// Base de pruebas:
//   - DATABASE_URL_TEST si está definida (CI la define);
//   - si no, la misma DATABASE_URL del .env con "_test" añadido al nombre
//     (localhost:5432/solobackend -> localhost:5432/solobackend_test).
// tests/global-setup.ts se niega a correr si el nombre no termina en "_test":
// las pruebas TRUNCAN tablas y nunca deben tocar la base de desarrollo.
const env = loadEnv("test", process.cwd(), "");

function urlDePruebas(): string {
  if (env.DATABASE_URL_TEST) return env.DATABASE_URL_TEST;
  if (!env.DATABASE_URL) {
    throw new Error("Define DATABASE_URL_TEST o DATABASE_URL para correr las pruebas");
  }
  const url = new URL(env.DATABASE_URL);
  url.pathname = `${url.pathname.replace(/_test$/, "")}_test`;
  return url.toString();
}

const DATABASE_URL = urlDePruebas();
// global-setup corre en el proceso principal: lo lee de aquí.
process.env.MICRODIGITAL_TEST_DB_URL = DATABASE_URL;

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(process.cwd(), "src") },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/global-setup.ts"],
    // Todos los archivos comparten la misma base: se ejecutan de a uno.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      DATABASE_URL,
      NODE_ENV: "test",
      JWT_SECRET: env.JWT_SECRET || "secreto-solo-para-pruebas-automaticas-0123456789",
      FRONTEND_URL: "http://localhost:3000",
      PASSWORD_RESET_EXPIRES_MINUTES: "15",
      // Nunca enviar correos reales desde las pruebas.
      GMAIL_USER: "",
      GMAIL_APP_PASSWORD: "",
    },
  },
});
