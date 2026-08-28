import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requerirSesionDeNegocio } from "@/lib/tenant";
import { manejarErrorApi } from "@/lib/api-error";
import { aNumero } from "@/lib/dinero";
import { tramoAntiguedad } from "@/lib/fiados";
import { metaPaginacion, parsePaginacion, quiereCsv, respuestaCsv, aCsv } from "@/lib/http";

// MÓDULO 5 — Fiados / cuentas por cobrar: cartera consolidada por cliente.
// GET /api/fiados -> clientes con saldoDeuda > 0, con antigüedad de la deuda más vieja
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
          select: { id: true, numero: true, createdAt: true, total: true, saldoPendiente: true },
        },
      },
    });

    const cartera = clientes.map((c) => {
      const ventaMasAntigua = c.ventas[0] ?? null;
      return {
        clienteId: c.id,
        nombre: c.nombre,
        contacto: c.contacto,
        saldoDeuda: aNumero(c.saldoDeuda),
        limiteCredito: c.limiteCredito ? aNumero(c.limiteCredito) : null,
        ventasPendientes: c.ventas.length,
        tramoAntiguedad: ventaMasAntigua ? tramoAntiguedad(ventaMasAntigua.createdAt) : null,
        deudaDesde: ventaMasAntigua?.createdAt ?? null,
      };
    });

    const totalCartera = cartera.reduce((acc, c) => acc + c.saldoDeuda, 0);
    const porTramo: Record<string, number> = { "0-30": 0, "31-60": 0, "61-90": 0, "90+": 0 };
    for (const c of cartera) {
      if (c.tramoAntiguedad) porTramo[c.tramoAntiguedad] = (porTramo[c.tramoAntiguedad] ?? 0) + c.saldoDeuda;
    }

    if (quiereCsv(params)) {
      const csv = aCsv(
        cartera.map((c) => ({ ...c, deudaDesde: c.deudaDesde ?? "" })),
        [
          { clave: "nombre", titulo: "Cliente" },
          { clave: "contacto", titulo: "Contacto" },
          { clave: "saldoDeuda", titulo: "Saldo" },
          { clave: "ventasPendientes", titulo: "Ventas pendientes" },
          { clave: "tramoAntiguedad", titulo: "Antigüedad" },
          { clave: "deudaDesde", titulo: "Deuda desde" },
        ]
      );
      return respuestaCsv(csv, "cartera_fiados.csv");
    }

    const paginacion = parsePaginacion(params);
    const pagina = cartera.slice(paginacion.skip, paginacion.skip + paginacion.limite);

    return NextResponse.json({
      totalCartera,
      porTramo,
      clientes: pagina,
      meta: metaPaginacion(cartera.length, paginacion),
    });
  } catch (error) {
    return manejarErrorApi(error);
  }
}
