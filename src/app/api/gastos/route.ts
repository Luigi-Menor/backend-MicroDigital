import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requerirSesionDeNegocio, requerirRol } from "@/lib/tenant";
import { manejarErrorApi } from "@/lib/api-error";
import { siguienteConsecutivo } from "@/lib/consecutivos";
import { metaPaginacion, parsePaginacion, quiereCsv, respuestaCsv, aCsv } from "@/lib/http";
import { resolverRango, filtroFechas } from "@/lib/periodo";
import { aNumero } from "@/lib/dinero";

// MÓDULO 6 — Gastos: registro y control de egresos.
const crearGastoSchema = z.object({
  categoriaGastoId: z.string().cuid().nullish(),
  proveedorId: z.string().cuid().nullish(),
  descripcion: z.string().min(2),
  monto: z.number().positive(),
  formaPago: z.enum(["EFECTIVO", "TRANSFERENCIA", "FIADO", "TARJETA", "OTRO"]).default("EFECTIVO"),
  fecha: z.string().datetime().or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).optional(),
  comprobanteUrl: z.string().url().nullish(),
  nota: z.string().max(500).nullish(),
});

export async function GET(req: NextRequest) {
  try {
    const sesion = await requerirSesionDeNegocio(req);
    const params = req.nextUrl.searchParams;

    const categoriaGastoId = params.get("categoriaGastoId");
    const proveedorId = params.get("proveedorId");

    const where: Prisma.GastoWhereInput = {
      negocioId: sesion.negocioId,
      ...(categoriaGastoId ? { categoriaGastoId } : {}),
      ...(proveedorId ? { proveedorId } : {}),
    };
    if (params.get("periodo") || params.get("desde") || params.get("hasta")) {
      where.fecha = filtroFechas(resolverRango(params));
    }

    if (quiereCsv(params)) {
      const gastos = await prisma.gasto.findMany({
        where,
        include: { categoriaGasto: { select: { nombre: true } } },
        orderBy: { fecha: "desc" },
        take: 5000,
      });
      const csv = aCsv(
        gastos.map((g) => ({
          fecha: g.fecha,
          descripcion: g.descripcion,
          categoria: g.categoriaGasto?.nombre ?? "",
          monto: aNumero(g.monto),
          formaPago: g.formaPago,
        })),
        [
          { clave: "fecha", titulo: "Fecha" },
          { clave: "descripcion", titulo: "Descripción" },
          { clave: "categoria", titulo: "Categoría" },
          { clave: "monto", titulo: "Monto" },
          { clave: "formaPago", titulo: "Forma de pago" },
        ]
      );
      return respuestaCsv(csv, "gastos.csv");
    }

    const paginacion = parsePaginacion(params);
    const [gastos, total, suma] = await Promise.all([
      prisma.gasto.findMany({
        where,
        include: {
          categoriaGasto: { select: { id: true, nombre: true } },
          proveedor: { select: { id: true, nombre: true } },
          usuario: { select: { id: true, nombre: true } },
        },
        orderBy: { fecha: "desc" },
        skip: paginacion.skip,
        take: paginacion.limite,
      }),
      prisma.gasto.count({ where }),
      prisma.gasto.aggregate({ where, _sum: { monto: true } }),
    ]);

    return NextResponse.json({
      gastos,
      totalPeriodo: aNumero(suma._sum.monto),
      meta: metaPaginacion(total, paginacion),
    });
  } catch (error) {
    return manejarErrorApi(error);
  }
}

// POST — Administrador y Vendedor pueden registrar gastos operativos del día
// a día (caja menor); solo el Administrador puede editarlos o borrarlos
// (ver [id]/route.ts).
export async function POST(req: NextRequest) {
  try {
    const sesion = await requerirSesionDeNegocio(req);
    const data = crearGastoSchema.parse(await req.json());

    const gasto = await prisma.$transaction(async (tx) => {
      const numero = await siguienteConsecutivo(tx, sesion.negocioId, "GASTO");
      return tx.gasto.create({
        data: {
          negocioId: sesion.negocioId,
          numero,
          categoriaGastoId: data.categoriaGastoId,
          proveedorId: data.proveedorId,
          descripcion: data.descripcion,
          monto: data.monto,
          formaPago: data.formaPago,
          fecha: data.fecha ? new Date(data.fecha) : undefined,
          comprobanteUrl: data.comprobanteUrl,
          nota: data.nota,
          usuarioId: sesion.usuarioId,
        },
        include: { categoriaGasto: true, proveedor: true },
      });
    });

    return NextResponse.json({ gasto }, { status: 201 });
  } catch (error) {
    return manejarErrorApi(error);
  }
}
