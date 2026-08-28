import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requerirSesionDeNegocio, requerirRol } from "@/lib/tenant";
import { manejarErrorApi } from "@/lib/api-error";
import { resolverRango, filtroFechas } from "@/lib/periodo";
import { aNumero } from "@/lib/dinero";

// MÓDULO 8 — Análisis de gastos por categoría.
// GET /api/estadisticas/gastos?periodo=mes
export async function GET(req: NextRequest) {
  try {
    const sesion = await requerirSesionDeNegocio(req);
    requerirRol(sesion, "ADMINISTRADOR");
    const rango = resolverRango(req.nextUrl.searchParams);

    const gastos = await prisma.gasto.findMany({
      where: { negocioId: sesion.negocioId, fecha: filtroFechas(rango) },
      select: { monto: true, categoriaGasto: { select: { id: true, nombre: true } } },
    });

    const porCategoria = new Map<string, { nombre: string; monto: number; cantidad: number }>();
    for (const g of gastos) {
      const clave = g.categoriaGasto?.id ?? "sin-categoria";
      const acumulado = porCategoria.get(clave) ?? {
        nombre: g.categoriaGasto?.nombre ?? "Sin categoría",
        monto: 0,
        cantidad: 0,
      };
      acumulado.monto += aNumero(g.monto);
      acumulado.cantidad += 1;
      porCategoria.set(clave, acumulado);
    }

    const totalGastado = gastos.reduce((acc, g) => acc + aNumero(g.monto), 0);

    return NextResponse.json({
      periodo: rango.etiqueta,
      totalGastado: Math.round(totalGastado * 100) / 100,
      numeroGastos: gastos.length,
      porCategoria: [...porCategoria.entries()]
        .map(([categoriaId, datos]) => ({
          categoriaId,
          ...datos,
          porcentajeDelTotal: totalGastado > 0 ? Math.round((datos.monto / totalGastado) * 1000) / 10 : 0,
        }))
        .sort((a, b) => b.monto - a.monto),
    });
  } catch (error) {
    return manejarErrorApi(error);
  }
}
