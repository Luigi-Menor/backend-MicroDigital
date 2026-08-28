import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requerirSesionDeNegocio, requerirRol } from "@/lib/tenant";
import { manejarErrorApi } from "@/lib/api-error";

const crearSchema = z.object({ nombre: z.string().min(2) });

// GET /api/categorias — lista categorías del negocio de la sesión actual.
export async function GET(req: NextRequest) {
  try {
    const sesion = await requerirSesionDeNegocio(req);
    const categorias = await prisma.categoria.findMany({
      where: { negocioId: sesion.negocioId }, // <- aislamiento multi-tenant
      orderBy: { nombre: "asc" },
    });
    return NextResponse.json({ categorias });
  } catch (error) {
    return manejarErrorApi(error);
  }
}

// POST /api/categorias — solo Administrador (RF-006).
export async function POST(req: NextRequest) {
  try {
    const sesion = await requerirSesionDeNegocio(req);
    requerirRol(sesion, "ADMINISTRADOR");
    const { nombre } = crearSchema.parse(await req.json());

    const categoria = await prisma.categoria.create({
      data: { nombre, negocioId: sesion.negocioId },
    });
    return NextResponse.json({ categoria }, { status: 201 });
  } catch (error) {
    return manejarErrorApi(error);
  }
}
