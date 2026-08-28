import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requerirSesionDeNegocio, requerirRol } from "@/lib/tenant";
import { manejarErrorApi, ErrorNoEncontrado } from "@/lib/api-error";

const actualizarSchema = z.object({
  nombre: z.string().min(2).optional(),
  activo: z.boolean().optional(),
});

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const sesion = await requerirSesionDeNegocio(req);
    requerirRol(sesion, "ADMINISTRADOR");
    const data = actualizarSchema.parse(await req.json());

    const existente = await prisma.categoria.findUnique({ where: { id: params.id } });
    if (!existente || existente.negocioId !== sesion.negocioId) {
      throw new ErrorNoEncontrado("Categoría no encontrada");
    }

    const categoria = await prisma.categoria.update({ where: { id: params.id }, data });
    return NextResponse.json({ categoria });
  } catch (error) {
    return manejarErrorApi(error);
  }
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const sesion = await requerirSesionDeNegocio(req);
    requerirRol(sesion, "ADMINISTRADOR");

    const existente = await prisma.categoria.findUnique({ where: { id: params.id } });
    if (!existente || existente.negocioId !== sesion.negocioId) {
      throw new ErrorNoEncontrado("Categoría no encontrada");
    }

    const tieneProductos = await prisma.producto.findFirst({
      where: { categoriaId: params.id },
      select: { id: true },
    });

    if (tieneProductos) {
      const categoria = await prisma.categoria.update({
        where: { id: params.id },
        data: { activo: false },
      });
      return NextResponse.json({
        categoria,
        mensaje: "La categoría tiene productos: se desactivó en vez de eliminarse",
      });
    }

    await prisma.categoria.delete({ where: { id: params.id } });
    return NextResponse.json({ mensaje: "Categoría eliminada" });
  } catch (error) {
    return manejarErrorApi(error);
  }
}
