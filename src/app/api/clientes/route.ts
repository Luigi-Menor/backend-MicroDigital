import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requerirSesionDeNegocio } from "@/lib/tenant";
import { manejarErrorApi } from "@/lib/api-error";
import { metaPaginacion, parsePaginacion, leerBooleano } from "@/lib/http";

// MÓDULO 4 — Clientes.
const crearSchema = z.object({
  nombre: z.string().min(2),
  contacto: z.string().optional(),
  email: z.string().email().optional(),
  documento: z.string().optional(),
  direccion: z.string().optional(),
  notas: z.string().optional(),
  limiteCredito: z.number().nonnegative().nullish(),
});

// GET /api/clientes — lista de clientes del negocio, con su saldo de deuda ("fiado").
export async function GET(req: NextRequest) {
  try {
    const sesion = await requerirSesionDeNegocio(req);
    const params = req.nextUrl.searchParams;
    const paginacion = parsePaginacion(params);

    const busqueda = params.get("q");
    const activo = leerBooleano(params.get("activo"));
    const conDeuda = leerBooleano(params.get("conDeuda"));

    const where: Prisma.ClienteWhereInput = {
      negocioId: sesion.negocioId,
      ...(activo !== undefined ? { activo } : {}),
      ...(conDeuda ? { saldoDeuda: { gt: 0 } } : {}),
      ...(busqueda
        ? {
            OR: [
              { nombre: { contains: busqueda, mode: "insensitive" } },
              { contacto: { contains: busqueda, mode: "insensitive" } },
              { documento: { contains: busqueda, mode: "insensitive" } },
            ],
          }
        : {}),
    };

    const [clientes, total] = await Promise.all([
      prisma.cliente.findMany({
        where,
        orderBy: { nombre: "asc" },
        skip: paginacion.skip,
        take: paginacion.limite,
      }),
      prisma.cliente.count({ where }),
    ]);

    return NextResponse.json({ clientes, meta: metaPaginacion(total, paginacion) });
  } catch (error) {
    return manejarErrorApi(error);
  }
}

// POST /api/clientes — Administrador o Vendedor pueden registrar clientes.
export async function POST(req: NextRequest) {
  try {
    const sesion = await requerirSesionDeNegocio(req);
    const data = crearSchema.parse(await req.json());

    const cliente = await prisma.cliente.create({
      data: { ...data, negocioId: sesion.negocioId },
    });
    return NextResponse.json({ cliente }, { status: 201 });
  } catch (error) {
    return manejarErrorApi(error);
  }
}
