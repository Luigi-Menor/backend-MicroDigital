import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requerirSesionDeNegocio, requerirRol } from "@/lib/tenant";
import { manejarErrorApi, ErrorNoEncontrado } from "@/lib/api-error";

const actualizarSchema = z.object({
  nombre: z.string().min(2).optional(),
  descripcion: z.string().nullable().optional(),
  categoriaId: z.string().cuid().nullable().optional(),
  sku: z.string().nullable().optional(),
  unidad: z.string().nullable().optional(),
  precio: z.number().positive().optional(),
  precioCosto: z.number().nonnegative().nullable().optional(),
  stockMinimo: z.number().int().nonnegative().optional(),
  activo: z.boolean().optional(),
});

async function obtenerProductoDelNegocio(id: string, negocioId: string) {
  const producto = await prisma.producto.findUnique({
    where: { id },
    include: { variantes: true, categoria: true },
  });
  // Verificación explícita de tenant: un id válido de OTRO negocio debe
  // tratarse como "no encontrado", nunca filtrar su existencia.
  if (!producto || producto.negocioId !== negocioId) return null;
  return producto;
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const sesion = await requerirSesionDeNegocio(req);
    const producto = await obtenerProductoDelNegocio(params.id, sesion.negocioId);
    if (!producto) throw new ErrorNoEncontrado("Producto no encontrado");
    return NextResponse.json({ producto });
  } catch (error) {
    return manejarErrorApi(error);
  }
}

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const sesion = await requerirSesionDeNegocio(req);
    requerirRol(sesion, "ADMINISTRADOR");
    const data = actualizarSchema.parse(await req.json());

    const existente = await obtenerProductoDelNegocio(params.id, sesion.negocioId);
    if (!existente) throw new ErrorNoEncontrado("Producto no encontrado");

    // El stock NUNCA se edita desde aquí a propósito: hacerlo saltaría el
    // kardex (módulo 2). Para corregir existencias se usa
    // POST /api/inventario/movimientos o /ajuste, que sí dejan rastro.
    const producto = await prisma.producto.update({
      where: { id: params.id },
      data,
      include: { categoria: true, variantes: true },
    });
    return NextResponse.json({ producto });
  } catch (error) {
    return manejarErrorApi(error);
  }
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const sesion = await requerirSesionDeNegocio(req);
    requerirRol(sesion, "ADMINISTRADOR");

    const existente = await obtenerProductoDelNegocio(params.id, sesion.negocioId);
    if (!existente) throw new ErrorNoEncontrado("Producto no encontrado");

    // Un producto con historial (ventas, compras, movimientos) no se borra:
    // se desactiva. Borrarlo rompería el detalle de documentos ya emitidos.
    const tieneHistorial = await prisma.ventaDetalle.findFirst({
      where: { productoId: params.id },
      select: { id: true },
    });

    if (tieneHistorial) {
      const producto = await prisma.producto.update({
        where: { id: params.id },
        data: { activo: false },
      });
      return NextResponse.json({
        producto,
        mensaje: "El producto tiene ventas registradas: se desactivó en vez de eliminarse",
      });
    }

    await prisma.producto.delete({ where: { id: params.id } });
    return NextResponse.json({ mensaje: "Producto eliminado" });
  } catch (error) {
    return manejarErrorApi(error);
  }
}
