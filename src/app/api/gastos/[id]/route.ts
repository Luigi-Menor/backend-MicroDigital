import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requerirSesionDeNegocio, requerirRol } from "@/lib/tenant";
import { manejarErrorApi, ErrorNoEncontrado } from "@/lib/api-error";
import { ejecutarIdempotente } from "@/lib/idempotencia";
import { validarReferenciasDelNegocio } from "@/lib/referencias";

const actualizarSchema = z.object({
  categoriaGastoId: z.string().cuid().nullable().optional(),
  proveedorId: z.string().cuid().nullable().optional(),
  descripcion: z.string().min(2).optional(),
  monto: z.number().positive().optional(),
  formaPago: z.enum(["EFECTIVO", "TRANSFERENCIA", "FIADO", "TARJETA", "OTRO"]).optional(),
  fecha: z.string().optional(),
  comprobanteUrl: z.string().url().nullable().optional(),
  nota: z.string().max(500).nullable().optional(),
});

async function gastoDelNegocio(id: string, negocioId: string) {
  const gasto = await prisma.gasto.findUnique({ where: { id } });
  if (!gasto || gasto.negocioId !== negocioId) return null;
  return gasto;
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const sesion = await requerirSesionDeNegocio(req);
    const gasto = await prisma.gasto.findUnique({
      where: { id: params.id },
      include: { categoriaGasto: true, proveedor: true, usuario: { select: { id: true, nombre: true } } },
    });
    if (!gasto || gasto.negocioId !== sesion.negocioId) throw new ErrorNoEncontrado("Gasto no encontrado");
    return NextResponse.json({ gasto });
  } catch (error) {
    return manejarErrorApi(error);
  }
}

// Editar/eliminar un gasto ya registrado es exclusivo del Administrador: un
// Vendedor puede registrar caja menor, pero no borrar su propio rastro.
export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const sesion = await requerirSesionDeNegocio(req);
    requerirRol(sesion, "ADMINISTRADOR");
    const data = actualizarSchema.parse(await req.json());

    const existente = await gastoDelNegocio(params.id, sesion.negocioId);
    if (!existente) throw new ErrorNoEncontrado("Gasto no encontrado");
    await validarReferenciasDelNegocio(prisma, sesion.negocioId, {
      categoriaGastoId: data.categoriaGastoId,
      proveedorId: data.proveedorId,
    });

    const gasto = await prisma.gasto.update({
      where: { id: params.id },
      data: { ...data, fecha: data.fecha ? new Date(data.fecha) : undefined },
      include: { categoriaGasto: true, proveedor: true },
    });
    return NextResponse.json({ gasto });
  } catch (error) {
    return manejarErrorApi(error);
  }
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const sesion = await requerirSesionDeNegocio(req);
    requerirRol(sesion, "ADMINISTRADOR");

    return await ejecutarIdempotente(
      req,
      { negocioId: sesion.negocioId, endpoint: `DELETE /api/gastos/${params.id}` },
      async () => {
        try {
          const existente = await gastoDelNegocio(params.id, sesion.negocioId);
          if (!existente) throw new ErrorNoEncontrado("Gasto no encontrado");

          await prisma.gasto.delete({ where: { id: params.id } });
          return NextResponse.json({ mensaje: "Gasto eliminado" });
        } catch (error) {
          return manejarErrorApi(error);
        }
      }
    );
  } catch (error) {
    return manejarErrorApi(error);
  }
}
