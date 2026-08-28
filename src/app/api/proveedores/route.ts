import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requerirSesionDeNegocio, requerirRol } from "@/lib/tenant";
import { manejarErrorApi } from "@/lib/api-error";
import { metaPaginacion, parsePaginacion, leerBooleano } from "@/lib/http";

// MÓDULO 7 — Proveedores.
const crearSchema = z.object({
  nombre: z.string().min(2),
  contacto: z.string().optional(),
  email: z.string().email().optional(),
  telefono: z.string().optional(),
  nit: z.string().optional(),
  direccion: z.string().optional(),
  notas: z.string().optional(),
});

export async function GET(req: NextRequest) {
  try {
    const sesion = await requerirSesionDeNegocio(req);
    const params = req.nextUrl.searchParams;
    const paginacion = parsePaginacion(params);
    const busqueda = params.get("q");
    const activo = leerBooleano(params.get("activo"));

    const where: Prisma.ProveedorWhereInput = {
      negocioId: sesion.negocioId,
      ...(activo !== undefined ? { activo } : {}),
      ...(busqueda
        ? {
            OR: [
              { nombre: { contains: busqueda, mode: "insensitive" } },
              { nit: { contains: busqueda, mode: "insensitive" } },
            ],
          }
        : {}),
    };

    const [proveedores, total] = await Promise.all([
      prisma.proveedor.findMany({
        where,
        orderBy: { nombre: "asc" },
        skip: paginacion.skip,
        take: paginacion.limite,
      }),
      prisma.proveedor.count({ where }),
    ]);

    return NextResponse.json({ proveedores, meta: metaPaginacion(total, paginacion) });
  } catch (error) {
    return manejarErrorApi(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    const sesion = await requerirSesionDeNegocio(req);
    requerirRol(sesion, "ADMINISTRADOR");
    const data = crearSchema.parse(await req.json());

    const proveedor = await prisma.proveedor.create({
      data: { ...data, negocioId: sesion.negocioId },
    });
    return NextResponse.json({ proveedor }, { status: 201 });
  } catch (error) {
    return manejarErrorApi(error);
  }
}
