import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requerirSesionDeNegocio } from "@/lib/tenant";
import { manejarErrorApi } from "@/lib/api-error";
import { emitirComprobante } from "@/lib/comprobante";
import { metaPaginacion, parsePaginacion } from "@/lib/http";

// MÓDULO 11 — Comprobantes digitales.
// GET  /api/comprobantes -> historial (ticket/factura/recibo/cotización/abono)
// POST /api/comprobantes -> emitir uno nuevo para una venta o un abono ya existentes

const emitirSchema = z.object({
  tipo: z.enum(["TICKET", "FACTURA", "RECIBO", "COTIZACION", "COMPROBANTE_ABONO"]),
  ventaId: z.string().cuid().nullish(),
  abonoId: z.string().cuid().nullish(),
  serie: z.string().min(1).max(10).optional(),
}).refine((d) => !!d.ventaId !== !!d.abonoId, {
  message: "Indica exactamente uno de: ventaId o abonoId",
  path: ["ventaId"],
});

export async function GET(req: NextRequest) {
  try {
    const sesion = await requerirSesionDeNegocio(req);
    const params = req.nextUrl.searchParams;
    const paginacion = parsePaginacion(params);

    const tipo = params.get("tipo");
    const ventaId = params.get("ventaId");
    const clienteBusqueda = params.get("q");

    const where: Prisma.ComprobanteWhereInput = {
      negocioId: sesion.negocioId,
      ...(tipo ? { tipo: tipo as Prisma.EnumTipoComprobanteFilter["equals"] } : {}),
      ...(ventaId ? { ventaId } : {}),
      ...(clienteBusqueda ? { folio: { contains: clienteBusqueda, mode: "insensitive" } } : {}),
    };

    const [comprobantes, total] = await Promise.all([
      prisma.comprobante.findMany({
        where,
        select: {
          id: true,
          tipo: true,
          folio: true,
          total: true,
          estado: true,
          createdAt: true,
          enviadoA: true,
          medioEnvio: true,
          ventaId: true,
          abonoId: true,
          usuario: { select: { id: true, nombre: true } },
        },
        orderBy: { createdAt: "desc" },
        skip: paginacion.skip,
        take: paginacion.limite,
      }),
      prisma.comprobante.count({ where }),
    ]);

    return NextResponse.json({ comprobantes, meta: metaPaginacion(total, paginacion) });
  } catch (error) {
    return manejarErrorApi(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    const sesion = await requerirSesionDeNegocio(req);
    const data = emitirSchema.parse(await req.json());

    const comprobante = await prisma.$transaction((tx) =>
      emitirComprobante(tx, {
        negocioId: sesion.negocioId,
        usuarioId: sesion.usuarioId,
        tipo: data.tipo,
        serie: data.serie,
        origen: data.ventaId
          ? { clase: "venta", ventaId: data.ventaId }
          : { clase: "abono", abonoId: data.abonoId! },
      })
    );

    return NextResponse.json({ comprobante }, { status: 201 });
  } catch (error) {
    return manejarErrorApi(error);
  }
}
