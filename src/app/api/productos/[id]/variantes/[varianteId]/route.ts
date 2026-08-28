import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requerirSesionDeNegocio, requerirRol } from "@/lib/tenant";
import { manejarErrorApi, ErrorNoEncontrado } from "@/lib/api-error";
import { sincronizarStockPadre } from "@/lib/inventario";

const actualizarSchema = z.object({
  nombre: z.string().min(1).optional(),
  sku: z.string().nullable().optional(),
  precio: z.number().positive().nullable().optional(),
  precioCosto: z.number().nonnegative().nullable().optional(),
  stockMinimo: z.number().int().nonnegative().optional(),
  activo: z.boolean().optional(),
});

async function varianteDelNegocio(varianteId: string, productoId: string, negocioId: string) {
  const variante = await prisma.productoVariante.findUnique({
    where: { id: varianteId },
    include: { producto: true },
  });
  if (!variante || variante.productoId !== productoId || variante.producto.negocioId !== negocioId) {
    return null;
  }
  return variante;
}

export async function PUT(
  req: NextRequest,
  { params }: { params: { id: string; varianteId: string } }
) {
  try {
    const sesion = await requerirSesionDeNegocio(req);
    requerirRol(sesion, "ADMINISTRADOR");
    const data = actualizarSchema.parse(await req.json());

    const existente = await varianteDelNegocio(params.varianteId, params.id, sesion.negocioId);
    if (!existente) throw new ErrorNoEncontrado("Variante no encontrada");

    // El stock tampoco se edita aquí: ver la misma nota en productos/[id].
    const variante = await prisma.productoVariante.update({
      where: { id: params.varianteId },
      data,
    });
    return NextResponse.json({ variante });
  } catch (error) {
    return manejarErrorApi(error);
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string; varianteId: string } }
) {
  try {
    const sesion = await requerirSesionDeNegocio(req);
    requerirRol(sesion, "ADMINISTRADOR");

    const existente = await varianteDelNegocio(params.varianteId, params.id, sesion.negocioId);
    if (!existente) throw new ErrorNoEncontrado("Variante no encontrada");

    const tieneHistorial = await prisma.ventaDetalle.findFirst({
      where: { varianteId: params.varianteId },
      select: { id: true },
    });

    await prisma.$transaction(async (tx) => {
      if (tieneHistorial) {
        await tx.productoVariante.update({
          where: { id: params.varianteId },
          data: { activo: false },
        });
      } else {
        await tx.productoVariante.delete({ where: { id: params.varianteId } });
      }
      await sincronizarStockPadre(tx, params.id);
    });

    return NextResponse.json({
      mensaje: tieneHistorial
        ? "La variante tiene ventas registradas: se desactivó en vez de eliminarse"
        : "Variante eliminada",
    });
  } catch (error) {
    return manejarErrorApi(error);
  }
}
