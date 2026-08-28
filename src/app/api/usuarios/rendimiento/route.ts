import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requerirSesionDeNegocio, requerirRol } from "@/lib/tenant";
import { manejarErrorApi } from "@/lib/api-error";
import { resolverRango, filtroFechas } from "@/lib/periodo";
import { aNumero } from "@/lib/dinero";

// MÓDULO 10 — Seguimiento de ventas por empleado: cuánto vendió cada uno en
// el período y su % de cumplimiento frente a la meta mensual (si tiene).
// GET /api/usuarios/rendimiento?periodo=mes
export async function GET(req: NextRequest) {
  try {
    const sesion = await requerirSesionDeNegocio(req);
    requerirRol(sesion, "ADMINISTRADOR");
    const rango = resolverRango(req.nextUrl.searchParams);

    const empleados = await prisma.usuario.findMany({
      where: { negocioId: sesion.negocioId, rol: "VENDEDOR" },
      select: { id: true, nombre: true, metaVentasMensual: true, activo: true },
    });

    const ventasPorEmpleado = await prisma.venta.groupBy({
      by: ["usuarioId"],
      where: {
        negocioId: sesion.negocioId,
        estado: { not: "ANULADA" },
        createdAt: filtroFechas(rango),
      },
      _sum: { total: true },
      _count: true,
    });

    const porUsuario = new Map(ventasPorEmpleado.map((v) => [v.usuarioId, v]));

    const rendimiento = empleados
      .map((e) => {
        const stats = porUsuario.get(e.id);
        const monto = aNumero(stats?._sum.total ?? 0);
        const meta = e.metaVentasMensual ? aNumero(e.metaVentasMensual) : null;
        return {
          usuarioId: e.id,
          nombre: e.nombre,
          activo: e.activo,
          numeroVentas: stats?._count ?? 0,
          montoVendido: monto,
          meta,
          cumplimiento: meta && meta > 0 ? Math.round((monto / meta) * 1000) / 10 : null,
        };
      })
      .sort((a, b) => b.montoVendido - a.montoVendido);

    return NextResponse.json({ periodo: rango.etiqueta, desde: rango.desde, hasta: rango.hasta, rendimiento });
  } catch (error) {
    return manejarErrorApi(error);
  }
}
