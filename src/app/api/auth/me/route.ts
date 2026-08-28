import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requerirSesion } from "@/lib/tenant";
import { manejarErrorApi } from "@/lib/api-error";

// GET /api/auth/me — usado por el frontend (layout del dashboard, panel de
// superadmin) para saber quién es el usuario en sesión sin acceso directo a
// la base de datos.
export async function GET(req: NextRequest) {
  try {
    const sesion = await requerirSesion(req);

    const negocio = sesion.negocioId
      ? await prisma.negocio.findUnique({
          where: { id: sesion.negocioId },
          select: { id: true, nombre: true },
        })
      : null;

    return NextResponse.json({
      usuario: { id: sesion.usuarioId, email: sesion.email, rol: sesion.rol },
      negocio,
    });
  } catch (error) {
    return manejarErrorApi(error);
  }
}
