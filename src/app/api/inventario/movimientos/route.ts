import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requerirSesionDeNegocio, requerirRol } from "@/lib/tenant";
import { manejarErrorApi } from "@/lib/api-error";
import { aplicarMovimiento } from "@/lib/inventario";
import { metaPaginacion, parsePaginacion, quiereCsv, respuestaCsv, aCsv } from "@/lib/http";
import { resolverRango, filtroFechas } from "@/lib/periodo";

// MÓDULO 2 — Kardex e ingresos/salidas manuales.
// GET  /api/inventario/movimientos -> historial (kardex), exportable a CSV
// POST /api/inventario/movimientos -> ENTRADA / SALIDA / MERMA manual

const crearMovimientoSchema = z.object({
  productoId: z.string().cuid(),
  varianteId: z.string().cuid().nullish(),
  tipo: z.enum(["ENTRADA", "SALIDA", "MERMA"]),
  cantidad: z.number().int().positive(),
  costoUnitario: z.number().nonnegative().nullish(),
  motivo: z.string().min(3, "El motivo del movimiento manual es obligatorio"),
});

export async function GET(req: NextRequest) {
  try {
    const sesion = await requerirSesionDeNegocio(req);
    const params = req.nextUrl.searchParams;

    const productoId = params.get("productoId");
    const tipo = params.get("tipo");

    const where: Prisma.MovimientoInventarioWhereInput = {
      negocioId: sesion.negocioId,
      ...(productoId ? { productoId } : {}),
      ...(tipo ? { tipo: tipo as Prisma.EnumTipoMovimientoFilter["equals"] } : {}),
    };
    if (params.get("periodo") || params.get("desde") || params.get("hasta")) {
      where.createdAt = filtroFechas(resolverRango(params));
    }

    if (quiereCsv(params)) {
      const movimientos = await prisma.movimientoInventario.findMany({
        where,
        include: { producto: { select: { nombre: true } }, variante: { select: { nombre: true } } },
        orderBy: { createdAt: "desc" },
        take: 5000, // tope defensivo: un export no debe poder tumbar la BD
      });
      const filas = movimientos.map((m) => ({
        fecha: m.createdAt,
        producto: m.producto.nombre,
        variante: m.variante?.nombre ?? "",
        tipo: m.tipo,
        cantidad: m.cantidad,
        stockAnterior: m.stockAnterior,
        stockResultante: m.stockResultante,
        motivo: m.motivo ?? "",
      }));
      const csv = aCsv(filas, [
        { clave: "fecha", titulo: "Fecha" },
        { clave: "producto", titulo: "Producto" },
        { clave: "variante", titulo: "Variante" },
        { clave: "tipo", titulo: "Tipo" },
        { clave: "cantidad", titulo: "Cantidad" },
        { clave: "stockAnterior", titulo: "Stock anterior" },
        { clave: "stockResultante", titulo: "Stock resultante" },
        { clave: "motivo", titulo: "Motivo" },
      ]);
      return respuestaCsv(csv, "kardex.csv");
    }

    const paginacion = parsePaginacion(params);
    const [movimientos, total] = await Promise.all([
      prisma.movimientoInventario.findMany({
        where,
        include: {
          producto: { select: { id: true, nombre: true } },
          variante: { select: { id: true, nombre: true } },
          usuario: { select: { id: true, nombre: true } },
        },
        orderBy: { createdAt: "desc" },
        skip: paginacion.skip,
        take: paginacion.limite,
      }),
      prisma.movimientoInventario.count({ where }),
    ]);

    return NextResponse.json({ movimientos, meta: metaPaginacion(total, paginacion) });
  } catch (error) {
    return manejarErrorApi(error);
  }
}

// POST — solo Administrador: un ajuste manual de stock es una operación
// sensible (puede usarse para "cuadrar" mermas sin dejar rastro real).
export async function POST(req: NextRequest) {
  try {
    const sesion = await requerirSesionDeNegocio(req);
    requerirRol(sesion, "ADMINISTRADOR");
    const data = crearMovimientoSchema.parse(await req.json());

    const movimiento = await prisma.$transaction((tx) =>
      aplicarMovimiento(tx, {
        negocioId: sesion.negocioId,
        productoId: data.productoId,
        varianteId: data.varianteId,
        tipo: data.tipo,
        cantidad: data.cantidad,
        costoUnitario: data.costoUnitario,
        motivo: data.motivo,
        referenciaTipo: "ajuste_manual",
        usuarioId: sesion.usuarioId,
      })
    );

    return NextResponse.json({ movimiento }, { status: 201 });
  } catch (error) {
    return manejarErrorApi(error);
  }
}
