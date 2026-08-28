import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requerirSesionDeNegocio } from "@/lib/tenant";
import { manejarErrorApi } from "@/lib/api-error";

function inicioDe(periodo: "dia" | "semana" | "mes"): Date {
  const ahora = new Date();
  if (periodo === "dia") {
    return new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate());
  }
  if (periodo === "semana") {
    const dia = ahora.getDay() || 7; // lunes = 1 ... domingo = 7
    const inicio = new Date(ahora);
    inicio.setDate(ahora.getDate() - dia + 1);
    inicio.setHours(0, 0, 0, 0);
    return inicio;
  }
  return new Date(ahora.getFullYear(), ahora.getMonth(), 1);
}

// GET /api/dashboard — RF-013.
// El rol Vendedor NO recibe indicadores financieros (confirmado en el
// levantamiento: "el Vendedor ve solo ventas e inventario").
export async function GET(req: NextRequest) {
  try {
    const sesion = await requerirSesionDeNegocio(req);
    const negocioId = sesion.negocioId;

    // Se listan las tres promesas explícitamente (en vez de `.map` sobre un
    // array) para que TypeScript infiera una tupla de longitud fija: con
    // `noUncheckedIndexedAccess`, destructurar desde `Aggregate[]` (el tipo
    // que deja `.map`) marca cada elemento como posiblemente `undefined`.
    const agregado = (periodo: "dia" | "semana" | "mes") =>
      prisma.venta.aggregate({
        where: { negocioId, estado: { not: "ANULADA" }, createdAt: { gte: inicioDe(periodo) } },
        _sum: { total: true },
        _count: true,
      });

    const [ventasDia, ventasSemana, ventasMes] = await Promise.all([
      agregado("dia"),
      agregado("semana"),
      agregado("mes"),
    ]);

    const detallesRecientes = await prisma.ventaDetalle.groupBy({
      by: ["productoId"],
      where: { venta: { negocioId, estado: { not: "ANULADA" } } },
      _sum: { cantidad: true },
      orderBy: { _sum: { cantidad: "desc" } },
      take: 1,
    });

    let productoMasVendido = null;
    if (detallesRecientes[0]) {
      const producto = await prisma.producto.findUnique({
        where: { id: detallesRecientes[0].productoId },
      });
      productoMasVendido = producto
        ? { nombre: producto.nombre, unidadesVendidas: detallesRecientes[0]._sum.cantidad }
        : null;
    }

    const base = {
      ventasHoy: { total: ventasDia._count, monto: ventasDia._sum.total ?? 0 },
      ventasSemana: { total: ventasSemana._count, monto: ventasSemana._sum.total ?? 0 },
      ventasMes: { total: ventasMes._count, monto: ventasMes._sum.total ?? 0 },
      productoMasVendido,
    };

    if (sesion.rol === "VENDEDOR") {
      // Se ocultan explícitamente los montos financieros para el Vendedor.
      const { ventasHoy, ventasSemana, ventasMes, productoMasVendido } = base;
      return NextResponse.json({
        ventasHoy: { total: ventasHoy.total },
        ventasSemana: { total: ventasSemana.total },
        ventasMes: { total: ventasMes.total },
        productoMasVendido,
      });
    }

    // Administrador: incluye balance simple (ingresos pagados vs. saldo por fiados).
    const [ingresosPagados, saldoFiados] = await Promise.all([
      prisma.venta.aggregate({
        where: { negocioId, estado: { not: "ANULADA" }, formaPago: { in: ["EFECTIVO", "TRANSFERENCIA"] } },
        _sum: { total: true },
      }),
      prisma.cliente.aggregate({ where: { negocioId }, _sum: { saldoDeuda: true } }),
    ]);

    return NextResponse.json({
      ...base,
      balance: {
        ingresosPagados: ingresosPagados._sum.total ?? 0,
        saldoPendienteFiados: saldoFiados._sum.saldoDeuda ?? 0,
      },
    });
  } catch (error) {
    return manejarErrorApi(error);
  }
}
