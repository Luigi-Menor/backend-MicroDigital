import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requerirSesionDeNegocio } from "@/lib/tenant";
import { manejarErrorApi } from "@/lib/api-error";
import { resolverRango, filtroFechas, rangoAnterior, granularidadAutomatica, claveGranularidad } from "@/lib/periodo";
import { aNumero } from "@/lib/dinero";

// MÓDULO 8 — Estadísticas de ventas: serie temporal + comparativa vs. período anterior.
// GET /api/estadisticas/ventas?periodo=mes
export async function GET(req: NextRequest) {
  try {
    const sesion = await requerirSesionDeNegocio(req);
    const rango = resolverRango(req.nextUrl.searchParams);
    const anterior = rangoAnterior(rango);
    const granularidad = granularidadAutomatica(rango);

    const whereBase = { negocioId: sesion.negocioId, estado: { not: "ANULADA" as const } };

    const [ventasActuales, ventasAnteriores] = await Promise.all([
      prisma.venta.findMany({
        where: { ...whereBase, createdAt: filtroFechas(rango) },
        select: { total: true, createdAt: true, formaPago: true },
      }),
      prisma.venta.aggregate({
        where: { ...whereBase, createdAt: filtroFechas(anterior) },
        _sum: { total: true },
        _count: true,
      }),
    ]);

    // Serie temporal agrupada por día/semana/mes según lo ancho del rango
    // (ver granularidadAutomatica): así "este año" no devuelve 365 puntos.
    const serieMap = new Map<string, { total: number; cantidad: number }>();
    for (const v of ventasActuales) {
      const clave = claveGranularidad(v.createdAt, granularidad);
      const acumulado = serieMap.get(clave) ?? { total: 0, cantidad: 0 };
      acumulado.total += aNumero(v.total);
      acumulado.cantidad += 1;
      serieMap.set(clave, acumulado);
    }
    const serie = [...serieMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([fecha, datos]) => ({ fecha, ...datos }));

    const totalActual = ventasActuales.reduce((acc, v) => acc + aNumero(v.total), 0);
    const totalAnterior = aNumero(ventasAnteriores._sum.total);
    const variacionPorcentual =
      totalAnterior > 0 ? Math.round(((totalActual - totalAnterior) / totalAnterior) * 1000) / 10 : null;

    const porFormaPago = new Map<string, { monto: number; cantidad: number }>();
    for (const v of ventasActuales) {
      const acumulado = porFormaPago.get(v.formaPago) ?? { monto: 0, cantidad: 0 };
      acumulado.monto += aNumero(v.total);
      acumulado.cantidad += 1;
      porFormaPago.set(v.formaPago, acumulado);
    }

    return NextResponse.json({
      periodo: rango.etiqueta,
      desde: rango.desde,
      hasta: rango.hasta,
      granularidad,
      totalVentas: ventasActuales.length,
      montoTotal: totalActual,
      ticketPromedio: ventasActuales.length > 0 ? Math.round((totalActual / ventasActuales.length) * 100) / 100 : 0,
      comparativa: {
        periodoAnterior: { monto: totalAnterior, cantidad: ventasAnteriores._count },
        variacionPorcentual,
      },
      serie,
      porFormaPago: [...porFormaPago.entries()].map(([formaPago, datos]) => ({ formaPago, ...datos })),
    });
  } catch (error) {
    return manejarErrorApi(error);
  }
}
