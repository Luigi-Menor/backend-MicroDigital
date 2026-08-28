import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requerirSesionDeNegocio, requerirRol } from "@/lib/tenant";
import { manejarErrorApi } from "@/lib/api-error";
import { resolverRango, filtroFechas } from "@/lib/periodo";
import { aNumero } from "@/lib/dinero";

// MÓDULO 8 — Rendimiento general del negocio: ingresos, gastos y utilidad.
// Solo Administrador: cruza información financiera que un Vendedor no ve
// (mismo criterio que el dashboard, ver RF-013).
// GET /api/estadisticas/general?periodo=mes
export async function GET(req: NextRequest) {
  try {
    const sesion = await requerirSesionDeNegocio(req);
    requerirRol(sesion, "ADMINISTRADOR");
    const rango = resolverRango(req.nextUrl.searchParams);
    const filtroPeriodo = filtroFechas(rango);

    const [ventas, detallesVenta, gastos, comprasRecibidas, cartera, saldoProveedores] = await Promise.all([
      prisma.venta.aggregate({
        where: { negocioId: sesion.negocioId, estado: { not: "ANULADA" }, createdAt: filtroPeriodo },
        _sum: { total: true },
        _count: true,
      }),
      // El costo de ventas real (ponderado por cantidad) no sale de un solo
      // `_sum`: costoUnitario * cantidad no es agregable directamente sobre
      // dos columnas, así que se trae el detalle y se pondera en memoria.
      prisma.ventaDetalle.findMany({
        where: { venta: { negocioId: sesion.negocioId, estado: { not: "ANULADA" }, createdAt: filtroPeriodo } },
        select: { cantidad: true, costoUnitario: true },
      }),
      prisma.gasto.aggregate({
        where: { negocioId: sesion.negocioId, fecha: filtroPeriodo },
        _sum: { monto: true },
      }),
      prisma.compra.aggregate({
        where: { negocioId: sesion.negocioId, estado: "RECIBIDA", fecha: filtroPeriodo },
        _sum: { total: true },
      }),
      prisma.cliente.aggregate({ where: { negocioId: sesion.negocioId }, _sum: { saldoDeuda: true } }),
      prisma.proveedor.aggregate({ where: { negocioId: sesion.negocioId }, _sum: { saldoDeuda: true } }),
    ]);

    const costoVentasTotal = detallesVenta.reduce(
      (acc, d) => acc + aNumero(d.costoUnitario) * d.cantidad,
      0
    );

    const ingresos = aNumero(ventas._sum.total);
    const totalGastos = aNumero(gastos._sum.monto);
    const utilidadBruta = Math.round((ingresos - costoVentasTotal) * 100) / 100;
    const utilidadNeta = Math.round((utilidadBruta - totalGastos) * 100) / 100;

    return NextResponse.json({
      periodo: rango.etiqueta,
      desde: rango.desde,
      hasta: rango.hasta,
      ingresos,
      numeroVentas: ventas._count,
      costoVentas: Math.round(costoVentasTotal * 100) / 100,
      utilidadBruta,
      gastos: totalGastos,
      utilidadNeta,
      margenNetoPorcentual: ingresos > 0 ? Math.round((utilidadNeta / ingresos) * 1000) / 10 : null,
      comprasRecibidas: aNumero(comprasRecibidas._sum.total),
      cuentasPorCobrar: aNumero(cartera._sum.saldoDeuda),
      cuentasPorPagar: aNumero(saldoProveedores._sum.saldoDeuda),
      // El costo de ventas depende de `precioCosto` estar cargado en el
      // catálogo al momento de vender; si un producto no tenía costo, su
      // costo se computa como 0 y el margen queda sobreestimado para esa línea.
      costoVentasEsAproximado:
        "Se calcula con el costoUnitario congelado en cada venta; los productos sin precioCosto cargado cuentan como costo 0",
    });
  } catch (error) {
    return manejarErrorApi(error);
  }
}
