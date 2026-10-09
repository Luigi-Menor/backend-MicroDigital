import { NextResponse } from "next/server";

/**
 * Backend y frontend ahora son dos apps en orígenes distintos (puertos o
 * dominios distintos), así que toda petición del navegador desde el
 * frontend hacia esta API es cross-origin. Sin estos headers, el navegador
 * bloquearía la respuesta antes de que el frontend pueda leerla.
 *
 * `credentials: true` + un origin EXPLÍCITO (nunca "*") es obligatorio
 * porque las peticiones llevan la cookie de sesión (`credentials: "include"`
 * en el fetch del frontend).
 */
export function aplicarCors(res: NextResponse, origin: string | null): NextResponse {
  const permitido = process.env.FRONTEND_URL;
  if (permitido && origin === permitido) {
    res.headers.set("Access-Control-Allow-Origin", permitido);
    res.headers.set("Access-Control-Allow-Credentials", "true");
  }
  res.headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  // Idempotency-Key debe estar aquí: sin él, el navegador rechaza en el
  // preflight cualquier petición que lo envíe y la deduplicación de
  // lib/idempotencia.ts nunca llega a usarse desde la interfaz.
  res.headers.set("Access-Control-Allow-Headers", "Content-Type, Idempotency-Key");
  return res;
}
