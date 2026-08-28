import { randomUUID } from "node:crypto";
import type { Prisma, TipoConsecutivo } from "@prisma/client";

/**
 * Módulo 11 — numeración consecutiva por negocio y tipo de documento.
 *
 * POR QUÉ NO SE CALCULA CON `MAX(numero) + 1`:
 * dos ventas simultáneas leerían el mismo máximo y ambas intentarían escribir
 * el mismo número, y una de las dos moriría contra el UNIQUE
 * (negocioId, numero) — justo en el peor momento, al cerrar una venta.
 *
 * En su lugar se usa un contador dedicado y un único statement
 * `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`, que es atómico: Postgres
 * toma el lock de la fila del contador, incrementa y devuelve el valor nuevo.
 * La segunda transacción espera y recibe el siguiente número, sin colisiones
 * y sin que la aplicación tenga que reintentar.
 *
 * IMPORTANTE: llamar SIEMPRE con el cliente `tx` de la transacción que crea el
 * documento. Si se consume un número y luego la transacción falla, el número
 * se pierde (queda un hueco en la serie) pero nunca se duplica — que es el
 * compromiso correcto: un hueco es un detalle contable menor, un folio
 * repetido es un documento inválido.
 */
export async function siguienteConsecutivo(
  tx: Prisma.TransactionClient,
  negocioId: string,
  tipo: TipoConsecutivo,
  serie = "A"
): Promise<number> {
  const filas = await tx.$queryRaw<Array<{ valor: number }>>`
    INSERT INTO "consecutivos" ("id", "negocioId", "tipo", "serie", "valor")
    VALUES (${randomUUID()}, ${negocioId}, ${tipo}::"TipoConsecutivo", ${serie}, 1)
    ON CONFLICT ("negocioId", "tipo", "serie")
    DO UPDATE SET "valor" = "consecutivos"."valor" + 1
    RETURNING "valor"
  `;

  const valor = filas[0]?.valor;
  if (typeof valor !== "number") {
    throw new Error("No se pudo generar el número consecutivo del documento");
  }
  return valor;
}

/**
 * Folio legible de un comprobante: "FACTURA-A-000123".
 * Se persiste en `Comprobante.folio` para poder buscarlo tal como aparece
 * impreso, sin recomponerlo en cada consulta.
 */
export function construirFolio(tipo: string, serie: string, numero: number): string {
  return `${tipo}-${serie}-${String(numero).padStart(6, "0")}`;
}

/** Estado actual de los contadores de un negocio (solo lectura, para la UI). */
export async function listarConsecutivos(
  db: Prisma.TransactionClient,
  negocioId: string
) {
  return db.consecutivo.findMany({
    where: { negocioId },
    orderBy: [{ tipo: "asc" }, { serie: "asc" }],
    select: { tipo: true, serie: true, valor: true },
  });
}
