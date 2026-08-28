import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requerirSesionDeNegocio } from "@/lib/tenant";
import { manejarErrorApi } from "@/lib/api-error";
import { resolverRango, filtroFechas } from "@/lib/periodo";
import { aNumero } from "@/lib/dinero";
import { aCsv, quiereCsv, respuestaCsv } from "@/lib/http";

// MÓDULO 9 — Reporte de ventas del período, detalle línea por venta.
// GET /api/reportes/ventas?periodo=mes[&formato=csv]
export async function GET(req: NextRequest) {
  try {
    const sesion = await requerirSesionDeNegocio(req);
    const params = req.nextUrl.searchParams;
    const rango = resolverRango(params);

    const ventas = await prisma.venta.findMany({
      where: { negocioId: sesion.negocioId, createdAt: filtroFechas(rango) },
      include: {
        cliente: { select: { nombre: true } },
        usuario: { select: { nombre: true } },
        detalles: { select: { cantidad: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 5000, // tope defensivo, ver misma nota en /api/inventario/movimientos
    });

    const filas = ventas.map((v) => ({
      numero: v.numero,
      fecha: v.createdAt,
      cliente: v.cliente?.nombre ?? "Consumidor final",
      vendedor: v.usuario.nombre,
      formaPago: v.formaPago,
      estado: v.estado,
      items: v.detalles.reduce((acc, d) => acc + d.cantidad, 0),
      subtotal: aNumero(v.subtotal),
      descuento: aNumero(v.descuento),
      impuesto: aNumero(v.impuesto),
      total: aNumero(v.total),
      saldoPendiente: aNumero(v.saldoPendiente),
    }));

    if (quiereCsv(params)) {
      const csv = aCsv(filas, [
        { clave: "numero", titulo: "N°" },
        { clave: "fecha", titulo: "Fecha" },
        { clave: "cliente", titulo: "Cliente" },
        { clave: "vendedor", titulo: "Vendedor" },
        { clave: "formaPago", titulo: "Forma de pago" },
        { clave: "estado", titulo: "Estado" },
        { clave: "items", titulo: "Ítems" },
        { clave: "subtotal", titulo: "Subtotal" },
        { clave: "descuento", titulo: "Descuento" },
        { clave: "impuesto", titulo: "Impuesto" },
        { clave: "total", titulo: "Total" },
        { clave: "saldoPendiente", titulo: "Saldo pendiente" },
      ]);
      return respuestaCsv(csv, "reporte_ventas.csv");
    }

    const activas = filas.filter((f) => f.estado !== "ANULADA");
    return NextResponse.json({
      periodo: rango.etiqueta,
      desde: rango.desde,
      hasta: rango.hasta,
      totalVentas: activas.length,
      montoTotal: Math.round(activas.reduce((acc, f) => acc + f.total, 0) * 100) / 100,
      ventas: filas,
    });
  } catch (error) {
    return manejarErrorApi(error);
  }
}
