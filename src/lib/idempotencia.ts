import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "./db";

const TTL_HORAS = 24;
const LARGO_MAXIMO_CLAVE = 200;

/**
 * Deduplica peticiones mutadoras (POST/PUT/DELETE) vía el header
 * `Idempotency-Key`, para que un reintento del cliente (timeout, doble
 * click, red inestable) no repita efectos ya aplicados: descontar stock dos
 * veces, cobrar dos abonos, etc.
 *
 * Es opt-in: si el cliente no envía el header, `fn` se ejecuta normalmente
 * y nada cambia respecto al comportamiento previo.
 *
 * `fn` debe ser el handler completo (con su propio try/catch y
 * `manejarErrorApi`) devolviendo el NextResponse final — este wrapper no
 * conoce la lógica de negocio, solo decide si ejecutarla o reproducir la
 * respuesta ya guardada.
 *
 * Flujo cuando SÍ hay Idempotency-Key:
 *  1. Intenta "reclamar" la clave con un INSERT (create). El índice único
 *     de `clave` hace que solo una petición concurrente gane la carrera.
 *  2. Si el INSERT choca (P2002) porque la clave ya existe:
 *     - con respuesta guardada -> se reproduce tal cual (mismo status/body).
 *     - sin respuesta todavía  -> la operación original sigue en curso ->
 *       409, en vez de dejar pasar dos ejecuciones en paralelo.
 *  3. Si el INSERT gana, se ejecuta `fn` y su resultado se guarda antes de
 *     responder. Los errores 5xx NO se cachean (se asumen transitorios: un
 *     reintento real debe poder volver a intentar la operación); los 4xx sí
 *     se cachean, porque son deterministas para el mismo payload.
 */
export async function ejecutarIdempotente(
  req: NextRequest,
  opciones: { negocioId: string; endpoint: string },
  fn: () => Promise<NextResponse>
): Promise<NextResponse> {
  const clave = req.headers.get("Idempotency-Key");
  if (!clave) return fn();

  if (clave.length > LARGO_MAXIMO_CLAVE) {
    return NextResponse.json(
      { error: `Idempotency-Key demasiado larga (máximo ${LARGO_MAXIMO_CLAVE} caracteres)` },
      { status: 400 }
    );
  }

  const claveCompuesta = `${opciones.negocioId}::${opciones.endpoint}::${clave}`;

  try {
    await prisma.idempotentRequest.create({
      data: {
        clave: claveCompuesta,
        negocioId: opciones.negocioId,
        endpoint: opciones.endpoint,
        expiraEn: new Date(Date.now() + TTL_HORAS * 3600 * 1000),
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const existente = await prisma.idempotentRequest.findUnique({ where: { clave: claveCompuesta } });
      if (existente && existente.respuestaStatus !== null) {
        return NextResponse.json(existente.respuestaBody as object, {
          status: existente.respuestaStatus,
          headers: { "Idempotent-Replay": "true" },
        });
      }
      return NextResponse.json(
        { error: "Esta operación ya se está procesando, espera un momento" },
        { status: 409 }
      );
    }
    throw error;
  }

  let respuesta: NextResponse;
  try {
    respuesta = await fn();
  } catch (error) {
    // Error inesperado no capturado por `fn`: libera la clave para permitir
    // un reintento real en vez de dejarla huérfana en estado "en curso".
    await prisma.idempotentRequest.delete({ where: { clave: claveCompuesta } }).catch(() => {});
    throw error;
  }

  if (respuesta.status >= 500) {
    await prisma.idempotentRequest.delete({ where: { clave: claveCompuesta } }).catch(() => {});
    return respuesta;
  }

  const cuerpo = await respuesta.clone().json().catch(() => null);
  await prisma.idempotentRequest
    .update({
      where: { clave: claveCompuesta },
      data: { respuestaStatus: respuesta.status, respuestaBody: cuerpo ?? Prisma.JsonNull },
    })
    .catch(() => {});

  return respuesta;
}

/**
 * Borra las claves de idempotencia vencidas (más de TTL_HORAS). No hay
 * infraestructura de cron en el proyecto todavía: se deja esta función lista
 * para invocarla desde un cron externo (ej. Vercel Cron pegándole a una ruta
 * que la llame) en vez de montar un scheduler propio sin que se use.
 */
export async function limpiarIdempotentRequestsExpirados(): Promise<number> {
  const { count } = await prisma.idempotentRequest.deleteMany({
    where: { expiraEn: { lt: new Date() } },
  });
  return count;
}
