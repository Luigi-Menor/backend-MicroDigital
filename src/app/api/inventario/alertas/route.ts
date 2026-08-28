import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requerirSesionDeNegocio } from "@/lib/tenant";
import { manejarErrorApi } from "@/lib/api-error";
import { aNumero } from "@/lib/dinero";

// MÓDULO 2 — RF-008: productos y variantes con stock <= stockMinimo.
// GET /api/inventario/alertas
export async function GET(req: NextRequest) {
  try {
    const sesion = await requerirSesionDeNegocio(req);

    // Prisma no permite comparar dos columnas de la misma fila en `where`
    // (stock <= stockMinimo), así que se trae el universo de productos
    // activos con stock y se filtra en memoria. Es aceptable: el catálogo de
    // un micronegocio son decenas o cientos de ítems, no millones.
    const productos = await prisma.producto.findMany({
      where: { negocioId: sesion.negocioId, activo: true, tipo: "PRODUCTO" },
      include: { categoria: { select: { nombre: true } }, variantes: { where: { activo: true } } },
    });

    const alertas: Array<{
      productoId: string;
      varianteId: string | null;
      nombre: string;
      categoria: string | null;
      stock: number;
      stockMinimo: number;
      faltante: number;
    }> = [];

    for (const p of productos) {
      if (p.variantes.length > 0) {
        for (const v of p.variantes) {
          if (v.stock <= v.stockMinimo) {
            alertas.push({
              productoId: p.id,
              varianteId: v.id,
              nombre: `${p.nombre} - ${v.nombre}`,
              categoria: p.categoria?.nombre ?? null,
              stock: v.stock,
              stockMinimo: v.stockMinimo,
              faltante: Math.max(0, v.stockMinimo - v.stock),
            });
          }
        }
      } else if (p.stock <= p.stockMinimo) {
        alertas.push({
          productoId: p.id,
          varianteId: null,
          nombre: p.nombre,
          categoria: p.categoria?.nombre ?? null,
          stock: p.stock,
          stockMinimo: p.stockMinimo,
          faltante: Math.max(0, p.stockMinimo - p.stock),
        });
      }
    }

    alertas.sort((a, b) => b.faltante - a.faltante);

    // Valorización del inventario completo (a costo), útil junto a la
    // alerta para dimensionar cuánto capital está inmovilizado en existencias.
    const valorizacion = await prisma.$queryRaw<Array<{ valor: string | null }>>`
      SELECT SUM(COALESCE(pv.stock, p.stock) * COALESCE(pv."precioCosto", p."precioCosto", 0))::text AS valor
      FROM "productos" p
      LEFT JOIN "producto_variantes" pv ON pv."productoId" = p.id AND pv.activo = true
      WHERE p."negocioId" = ${sesion.negocioId} AND p.tipo = 'PRODUCTO' AND p.activo = true
    `;

    return NextResponse.json({
      total: alertas.length,
      alertas,
      valorInventario: aNumero(valorizacion[0]?.valor ?? 0),
    });
  } catch (error) {
    return manejarErrorApi(error);
  }
}
