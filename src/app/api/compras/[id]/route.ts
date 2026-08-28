import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requerirSesionDeNegocio, requerirRol } from "@/lib/tenant";
import { manejarErrorApi, ErrorNoEncontrado } from "@/lib/api-error";
import { anularCompra } from "@/lib/compras";

// GET /api/compras/:id  -> detalle
// PUT /api/compras/:id  -> { accion: "ANULAR", motivo }
const accionSchema = z.object({
  accion: z.literal("ANULAR"),
  motivo: z.string().min(3, "El motivo de la anulación es obligatorio"),
});

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const sesion = await requerirSesionDeNegocio(req);
    const compra = await prisma.compra.findFirst({
      where: { id: params.id, negocioId: sesion.negocioId },
      include: {
        proveedor: true,
        detalles: { include: { producto: true, variante: true } },
        pagos: { orderBy: { createdAt: "desc" } },
        usuario: { select: { id: true, nombre: true } },
      },
    });
    if (!compra) throw new ErrorNoEncontrado("Compra no encontrada");
    return NextResponse.json({ compra });
  } catch (error) {
    return manejarErrorApi(error);
  }
}

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const sesion = await requerirSesionDeNegocio(req);
    requerirRol(sesion, "ADMINISTRADOR");
    const { motivo } = accionSchema.parse(await req.json());

    const compra = await prisma.$transaction((tx) =>
      anularCompra(tx, {
        negocioId: sesion.negocioId,
        compraId: params.id,
        usuarioId: sesion.usuarioId,
        motivo,
      })
    );

    return NextResponse.json({ compra });
  } catch (error) {
    return manejarErrorApi(error);
  }
}
