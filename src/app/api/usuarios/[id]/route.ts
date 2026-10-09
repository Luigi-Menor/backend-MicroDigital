import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requerirSesionDeNegocio, requerirRol } from "@/lib/tenant";
import { manejarErrorApi, ErrorConflicto } from "@/lib/api-error";
import { ejecutarIdempotente } from "@/lib/idempotencia";

const actualizarSchema = z.object({
  nombre: z.string().min(2).optional(),
  activo: z.boolean().optional(),
  // RF-011: el administrador puede cambiar el rol de cualquier usuario de su negocio.
  rol: z.enum(["ADMINISTRADOR", "VENDEDOR"]).optional(),
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

    return await ejecutarIdempotente(
      req,
      { negocioId: sesion.negocioId, endpoint: `PUT /api/usuarios/${params.id}` },
      async () => {
        try {
          const data = actualizarSchema.parse(await req.json());

          const usuario = await prisma.usuario.findUnique({ where: { id: params.id } });
          if (!usuario || usuario.negocioId !== sesion.negocioId) {
            return NextResponse.json({ error: "Usuario no encontrado" }, { status: 404 });
          }
          if (usuario.rol === "SUPERADMIN") {
            return NextResponse.json({ error: "Usuario no encontrado" }, { status: 404 });
          }

          const cambiaRol = data.rol !== undefined && data.rol !== usuario.rol;
          const desactiva = data.activo === false && usuario.activo;
          if ((cambiaRol || desactiva) && usuario.id === sesion.usuarioId) {
            return NextResponse.json(
              { error: "No puedes cambiar tu propio rol ni desactivar tu propia cuenta" },
              { status: 409 }
            );
          }

          const actualizado = await prisma.$transaction(
            async (tx) => {
              // Un negocio nunca puede quedarse sin un administrador activo
              // (nadie podría gestionar usuarios ni catálogo). Se comprueba
              // dentro de una transacción serializable para que dos
              // administradores que se degradan a la vez no dejen cero.
              const dejaDeSerAdminActivo =
                usuario.rol === "ADMINISTRADOR" &&
                usuario.activo &&
                (data.rol === "VENDEDOR" || data.activo === false);
              if (dejaDeSerAdminActivo) {
                const otros = await tx.usuario.count({
                  where: {
                    negocioId: sesion.negocioId,
                    rol: "ADMINISTRADOR",
                    activo: true,
                    id: { not: usuario.id },
                  },
                });
                if (otros === 0) {
                  throw new ErrorConflicto("El negocio debe conservar al menos un administrador activo");
                }
              }

              return tx.usuario.update({
                where: { id: params.id },
                data: {
                  ...data,
                  fechaIngreso:
                    data.fechaIngreso !== undefined
                      ? data.fechaIngreso === null
                        ? null
                        : new Date(data.fechaIngreso)
                      : undefined,
                },
                select: SELECT_PUBLICO,
              });
            },
            { isolationLevel: "Serializable" }
          );
          return NextResponse.json({ usuario: actualizado });
        } catch (error) {
          return manejarErrorApi(error);
        }
      }
    );
  } catch (error) {
    return manejarErrorApi(error);
  }
}
