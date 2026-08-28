import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requerirSesionDeNegocio, requerirRol } from "@/lib/tenant";
import { manejarErrorApi } from "@/lib/api-error";

const actualizarSchema = z.object({
  nombre: z.string().min(2).optional(),
  activo: z.boolean().optional(),
  telefono: z.string().nullable().optional(),
  documento: z.string().nullable().optional(),
  cargo: z.string().nullable().optional(),
  fechaIngreso: z.string().nullable().optional(),
  salarioBase: z.number().nonnegative().nullable().optional(),
  metaVentasMensual: z.number().nonnegative().nullable().optional(),
});

const SELECT_PUBLICO = {
  id: true,
  nombre: true,
  email: true,
  rol: true,
  activo: true,
  telefono: true,
  documento: true,
  cargo: true,
  fechaIngreso: true,
  salarioBase: true,
  metaVentasMensual: true,
  createdAt: true,
} as const;

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const sesion = await requerirSesionDeNegocio(req);
    requerirRol(sesion, "ADMINISTRADOR");

    const usuario = await prisma.usuario.findUnique({
      where: { id: params.id },
      select: { ...SELECT_PUBLICO, negocioId: true },
    });
    if (!usuario || usuario.negocioId !== sesion.negocioId) {
      return NextResponse.json({ error: "Usuario no encontrado" }, { status: 404 });
    }
    const { negocioId: _negocioId, ...usuarioPublico } = usuario;
    return NextResponse.json({ usuario: usuarioPublico });
  } catch (error) {
    return manejarErrorApi(error);
  }
}

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const sesion = await requerirSesionDeNegocio(req);
    requerirRol(sesion, "ADMINISTRADOR");
    const data = actualizarSchema.parse(await req.json());

    const usuario = await prisma.usuario.findUnique({ where: { id: params.id } });
    if (!usuario || usuario.negocioId !== sesion.negocioId) {
      return NextResponse.json({ error: "Usuario no encontrado" }, { status: 404 });
    }
    if (usuario.rol !== "VENDEDOR") {
      return NextResponse.json(
        { error: "Solo se pueden editar usuarios con rol Vendedor" },
        { status: 403 }
      );
    }

    const actualizado = await prisma.usuario.update({
      where: { id: params.id },
      data: {
        ...data,
        fechaIngreso: data.fechaIngreso !== undefined
          ? data.fechaIngreso === null ? null : new Date(data.fechaIngreso)
          : undefined,
      },
      select: SELECT_PUBLICO,
    });
    return NextResponse.json({ usuario: actualizado });
  } catch (error) {
    return manejarErrorApi(error);
  }
}
