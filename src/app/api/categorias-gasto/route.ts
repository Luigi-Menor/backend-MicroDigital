import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requerirSesionDeNegocio, requerirRol } from "@/lib/tenant";
import { manejarErrorApi } from "@/lib/api-error";

// MÓDULO 6 — Categorías de gasto (arriendo, servicios, nómina, insumos...).
const crearSchema = z.object({ nombre: z.string().min(2) });

export async function GET(req: NextRequest) {
  try {
    const sesion = await requerirSesionDeNegocio(req);
    const categorias = await prisma.categoriaGasto.findMany({
      where: { negocioId: sesion.negocioId },
      orderBy: { nombre: "asc" },
    });
    return NextResponse.json({ categorias });
  } catch (error) {
    return manejarErrorApi(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    const sesion = await requerirSesionDeNegocio(req);
    requerirRol(sesion, "ADMINISTRADOR");
    const { nombre } = crearSchema.parse(await req.json());

    const categoria = await prisma.categoriaGasto.create({
      data: { nombre, negocioId: sesion.negocioId },
    });
    return NextResponse.json({ categoria }, { status: 201 });
  } catch (error) {
    return manejarErrorApi(error);
  }
}
