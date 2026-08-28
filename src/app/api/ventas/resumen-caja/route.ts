import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requerirSesionDeNegocio } from "@/lib/tenant";
import { manejarErrorApi } from "@/lib/api-error";
import { resolverRango, filtroFechas } from "@/lib/periodo";
import { aNumero } from "@/lib/dinero";

// MÓDULO 1 — Cierre / arqueo de caja del turno o día.
// GET /api/ventas/resumen-caja?periodo=hoy
export async function GET(req: NextRequest) {
  try {
    const sesion = await requerirSesionDeNegocio(req);
    const rango = resolverRango(req.nextUrl.searchParams);

    // Filtro base común (negocio, fecha, vendedor); el estado se agrega
    // aparte en cada query porque el conteo de anuladas necesita el opuesto.
    const baseWhere = {
      negocioId: sesion.negocioId,
      createdAt: filtroFechas(rango),
      // Un Vendedor solo arquea su propio turno.
      ...(sesion.rol === "VENDEDOR" ? { usuarioId: sesion.usuarioId } : {}),
    };
    const whereActivas = { ...baseWhere, estado: { not: "ANULADA" as const } };

    const [porFormaPago, totalGeneral, ventasAnuladas] = await Promise.all([
      prisma.venta.groupBy({
        by: ["formaPago"],
        where: whereActivas,
        _sum: { total: true },
        _count: true,
      }),
      prisma.venta.aggregate({ where: whereActivas, _sum: { total: true }, _count: true }),
      prisma.venta.count({ where: { ...baseWhere, estado: "ANULADA" as const } }),
    ]);

    return NextResponse.json({
      periodo: rango.etiqueta,
      desde: rango.desde,
      hasta: rango.hasta,
      totalVentas: totalGeneral._count,
      montoTotal: aNumero(totalGeneral._sum.total),
      ventasAnuladas,
      porFormaPago: porFormaPago.map((g) => ({
        formaPago: g.formaPago,
        cantidad: g._count,
        monto: aNumero(g._sum.total),
      })),
    });
  } catch (error) {
    return manejarErrorApi(error);
  }
}
