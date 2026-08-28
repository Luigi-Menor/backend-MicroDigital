import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requerirSesionDeNegocio, requerirRol } from "@/lib/tenant";
import { manejarErrorApi } from "@/lib/api-error";
import { ajustarStock } from "@/lib/inventario";

// MÓDULO 2 — Conteo físico / inventario cíclico: fija el stock a un valor
// absoluto (a diferencia de /movimientos, que trabaja con deltas).
const ajusteSchema = z.object({
  productoId: z.string().cuid(),
  varianteId: z.string().cuid().nullish(),
  stockFinal: z.number().int().nonnegative(),
  motivo: z.string().min(3, "El motivo del ajuste es obligatorio"),
});

export async function POST(req: NextRequest) {
  try {
    const sesion = await requerirSesionDeNegocio(req);
    requerirRol(sesion, "ADMINISTRADOR");
    const data = ajusteSchema.parse(await req.json());

    const movimiento = await prisma.$transaction((tx) =>
      ajustarStock(tx, {
        negocioId: sesion.negocioId,
        productoId: data.productoId,
        varianteId: data.varianteId,
        stockFinal: data.stockFinal,
        motivo: data.motivo,
        usuarioId: sesion.usuarioId,
      })
    );

    if (!movimiento) {
      return NextResponse.json({ mensaje: "El stock ya coincidía: no se registró ajuste" });
    }
    return NextResponse.json({ movimiento }, { status: 201 });
  } catch (error) {
    return manejarErrorApi(error);
  }
}
