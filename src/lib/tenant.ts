import { NextRequest } from "next/server";
import { cookies } from "next/headers";
import { Rol } from "@prisma/client";
import { SESSION_COOKIE_NAME, verificarSesion, type SesionPayload } from "./session";

/**
 * Punto único de lectura de sesión para rutas API.
 *
 * REGLA DE ORO DE AISLAMIENTO MULTI-TENANT (RNF-002):
 * Ningún handler debe construir un `where` de Prisma para las tablas
 * operativas (productos, ventas, clientes, categorías) sin pasar por
 * `sesion.negocioId`. Esta función es la única fuente de verdad sobre
 * a qué negocio pertenece la petición.
 */
export async function obtenerSesion(req: NextRequest): Promise<SesionPayload | null> {
  const token = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;
  return verificarSesion(token);
}

/** Igual que obtenerSesion, pero para usar dentro de Server Components (sin NextRequest). */
export async function obtenerSesionServidor(): Promise<SesionPayload | null> {
  const token = cookies().get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;
  return verificarSesion(token);
}

export class ErrorAutenticacion extends Error {
  status = 401;
}

export class ErrorAutorizacion extends Error {
  status = 403;
}

/** Exige una sesión válida. Lanza 401 si no existe. */
export async function requerirSesion(req: NextRequest): Promise<SesionPayload> {
  const sesion = await obtenerSesion(req);
  if (!sesion) throw new ErrorAutenticacion("No autenticado");
  return sesion;
}

/**
 * Exige una sesión con un negocio asociado (Administrador o Vendedor).
 * El Superadmin NO tiene negocioId y no puede usar los endpoints operativos.
 */
export async function requerirSesionDeNegocio(
  req: NextRequest
): Promise<SesionPayload & { negocioId: string }> {
  const sesion = await requerirSesion(req);
  if (!sesion.negocioId) {
    throw new ErrorAutorizacion("Esta acción requiere pertenecer a un negocio");
  }
  return sesion as SesionPayload & { negocioId: string };
}

/** Exige que el rol de la sesión esté dentro de los roles permitidos. */
export function requerirRol(sesion: SesionPayload, ...rolesPermitidos: Rol[]): void {
  if (!rolesPermitidos.includes(sesion.rol)) {
    throw new ErrorAutorizacion(
      `Rol '${sesion.rol}' no autorizado. Se requiere: ${rolesPermitidos.join(", ")}`
    );
  }
}
