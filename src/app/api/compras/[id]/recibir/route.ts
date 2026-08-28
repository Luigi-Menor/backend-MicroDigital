import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requerirSesionDeNegocio, requerirRol } from "@/lib/tenant";
import { manejarErrorApi } from "@/lib/api-error";
import { recibirCompra } from "@/lib/compras";

// MÓDULO 7 — Confirma la llegada de la mercancía: recién aquí se afecta
// el inventario (ver comentario de ciclo de vida en src/lib/compras.ts).
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const sesion = await requerirSesionDeNegocio(req);
    requerirRol(sesion, "ADMINISTRADOR");

    const compra = await prisma.$transaction((tx) =>
      recibirCompra(tx, { negocioId: sesion.negocioId, compraId: params.id, usuarioId: sesion.usuarioId })
    );

    return NextResponse.json({ compra });
  } catch (error) {
    return manejarErrorApi(error);
  }
}
