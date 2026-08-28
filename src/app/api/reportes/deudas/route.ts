import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requerirSesionDeNegocio } from "@/lib/tenant";
import { manejarErrorApi } from "@/lib/api-error";
import { aNumero } from "@/lib/dinero";
import { tramoAntiguedad } from "@/lib/fiados";
import { aCsv, quiereCsv, respuestaCsv } from "@/lib/http";

// MÓDULO 9 — Reporte de deudas (RF: "reportes de ventas, inventario y
// deudas"). Es la misma cartera de /api/fiados, expuesta también aquí para
// que quede junto a los demás reportes exportables del módulo.
// GET /api/reportes/deudas[&formato=csv]
export async function GET(req: NextRequest) {
  try {
    const sesion = await requerirSesionDeNegocio(req);
    const params = req.nextUrl.searchParams;

    const clientes = await prisma.cliente.findMany({
      where: { negocioId: sesion.negocioId, saldoDeuda: { gt: 0 } },
      orderBy: { saldoDeuda: "desc" },
      include: {
        ventas: {
          where: { estado: { not: "ANULADA" }, saldoPendiente: { gt: 0 } },
          orderBy: { createdAt: "asc" },
          select: { createdAt: true },
        },
      },
    });

    const filas = clientes.map((c) => {
      const masAntigua = c.ventas[0]?.createdAt ?? null;
      return {
        cliente: c.nombre,
        contacto: c.contacto ?? "",
        saldoDeuda: aNumero(c.saldoDeuda),
        ventasPendientes: c.ventas.length,
        deudaDesde: masAntigua ?? "",
        antiguedad: masAntigua ? tramoAntiguedad(masAntigua) : "",
      };
    });

    if (quiereCsv(params)) {
      const csv = aCsv(filas, [
        { clave: "cliente", titulo: "Cliente" },
        { clave: "contacto", titulo: "Contacto" },
        { clave: "saldoDeuda", titulo: "Saldo" },
        { clave: "ventasPendientes", titulo: "Ventas pendientes" },
        { clave: "deudaDesde", titulo: "Deuda desde" },
        { clave: "antiguedad", titulo: "Antigüedad" },
      ]);
      return respuestaCsv(csv, "reporte_deudas.csv");
    }

    return NextResponse.json({
      totalClientesConDeuda: filas.length,
      totalCartera: Math.round(filas.reduce((acc, f) => acc + f.saldoDeuda, 0) * 100) / 100,
      clientes: filas,
    });
  } catch (error) {
    return manejarErrorApi(error);
  }
}
