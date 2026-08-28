import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requerirSesionDeNegocio } from "@/lib/tenant";
import { manejarErrorApi } from "@/lib/api-error";
import { resolverRango, filtroFechas } from "@/lib/periodo";
import { aNumero } from "@/lib/dinero";

// MÓDULO 8 — Ranking de productos: más vendidos y mejor margen.
// GET /api/estadisticas/productos?periodo=mes
export async function GET(req: NextRequest) {
  try {
    const sesion = await requerirSesionDeNegocio(req);
    const rango = resolverRango(req.nextUrl.searchParams);

    const detalles = await prisma.ventaDetalle.findMany({
      where: {
        venta: {
          negocioId: sesion.negocioId,
          estado: { not: "ANULADA" },
          createdAt: filtroFechas(rango),
        },
      },
      select: {
        cantidad: true,
        subtotal: true,
        costoUnitario: true,
        descripcion: true,
        productoId: true,
        producto: { select: { nombre: true } },
      },
    });

    const porProducto = new Map<
      string,
      { nombre: string; unidadesVendidas: number; ingresos: number; costo: number }
    >();

    for (const d of detalles) {
      const acumulado = porProducto.get(d.productoId) ?? {
        nombre: d.descripcion ?? d.producto.nombre,
        unidadesVendidas: 0,
        ingresos: 0,
        costo: 0,
      };
      acumulado.unidadesVendidas += d.cantidad;
      acumulado.ingresos += aNumero(d.subtotal);
      acumulado.costo += aNumero(d.costoUnitario) * d.cantidad;
      porProducto.set(d.productoId, acumulado);
    }

    const ranking = [...porProducto.entries()].map(([productoId, datos]) => ({
      productoId,
      ...datos,
      margen: Math.round((datos.ingresos - datos.costo) * 100) / 100,
      margenPorcentual:
        datos.ingresos > 0
          ? Math.round(((datos.ingresos - datos.costo) / datos.ingresos) * 1000) / 10
          : null,
    }));

    return NextResponse.json({
      periodo: rango.etiqueta,
      masVendidos: [...ranking].sort((a, b) => b.unidadesVendidas - a.unidadesVendidas).slice(0, 10),
      masRentables: [...ranking].sort((a, b) => b.margen - a.margen).slice(0, 10),
      menosVendidos: [...ranking].sort((a, b) => a.unidadesVendidas - b.unidadesVendidas).slice(0, 10),
    });
  } catch (error) {
    return manejarErrorApi(error);
  }
}
