import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requerirSesionDeNegocio, requerirRol } from "@/lib/tenant";
import { manejarErrorApi } from "@/lib/api-error";
import { metaPaginacion, parsePaginacion, leerBooleano } from "@/lib/http";

// MÓDULO 3 — Catálogo (productos y servicios), con variantes opcionales.
// RF-007 — stock_minimo es OBLIGATORIO para tipo=PRODUCTO (P4: sin default).
const varianteSchema = z.object({
  nombre: z.string().min(1),
  sku: z.string().optional(),
  precio: z.number().positive().optional(),
  precioCosto: z.number().nonnegative().optional(),
  stock: z.number().int().nonnegative().default(0),
  stockMinimo: z.number().int().nonnegative().default(0),
});

const crearProductoSchema = z
  .object({
    tipo: z.enum(["PRODUCTO", "SERVICIO"]).default("PRODUCTO"),
    nombre: z.string().min(2),
    descripcion: z.string().optional(),
    categoriaId: z.string().cuid().optional(),
    sku: z.string().optional(),
    unidad: z.string().optional(),
    precio: z.number().positive(),
    precioCosto: z.number().nonnegative().optional(),
    stock: z.number().int().nonnegative().default(0),
    stockMinimo: z.number().int().nonnegative().optional(),
    variantes: z.array(varianteSchema).optional(),
  })
  .refine((d) => d.tipo !== "PRODUCTO" || d.stockMinimo !== undefined, {
    message: "stockMinimo es obligatorio para productos (no aplica a servicios)",
    path: ["stockMinimo"],
  });

// GET /api/productos — catálogo del negocio, con bandera de stock bajo (RF-008).
export async function GET(req: NextRequest) {
  try {
    const sesion = await requerirSesionDeNegocio(req);
    const params = req.nextUrl.searchParams;
    const paginacion = parsePaginacion(params);

    const busqueda = params.get("q");
    const categoriaId = params.get("categoriaId");
    const tipo = params.get("tipo");
    const activo = leerBooleano(params.get("activo"));
    const soloStockBajo = leerBooleano(params.get("stockBajo"));

    const where: Prisma.ProductoWhereInput = {
      negocioId: sesion.negocioId,
      ...(categoriaId ? { categoriaId } : {}),
      ...(tipo ? { tipo: tipo as Prisma.EnumTipoItemFilter["equals"] } : {}),
      ...(activo !== undefined ? { activo } : {}),
      ...(busqueda
        ? {
            OR: [
              { nombre: { contains: busqueda, mode: "insensitive" } },
              { sku: { contains: busqueda, mode: "insensitive" } },
            ],
          }
        : {}),
    };

    const [productos, total] = await Promise.all([
      prisma.producto.findMany({
        where,
        include: { categoria: true, variantes: { orderBy: { nombre: "asc" } } },
        orderBy: { nombre: "asc" },
        skip: paginacion.skip,
        take: paginacion.limite,
      }),
      prisma.producto.count({ where }),
    ]);

    const conAlerta = productos.reduce<typeof productos>((acc, p) => {
      const stockBajo =
        p.tipo === "SERVICIO"
          ? false
          : p.variantes.length > 0
            ? p.variantes.some((v) => v.stock <= v.stockMinimo)
            : p.stock <= p.stockMinimo;
      if (soloStockBajo === undefined || stockBajo === soloStockBajo) {
        acc.push({ ...p, stockBajo });
      }
      return acc;
    }, []);

    return NextResponse.json({ productos: conAlerta, meta: metaPaginacion(total, paginacion) });
  } catch (error) {
    return manejarErrorApi(error);
  }
}

// POST /api/productos — solo Administrador (RF-007).
export async function POST(req: NextRequest) {
  try {
    const sesion = await requerirSesionDeNegocio(req);
    requerirRol(sesion, "ADMINISTRADOR");
    const data = crearProductoSchema.parse(await req.json());

    const producto = await prisma.$transaction(async (tx) => {
      const creado = await tx.producto.create({
        data: {
          negocioId: sesion.negocioId,
          tipo: data.tipo,
          nombre: data.nombre,
          descripcion: data.descripcion,
          categoriaId: data.categoriaId,
          sku: data.sku,
          unidad: data.unidad,
          precio: data.precio,
          precioCosto: data.precioCosto,
          // Un servicio o un producto CON variantes no acumula stock propio;
          // el stock real vive en las variantes (ver src/lib/inventario.ts).
          stock: data.variantes?.length ? 0 : data.stock,
          stockMinimo: data.tipo === "PRODUCTO" ? data.stockMinimo ?? 0 : 0,
        },
      });

      if (data.variantes?.length) {
        await tx.productoVariante.createMany({
          data: data.variantes.map((v) => ({ ...v, productoId: creado.id })),
        });
        const suma = data.variantes.reduce((acc, v) => acc + v.stock, 0);
        await tx.producto.update({ where: { id: creado.id }, data: { stock: suma } });
      }

      return tx.producto.findUniqueOrThrow({
        where: { id: creado.id },
        include: { categoria: true, variantes: true },
      });
    });

    return NextResponse.json({ producto }, { status: 201 });
  } catch (error) {
    return manejarErrorApi(error);
  }
}
