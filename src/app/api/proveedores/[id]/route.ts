import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requerirSesionDeNegocio, requerirRol } from "@/lib/tenant";
import { manejarErrorApi, ErrorNoEncontrado, ErrorConflicto } from "@/lib/api-error";
import { emailOpcionalNulable } from "@/lib/http";

const actualizarSchema = z.object({
  nombre: z.string().min(2).optional(),
  contacto: z.string().nullable().optional(),
  email: emailOpcionalNulable(),
  telefono: z.string().nullable().optional(),
  nit: z.string().nullable().optional(),
  direccion: z.string().nullable().optional(),
  notas: z.string().nullable().optional(),
  activo: z.boolean().optional(),
});

async function proveedorDelNegocio(id: string, negocioId: string) {
  const proveedor = await prisma.proveedor.findUnique({ where: { id } });
  if (!proveedor || proveedor.negocioId !== negocioId) return null;
  return proveedor;
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const sesion = await requerirSesionDeNegocio(req);
    const proveedor = await prisma.proveedor.findUnique({
      where: { id: params.id },
      include: {
        compras: { orderBy: { fecha: "desc" }, take: 20 },
        pagos: { orderBy: { createdAt: "desc" }, take: 20 },
      },
    });
    if (!proveedor || proveedor.negocioId !== sesion.negocioId) {
      throw new ErrorNoEncontrado("Proveedor no encontrado");
    }
    return NextResponse.json({ proveedor });
  } catch (error) {
    return manejarErrorApi(error);
  }
}

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const sesion = await requerirSesionDeNegocio(req);
    requerirRol(sesion, "ADMINISTRADOR");
    const data = actualizarSchema.parse(await req.json());

    const existente = await proveedorDelNegocio(params.id, sesion.negocioId);
    if (!existente) throw new ErrorNoEncontrado("Proveedor no encontrado");

    const proveedor = await prisma.proveedor.update({ where: { id: params.id }, data });
    return NextResponse.json({ proveedor });
  } catch (error) {
    return manejarErrorApi(error);
  }
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const sesion = await requerirSesionDeNegocio(req);
    requerirRol(sesion, "ADMINISTRADOR");

    const existente = await proveedorDelNegocio(params.id, sesion.negocioId);
    if (!existente) throw new ErrorNoEncontrado("Proveedor no encontrado");
    if (existente.saldoDeuda.greaterThan(0)) {
      throw new ErrorConflicto("No se puede eliminar un proveedor con saldo pendiente");
    }

    const tieneHistorial = await prisma.compra.findFirst({
      where: { proveedorId: params.id },
      select: { id: true },
    });

    if (tieneHistorial) {
      const proveedor = await prisma.proveedor.update({
        where: { id: params.id },
        data: { activo: false },
      });
      return NextResponse.json({
        proveedor,
        mensaje: "El proveedor tiene compras registradas: se desactivó en vez de eliminarse",
      });
    }

    await prisma.proveedor.delete({ where: { id: params.id } });
    return NextResponse.json({ mensaje: "Proveedor eliminado" });
  } catch (error) {
    return manejarErrorApi(error);
  }
}
