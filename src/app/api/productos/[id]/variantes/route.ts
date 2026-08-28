import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requerirSesionDeNegocio, requerirRol } from "@/lib/tenant";
import { manejarErrorApi, ErrorNoEncontrado, ErrorDominio } from "@/lib/api-error";
import { sincronizarStockPadre } from "@/lib/inventario";

// MÓDULO 3 — Variantes de un producto (talla, color, presentación...).
const crearVarianteSchema = z.object({
  nombre: z.string().min(1),
  sku: z.string().optional(),
  precio: z.number().positive().optional(),
  precioCosto: z.number().nonnegative().optional(),
  stock: z.number().int().nonnegative().default(0),
  stockMinimo: z.number().int().nonnegative().default(0),
});

async function productoDelNegocio(id: string, negocioId: string) {
  const producto = await prisma.producto.findUnique({ where: { id } });
  if (!producto || producto.negocioId !== negocioId) return null;
  return producto;
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const sesion = await requerirSesionDeNegocio(req);
    const producto = await productoDelNegocio(params.id, sesion.negocioId);
    if (!producto) throw new ErrorNoEncontrado("Producto no encontrado");

    const variantes = await prisma.productoVariante.findMany({
      where: { productoId: params.id },
      orderBy: { nombre: "asc" },
    });
    return NextResponse.json({ variantes });
  } catch (error) {
    return manejarErrorApi(error);
  }
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const sesion = await requerirSesionDeNegocio(req);
    requerirRol(sesion, "ADMINISTRADOR");
    const data = crearVarianteSchema.parse(await req.json());

    const producto = await productoDelNegocio(params.id, sesion.negocioId);
    if (!producto) throw new ErrorNoEncontrado("Producto no encontrado");
    if (producto.tipo === "SERVICIO") {
      throw new ErrorDominio("Un servicio no admite variantes con stock");
    }

    const variante = await prisma.$transaction(async (tx) => {
      const creada = await tx.productoVariante.create({
        data: { ...data, productoId: params.id },
      });
      // El stock del producto padre es una caché de la suma de variantes.
      await sincronizarStockPadre(tx, params.id);
      return creada;
    });

    return NextResponse.json({ variante }, { status: 201 });
  } catch (error) {
    return manejarErrorApi(error);
  }
}
