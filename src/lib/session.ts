import { SignJWT, jwtVerify } from "jose";
import type { Rol } from "@prisma/client";

// Este módulo SOLO debe importar librerías compatibles con Edge Runtime
// (aquí, `jose`). Lo usa tanto el middleware (Edge) como las rutas API
// (Node), así que cualquier dependencia Node-only que se cuele aquí termina
// empaquetada en el bundle del middleware (fue justamente el bug con
// bcryptjs antes de separar este archivo de lib/password.ts).

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN_SECONDS = Number(process.env.JWT_EXPIRES_IN_SECONDS ?? 28800);

if (!JWT_SECRET && process.env.NODE_ENV === "production") {
  // Zero Trust: nunca arrancar en producción sin secreto configurado.
  throw new Error("JWT_SECRET no está configurado. Revisa tu archivo .env.");
}

const secretKey = new TextEncoder().encode(JWT_SECRET ?? "dev-secret-inseguro");

export interface SesionPayload {
  usuarioId: string;
  negocioId: string | null; // null solo para SUPERADMIN
  rol: Rol;
  email: string;
}

export async function firmarSesion(payload: SesionPayload): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${JWT_EXPIRES_IN_SECONDS}s`)
    .sign(secretKey);
}

export async function verificarSesion(token: string): Promise<SesionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey);
    return payload as unknown as SesionPayload;
  } catch {
    return null;
  }
}

export const SESSION_COOKIE_NAME = "microdigital_session";

/**
 * Opciones de cookie centralizadas. `domain` queda sin definir en
 * desarrollo (cookie host-only sobre "localhost", que los navegadores
 * comparten entre puertos). En producción, si frontend y backend viven en
 * subdominios del mismo dominio, `COOKIE_DOMAIN=.tudominio.com` permite que
 * ambos la lean. Si viven en dominios completamente distintos, esta cookie
 * httpOnly no cruza — habría que migrar a `SameSite=None; Secure` (fuera de
 * alcance por ahora, documentado en el README).
 */
export function opcionesCookieSesion() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    domain: process.env.COOKIE_DOMAIN || undefined,
  };
}
