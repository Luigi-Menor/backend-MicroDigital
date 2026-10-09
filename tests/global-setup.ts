import { execSync } from "node:child_process";

/**
 * Se ejecuta una vez antes de todas las pruebas: comprueba que la base sea de
 * pruebas y la lleva a la última migración con `prisma migrate deploy`, el
 * mismo comando que se usaría en producción (así las pruebas también validan
 * que las migraciones se aplican en orden sobre una base vacía).
 */
export default function setup() {
  const url = process.env.MICRODIGITAL_TEST_DB_URL;
  if (!url) throw new Error("vitest.config.ts no definió la URL de la base de pruebas");

  const nombre = new URL(url).pathname.replace(/^\//, "");
  if (!nombre.endsWith("_test")) {
    throw new Error(
      `Por seguridad, las pruebas solo corren contra una base cuyo nombre termine en "_test" (recibido: "${nombre}")`
    );
  }

  try {
    execSync("npx prisma migrate deploy", {
      env: { ...process.env, DATABASE_URL: url },
      stdio: "pipe",
    });
  } catch (error) {
    const salida = (error as { stdout?: Buffer; stderr?: Buffer }).stdout?.toString() ?? "";
    throw new Error(
      `No se pudo preparar la base de pruebas "${nombre}". ¿Existe? Créala con: CREATE DATABASE ${nombre};\n${salida}`
    );
  }
}
