import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requerirSesionDeNegocio, requerirRol } from "@/lib/tenant";
import { manejarErrorApi } from "@/lib/api-error";
import { crearCompra } from "@/lib/compras";
import { metaPaginacion, parsePaginacion } from "@/lib/http";
import { resolverRango, filtroFechas } from "@/lib/periodo";
import { ejecutarIdempotente } from "@/lib/idempotencia";

// MÓDULO 7 — Compras / abastecimiento.
const itemSchema = z.object({
  productoId: z.string().cuid(),
  varianteId: z.string().cuid().nullish(),
  cantidad: z.number().int().positive(),
  costoUnitario: z.number().positive(),
  descuento: z.number().nonnegative().nullish(),
  descuentoPorcentaje: z.number().min(0).max(100).nullish(),
});

const crearCompraSchema = z.object({
  proveedorId: z.string().cuid(),
  items: z.array(itemSchema).min(1),
  numeroFactura: z.string().nullish(),
  formaPago: z.enum(["EFECTIVO", "TRANSFERENCIA", "FIADO", "TARJETA", "OTRO"]).optional(),
  descuento: z.number().nonnegative().nullish(),
  descuentoPorcentaje: z.number().min(0).max(100).nullish(),
  impuesto: z.number().min(0).max(100).nullish(),
  fecha: z.string().nullish(),
  nota: z.string().max(500).nullish(),
  recibirInmediatamente: z.boolean().optional().default(false),
});

export async function GET(req: NextRequest) {
  try {
    const sesion = await requerirSesionDeNegocio(req);
    const params = req.nextUrl.searchParams;
    const paginacion = parsePaginacion(params);

    const proveedorId = params.get("proveedorId");
    const estado = params.get("estado");

    const where: Prisma.CompraWhereInput = {
      negocioId: sesion.negocioId,
      ...(proveedorId ? { proveedorId } : {}),
      ...(estado ? { estado: estado as Prisma.EnumEstadoCompraFilter["equals"] } : {}),
    };
    if (params.get("periodo") || params.get("desde") || params.get("hasta")) {
      where.fecha = filtroFechas(resolverRango(params));
    }

    const [compras, total] = await Promise.all([
      prisma.compra.findMany({
        where,
        include: {
          proveedor: { select: { id: true, nombre: true } },
          detalles: { include: { producto: { select: { nombre: true } } } },
        },
        orderBy: { fecha: "desc" },
        skip: paginacion.skip,
        take: paginacion.limite,
      }),
      prisma.compra.count({ where }),
    ]);

    return NextResponse.json({ compras, meta: metaPaginacion(total, paginacion) });
  } catch (error) {
    return manejarErrorApi(error);
  }
}

// POST — solo Administrador: comprometer inventario/dinero del negocio con
// un proveedor es una decisión de gestión, no de venta en mostrador.
export async function POST(req: NextRequest) {
  try {
    const sesion = await requerirSesionDeNegocio(req);
    requerirRol(sesion, "ADMINISTRADOR");

    return await ejecutarIdempotente(req, { negocioId: sesion.negocioId, endpoint: "POST /api/compras" }, async () => {
      try {
        const data = crearCompraSchema.parse(await req.json());

        const compra = await prisma.$transaction((tx) =>
          crearCompra(tx, {
            negocioId: sesion.negocioId,
            usuarioId: sesion.usuarioId,
            proveedorId: data.proveedorId,
            items: data.items,
            numeroFactura: data.numeroFactura,
            formaPago: data.formaPago,
            descuento: data.descuento,
            descuentoPorcentaje: data.descuentoPorcentaje,
            impuesto: data.impuesto,
            fecha: data.fecha,
            nota: data.nota,
            recibirInmediatamente: data.recibirInmediatamente,
          })
        );

        return NextResponse.json({ compra }, { status: 201 });
      } catch (error) {
        return manejarErrorApi(error);
      }
    });
  } catch (error) {
    return manejarErrorApi(error);
  }
}
