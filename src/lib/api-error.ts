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

/** Traduce cualquier error conocido del dominio a una respuesta HTTP consistente. */
export function manejarErrorApi(error: unknown) {
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
