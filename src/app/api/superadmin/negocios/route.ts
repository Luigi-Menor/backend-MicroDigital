import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requerirSesion, requerirRol } from "@/lib/tenant";
import { manejarErrorApi } from "@/lib/api-error";

// RF-005 — Solo actividad básica (fecha de registro, total de ventas, última
// actividad). Explícitamente SIN datos financieros (confirmado en el
// levantamiento). No exponer aquí totales monetarios ni saldos.
export async function GET(req: NextRequest) {
  try {
    const sesion = await requerirSesion(req);
    requerirRol(sesion, "SUPERADMIN");

    const negocios = await prisma.negocio.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        nombre: true,
        tipoNegocio: true,
        createdAt: true,
        _count: { select: { ventas: true } },
        ventas: {
          select: { createdAt: true },
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
    });

    const resultado = negocios.map((n) => ({
      id: n.id,
      nombre: n.nombre,
      tipoNegocio: n.tipoNegocio,
      fechaRegistro: n.createdAt,
      totalVentas: n._count.ventas,
      ultimaActividad: n.ventas[0]?.createdAt ?? null,
    }));

    return NextResponse.json({ negocios: resultado });
  } catch (error) {
    return manejarErrorApi(error);
  }
}
