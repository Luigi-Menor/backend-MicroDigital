import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requerirSesionDeNegocio, requerirRol } from "@/lib/tenant";
import { manejarErrorApi } from "@/lib/api-error";
import { recalcularSaldoCliente } from "@/lib/fiados";
import { aNumero } from "@/lib/dinero";

// MÓDULO 5 — Reparación de la invariante Cliente.saldoDeuda == SUM(ventas
// pendientes). Solo Administrador: es una operación de corrección de datos,
// no una del flujo normal del día a día.
const schema = z.object({ clienteId: z.string().cuid() });

export async function POST(req: NextRequest) {
  try {
    const sesion = await requerirSesionDeNegocio(req);
    requerirRol(sesion, "ADMINISTRADOR");
    const { clienteId } = schema.parse(await req.json());

    const saldo = await prisma.$transaction((tx) =>
      recalcularSaldoCliente(tx, sesion.negocioId, clienteId)
    );

    return NextResponse.json({ clienteId, saldoDeuda: aNumero(saldo) });
  } catch (error) {
    return manejarErrorApi(error);
  }
}
