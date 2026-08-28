import crypto from "crypto";

/**
 * Hash determinístico (sha256) para tokens de un solo uso que se guardan en
 * BD (ej. recuperación de contraseña). No es para contraseñas: para eso se
 * usa bcrypt (ver hashPassword en lib/auth.ts), que es intencionalmente
 * lento. Aquí necesitamos poder buscar por igualdad exacta en la BD, así que
 * un hash rápido y determinístico es lo correcto — el valor de entropía está
 * en los 32 bytes aleatorios del propio token, no en el hash.
 */
export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}
