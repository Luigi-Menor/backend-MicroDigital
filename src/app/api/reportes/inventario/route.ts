import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requerirSesionDeNegocio } from "@/lib/tenant";
import { manejarErrorApi } from "@/lib/api-error";
import { aNumero } from "@/lib/dinero";
import { aCsv, quiereCsv, respuestaCsv } from "@/lib/http";

// MÓDULO 9 — Reporte de inventario: catálogo completo con valorización.
// GET /api/reportes/inventario[&formato=csv]
export async function GET(req: NextRequest) {
  try {
    const sesion = await requerirSesionDeNegocio(req);
    const params = req.nextUrl.searchParams;

    const productos = await prisma.producto.findMany({
      where: { negocioId: sesion.negocioId, activo: true },
      include: { categoria: { select: { nombre: true } }, variantes: { where: { activo: true } } },
      orderBy: { nombre: "asc" },
    });

    const filas: Array<{
      producto: string;
      categoria: string;
      tipo: string;
      stock: number;
      stockMinimo: number;
      precioVenta: number;
      precioCosto: number;
      valorCosto: number;
      valorVenta: number;
      stockBajo: string;
    }> = [];

    for (const p of productos) {
      const unidades = p.variantes.length > 0 ? p.variantes : [null];
      for (const v of unidades) {
        const stock = v ? v.stock : p.stock;
        const stockMinimo = v ? v.stockMinimo : p.stockMinimo;
        const precioVenta = aNumero(v?.precio ?? p.precio);
        const precioCosto = aNumero(v?.precioCosto ?? p.precioCosto ?? 0);
        filas.push({
          producto: v ? `${p.nombre} - ${v.nombre}` : p.nombre,
          categoria: p.categoria?.nombre ?? "",
          tipo: p.tipo,
          stock,
          stockMinimo,
          precioVenta,
          precioCosto,
          valorCosto: Math.round(stock * precioCosto * 100) / 100,
          valorVenta: Math.round(stock * precioVenta * 100) / 100,
          stockBajo: stock <= stockMinimo ? "SI" : "NO",
        });
      }
    }

    if (quiereCsv(params)) {
      const csv = aCsv(filas, [
        { clave: "producto", titulo: "Producto" },
        { clave: "categoria", titulo: "Categoría" },
        { clave: "tipo", titulo: "Tipo" },
        { clave: "stock", titulo: "Stock" },
        { clave: "stockMinimo", titulo: "Stock mínimo" },
        { clave: "precioVenta", titulo: "Precio venta" },
        { clave: "precioCosto", titulo: "Precio costo" },
        { clave: "valorCosto", titulo: "Valor a costo" },
        { clave: "valorVenta", titulo: "Valor a venta" },
        { clave: "stockBajo", titulo: "Stock bajo" },
      ]);
      return respuestaCsv(csv, "reporte_inventario.csv");
    }

    return NextResponse.json({
      totalItems: filas.length,
      valorTotalCosto: Math.round(filas.reduce((acc, f) => acc + f.valorCosto, 0) * 100) / 100,
      valorTotalVenta: Math.round(filas.reduce((acc, f) => acc + f.valorVenta, 0) * 100) / 100,
      items: filas,
    });
  } catch (error) {
    return manejarErrorApi(error);
  }
}
