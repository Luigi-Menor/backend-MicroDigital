import bcrypt from "bcryptjs";

// Node-only (bcryptjs no corre en Edge Runtime). Importar este módulo solo
// desde rutas API (Node runtime) o scripts de servidor (seed), NUNCA desde
// middleware.ts ni desde lib/session.ts.

export async function hashPassword(password: string): Promise<string> {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(password, salt);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}
