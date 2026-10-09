import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requerirSesionDeNegocio, requerirRol } from "@/lib/tenant";
import { manejarErrorApi } from "@/lib/api-error";
import { recibirCompra } from "@/lib/compras";
import { ejecutarIdempotente } from "@/lib/idempotencia";

// MÓDULO 7 — Confirma la llegada de la mercancía: recién aquí se afecta
// el inventario (ver comentario de ciclo de vida en src/lib/compras.ts).
//
// Nota: recibirCompra ya es naturalmente idempotente vía el estado de la
// compra (RECIBIDA no puede recibirse otra vez, ver src/lib/compras.ts), pero
// igual se envuelve para que un reintento devuelva la MISMA respuesta en vez
// del error "ya fue recibida" cuando el primer intento sí tuvo éxito.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const sesion = await requerirSesionDeNegocio(req);
    requerirRol(sesion, "ADMINISTRADOR");

    return await ejecutarIdempotente(
      req,
      { negocioId: sesion.negocioId, endpoint: `POST /api/compras/${params.id}/recibir` },
      async () => {
        try {
          const compra = await prisma.$transaction((tx) =>
            recibirCompra(tx, { negocioId: sesion.negocioId, compraId: params.id, usuarioId: sesion.usuarioId })
          );

          return NextResponse.json({ compra });
        } catch (error) {
          return manejarErrorApi(error);
        }
      }
    );
  } catch (error) {
    return manejarErrorApi(error);
  }
}
