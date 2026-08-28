import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requerirSesionDeNegocio, requerirRol } from "@/lib/tenant";
import { manejarErrorApi } from "@/lib/api-error";
import { crearVenta } from "@/lib/ventas";
import { emitirComprobante } from "@/lib/comprobante";
import { metaPaginacion, parsePaginacion } from "@/lib/http";
import { resolverRango, filtroFechas } from "@/lib/periodo";

// MÓDULO 1 — Ventas / POS
// POST /api/ventas  -> registrar venta (con descuentos, variantes y comprobante)
// GET  /api/ventas  -> historial filtrable y paginado

const itemSchema = z.object({
  productoId: z.string().cuid(),
  varianteId: z.string().cuid().nullish(),
  cantidad: z.number().int().positive(),
  precioUnitario: z.number().nonnegative().nullish(),
  descuento: z.number().nonnegative().nullish(),
  descuentoPorcentaje: z.number().min(0).max(100).nullish(),
});

const crearVentaSchema = z
  .object({
    items: z.array(itemSchema).min(1, "La venta debe tener al menos un producto"),
    formaPago: z.enum(["EFECTIVO", "TRANSFERENCIA", "FIADO", "TARJETA", "OTRO"]),
    clienteId: z.string().cuid().nullish(),
    descuento: z.number().nonnegative().nullish(),
    descuentoPorcentaje: z.number().min(0).max(100).nullish(),
    aplicarImpuesto: z.boolean().optional().default(false),
    montoPagado: z.number().nonnegative().nullish(),
    nota: z.string().max(500).nullish(),
    /// Si viene, se emite el comprobante en la MISMA transacción de la venta.
    emitirComprobante: z
      .enum(["TICKET", "FACTURA", "RECIBO", "COTIZACION"])
      .nullish(),
  })
  // RF-010: si la forma de pago es "fiado", debe existir un cliente asociado.
  .refine((data) => data.formaPago !== "FIADO" || !!data.clienteId, {
    message: "Una venta fiada requiere un cliente asociado",
    path: ["clienteId"],
  });

export async function GET(req: NextRequest) {
  try {
    const sesion = await requerirSesionDeNegocio(req);
    const params = req.nextUrl.searchParams;
    const paginacion = parsePaginacion(params);

    const estado = params.get("estado");
    const clienteId = params.get("clienteId");
    const formaPago = params.get("formaPago");
    // Un Vendedor solo ve sus propias ventas; el Administrador puede filtrar
    // por cualquier empleado (o ver todas si no filtra).
    const usuarioId =
      sesion.rol === "VENDEDOR" ? sesion.usuarioId : params.get("usuarioId") ?? undefined;

    const where: Prisma.VentaWhereInput = {
      negocioId: sesion.negocioId,
      ...(estado ? { estado: estado as Prisma.EnumEstadoVentaFilter["equals"] } : {}),
      ...(clienteId ? { clienteId } : {}),
      ...(formaPago ? { formaPago: formaPago as Prisma.EnumFormaPagoFilter["equals"] } : {}),
      ...(usuarioId ? { usuarioId } : {}),
    };

    // El rango solo se aplica si el cliente pidió filtrar por fecha: sin esto,
    // el historial "todas mis ventas" quedaría recortado al mes en curso.
    if (params.get("periodo") || params.get("desde") || params.get("hasta")) {
      where.createdAt = filtroFechas(resolverRango(params));
    }

    const [ventas, total] = await Promise.all([
      prisma.venta.findMany({
        where,
        include: {
          detalles: { include: { producto: true, variante: true } },
          cliente: { select: { id: true, nombre: true, saldoDeuda: true } },
          usuario: { select: { id: true, nombre: true } },
          comprobantes: { select: { id: true, folio: true, tipo: true } },
        },
        orderBy: { createdAt: "desc" },
        skip: paginacion.skip,
        take: paginacion.limite,
      }),
      prisma.venta.count({ where }),
    ]);

    return NextResponse.json({ ventas, meta: metaPaginacion(total, paginacion) });
  } catch (error) {
    return manejarErrorApi(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    const sesion = await requerirSesionDeNegocio(req);
    requerirRol(sesion, "ADMINISTRADOR", "VENDEDOR");
    const body = crearVentaSchema.parse(await req.json());

    // Toda la venta —valoración, stock, deuda y comprobante— ocurre en una
    // sola transacción: si el comprobante falla, la venta no debe quedar
    // registrada a medias con el stock ya descontado.
    const resultado = await prisma.$transaction(async (tx) => {
      const venta = await crearVenta(tx, {
        negocioId: sesion.negocioId,
        usuarioId: sesion.usuarioId,
        items: body.items,
        formaPago: body.formaPago,
        clienteId: body.clienteId,
        descuento: body.descuento,
        descuentoPorcentaje: body.descuentoPorcentaje,
        aplicarImpuesto: body.aplicarImpuesto,
        montoPagado: body.montoPagado,
        nota: body.nota,
      });

      let comprobante = null;
      if (body.emitirComprobante) {
        comprobante = await emitirComprobante(tx, {
          negocioId: sesion.negocioId,
          usuarioId: sesion.usuarioId,
          tipo: body.emitirComprobante,
          origen: { clase: "venta", ventaId: venta.id },
        });
      }

      return { venta, comprobante };
    });

    return NextResponse.json(resultado, { status: 201 });
  } catch (error) {
    return manejarErrorApi(error);
  }
}
