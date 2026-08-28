import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requerirSesionDeNegocio, requerirRol } from "@/lib/tenant";
import { manejarErrorApi, ErrorNoEncontrado } from "@/lib/api-error";
import { anularVenta } from "@/lib/ventas";

// MÓDULO 1 — Detalle y anulación de una venta.
// GET /api/ventas/:id -> venta completa con detalles, abonos y auditoría
// PUT /api/ventas/:id -> RF-011: anular (o dejar constancia de edición)

// RF-011 — `motivo` es obligatorio cuando accion = "ANULADA" y opcional
// cuando accion = "EDITADA" (P5 del levantamiento). Esta validación
// condicional vive aquí, no en el schema de Prisma.
const accionSchema = z
  .object({
    accion: z.enum(["ANULADA", "EDITADA"]),
    motivo: z.string().min(3).optional(),
  })
  .refine((data) => data.accion !== "ANULADA" || !!data.motivo, {
    message: "El motivo es obligatorio al anular una venta",
    path: ["motivo"],
  });

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const sesion = await requerirSesionDeNegocio(req);

    const venta = await prisma.venta.findFirst({
      where: { id: params.id, negocioId: sesion.negocioId },
      include: {
        detalles: { include: { producto: true, variante: true } },
        cliente: true,
        usuario: { select: { id: true, nombre: true } },
        abonos: {
          orderBy: { createdAt: "desc" },
          include: { usuario: { select: { id: true, nombre: true } } },
        },
        auditorias: {
          orderBy: { createdAt: "desc" },
          include: { usuario: { select: { id: true, nombre: true } } },
        },
        comprobantes: { select: { id: true, folio: true, tipo: true, createdAt: true } },
      },
    });

    if (!venta) throw new ErrorNoEncontrado("Venta no encontrada");

    // Un Vendedor no debe poder abrir la venta de otro empleado.
    if (sesion.rol === "VENDEDOR" && venta.usuarioId !== sesion.usuarioId) {
      throw new ErrorNoEncontrado("Venta no encontrada");
    }

    return NextResponse.json({ venta });
  } catch (error) {
    return manejarErrorApi(error);
  }
}

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const sesion = await requerirSesionDeNegocio(req);
    // Anular mueve dinero e inventario: se restringe al Administrador.
    requerirRol(sesion, "ADMINISTRADOR");
    const { accion, motivo } = accionSchema.parse(await req.json());

    if (accion === "ANULADA") {
      const venta = await prisma.$transaction((tx) =>
        anularVenta(tx, {
          negocioId: sesion.negocioId,
          ventaId: params.id,
          usuarioId: sesion.usuarioId,
          motivo: motivo!,
        })
      );
      return NextResponse.json({ venta });
    }

    // EDITADA solo deja constancia en auditoría: los importes de una venta ya
    // emitida no se reescriben (el comprobante entregado dejaría de ser fiel).
    // Para corregir de verdad, se anula y se registra una venta nueva.
    const existente = await prisma.venta.findFirst({
      where: { id: params.id, negocioId: sesion.negocioId },
      select: { id: true },
    });
    if (!existente) throw new ErrorNoEncontrado("Venta no encontrada");

    const venta = await prisma.$transaction(async (tx) => {
      await tx.ventaAuditoria.create({
        data: {
          ventaId: params.id,
          usuarioId: sesion.usuarioId,
          accion: "EDITADA",
          motivo: motivo ?? null,
        },
      });
      return tx.venta.update({
        where: { id: params.id },
        data: { estado: "EDITADA" },
        include: { detalles: true },
      });
    });

    return NextResponse.json({ venta });
  } catch (error) {
    return manejarErrorApi(error);
  }
}
