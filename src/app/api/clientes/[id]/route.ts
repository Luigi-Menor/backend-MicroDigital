import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requerirSesionDeNegocio, requerirRol } from "@/lib/tenant";
import { manejarErrorApi, ErrorNoEncontrado } from "@/lib/api-error";

const actualizarSchema = z.object({
  nombre: z.string().min(2).optional(),
  contacto: z.string().nullable().optional(),
  email: z.string().email().nullable().optional(),
  documento: z.string().nullable().optional(),
  direccion: z.string().nullable().optional(),
  notas: z.string().nullable().optional(),
  limiteCredito: z.number().nonnegative().nullable().optional(),
  activo: z.boolean().optional(),
});

// GET /api/clientes/:id — historial de compras, abonos y saldo de deuda del cliente.
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const sesion = await requerirSesionDeNegocio(req);
    const cliente = await prisma.cliente.findUnique({
      where: { id: params.id },
      include: {
        ventas: {
          where: { negocioId: sesion.negocioId },
          include: { detalles: { include: { producto: true } } },
          orderBy: { createdAt: "desc" },
          take: 50,
        },
        abonos: {
          where: { negocioId: sesion.negocioId },
          include: { usuario: { select: { id: true, nombre: true } } },
          orderBy: { createdAt: "desc" },
          take: 50,
        },
      },
    });

    if (!cliente || cliente.negocioId !== sesion.negocioId) {
      throw new ErrorNoEncontrado("Cliente no encontrado");
    }

    return NextResponse.json({ cliente });
  } catch (error) {
    return manejarErrorApi(error);
  }
}

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const sesion = await requerirSesionDeNegocio(req);
    const data = actualizarSchema.parse(await req.json());

    const existente = await prisma.cliente.findUnique({ where: { id: params.id } });
    if (!existente || existente.negocioId !== sesion.negocioId) {
      throw new ErrorNoEncontrado("Cliente no encontrado");
    }

    const cliente = await prisma.cliente.update({ where: { id: params.id }, data });
    return NextResponse.json({ cliente });
  } catch (error) {
    return manejarErrorApi(error);
  }
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const sesion = await requerirSesionDeNegocio(req);
    requerirRol(sesion, "ADMINISTRADOR");

    const existente = await prisma.cliente.findUnique({ where: { id: params.id } });
    if (!existente || existente.negocioId !== sesion.negocioId) {
      throw new ErrorNoEncontrado("Cliente no encontrado");
    }
    if (existente.saldoDeuda.greaterThan(0)) {
      return NextResponse.json(
        { error: "No se puede eliminar un cliente con saldo pendiente" },
        { status: 409 }
      );
    }

    const tieneHistorial = await prisma.venta.findFirst({
      where: { clienteId: params.id },
      select: { id: true },
    });

    if (tieneHistorial) {
      const cliente = await prisma.cliente.update({
        where: { id: params.id },
        data: { activo: false },
      });
      return NextResponse.json({
        cliente,
        mensaje: "El cliente tiene compras registradas: se desactivó en vez de eliminarse",
      });
    }

    await prisma.cliente.delete({ where: { id: params.id } });
    return NextResponse.json({ mensaje: "Cliente eliminado" });
  } catch (error) {
    return manejarErrorApi(error);
  }
}
