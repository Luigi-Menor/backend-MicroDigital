import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { Prisma } from "@prisma/client";
import { ErrorAutenticacion, ErrorAutorizacion } from "./tenant";
import { ErrorTokenGoogle } from "./google";
import { ErrorStock } from "./inventario";
import { ErrorFiado } from "./fiados";
import { ErrorComprobante } from "./comprobante";
import { ErrorLimiteSolicitudes } from "./rate-limit";
import { ErrorCorreo } from "./correo";

/** Error de dominio con código HTTP explícito (404, 409...). */
export class ErrorDominio extends Error {
  constructor(mensaje: string, public status = 400) {
    super(mensaje);
  }
}

/** No encontrado — o existente pero de OTRO negocio (no se distingue a propósito). */
export class ErrorNoEncontrado extends ErrorDominio {
  constructor(mensaje = "Recurso no encontrado") {
    super(mensaje, 404);
  }
}

/** Conflicto con el estado actual: duplicado, venta ya anulada, etc. */
export class ErrorConflicto extends ErrorDominio {
  constructor(mensaje: string) {
    super(mensaje, 409);
  }
}

/**
 * Códigos de Prisma que no dependen de la petición sino del estado de la base
 * en ese instante; reintentar puede funcionar.
 *   P2024  sin conexión libre en el pool a tiempo
 *   P2028  no se pudo iniciar/terminar la transacción a tiempo (saturación)
 *   P2034  conflicto de escritura o deadlock entre transacciones
 *   P1001 / P1002 / P1017  no se alcanza la base o cerró la conexión
 */
const CODIGOS_TRANSITORIOS = new Set(["P2024", "P2028", "P2034", "P1001", "P1002", "P1017"]);

export function esErrorTransitorioDeBase(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientInitializationError) return true;
  if (error instanceof Prisma.PrismaClientKnownRequestError) return CODIGOS_TRANSITORIOS.has(error.code);
  return false;
}

/** Traduce cualquier error conocido del dominio a una respuesta HTTP consistente. */
export function manejarErrorApi(error: unknown) {
  // Señal interna de Next.js (no es un error de la app): durante el build la
  // lanza al detectar que una ruta lee cookies y por tanto es dinámica. Hay
  // que dejarla pasar; si se atrapa, Next la ve como un fallo y la imprime.
  if ((error as { digest?: unknown } | null)?.digest === "DYNAMIC_SERVER_USAGE") {
    throw error;
  }

  if (error instanceof ErrorLimiteSolicitudes) {
    return NextResponse.json(
      { error: error.message },
      { status: 429, headers: { "Retry-After": String(error.reintentarEnSegundos) } }
    );
  }
  if (error instanceof ErrorCorreo) {
    // 503: el servicio de correo no está disponible o no está configurado; el
    // mensaje es seguro de mostrar (nunca incluye credenciales).
    return NextResponse.json({ error: error.message }, { status: 503 });
  }
  if (error instanceof ErrorAutenticacion || error instanceof ErrorTokenGoogle) {
    return NextResponse.json({ error: error.message }, { status: 401 });
  }
  if (error instanceof ErrorAutorizacion) {
    return NextResponse.json({ error: error.message }, { status: 403 });
  }
  if (error instanceof ErrorDominio) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  if (error instanceof ZodError) {
    return NextResponse.json(
      { error: "Datos inválidos", detalles: error.flatten() },
      { status: 400 }
    );
  }

  // Reglas de negocio de los módulos 2, 5 y 11. Son fallos esperables que el
  // usuario puede corregir (stock insuficiente, sobrepago de un fiado), no
  // errores del servidor: por eso 409 y no 500.
  if (
    error instanceof ErrorStock ||
    error instanceof ErrorFiado ||
    error instanceof ErrorComprobante
  ) {
    return NextResponse.json({ error: error.message }, { status: 409 });
  }

  // Fallos TRANSITORIOS de la base (saturación, conflicto entre transacciones,
  // base caída): 503 y no 400. La diferencia importa por la idempotencia: las
  // respuestas 4xx se guardan 24 h bajo su Idempotency-Key, así que un 400 por
  // saturación hacía que el reintento del punto de venta recibiera el error
  // guardado para siempre aunque la venta nunca se registró. Los 5xx no se
  // guardan y el reintento vuelve a intentarlo de verdad.
  if (esErrorTransitorioDeBase(error)) {
    console.error("[db] error transitorio:", (error as { code?: string }).code ?? (error as Error).name);
    return NextResponse.json(
      { error: "El sistema está ocupado en este momento. Inténtalo de nuevo." },
      { status: 503, headers: { "Retry-After": "1" } }
    );
  }

  // Errores de Prisma con significado de negocio. Sin este bloque, violar un
  // índice único devolvía un 400 con el mensaje crudo del driver, que expone
  // nombres de constraints internos al cliente.
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2002") {
      const campos = (error.meta?.target as string[] | undefined)?.join(", ");
      return NextResponse.json(
        { error: campos ? `Ya existe un registro con ese ${campos}` : "Registro duplicado" },
        { status: 409 }
      );
    }
    if (error.code === "P2025") {
      return NextResponse.json({ error: "Recurso no encontrado" }, { status: 404 });
    }
    if (error.code === "P2003") {
      return NextResponse.json(
        { error: "No se puede completar: el registro está referenciado por otros datos" },
        { status: 409 }
      );
    }
    console.error(error);
    return NextResponse.json({ error: "Error al acceder a los datos" }, { status: 400 });
  }

  if (error instanceof Error) {
    console.error(error);
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  console.error(error);
  return NextResponse.json({ error: "Error interno del servidor" }, { status: 500 });
}
