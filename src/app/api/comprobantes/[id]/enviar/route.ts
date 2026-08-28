import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requerirSesionDeNegocio } from "@/lib/tenant";
import { manejarErrorApi, ErrorNoEncontrado } from "@/lib/api-error";
import { enlaceWhatsapp, renderizarTexto, type SnapshotComprobante } from "@/lib/comprobante";

// MÓDULO 11 — Registra el envío del comprobante y, para WhatsApp, entrega el
// enlace `wa.me` listo para abrir. El envío real (SMS/Email) queda fuera del
// alcance del backend del MVP: aquí solo se deja constancia y se compone el
// enlace/mensaje que el frontend abre o copia.
const enviarSchema = z.object({
  medio: z.enum(["WHATSAPP", "EMAIL", "SMS", "DESCARGA"]),
  destino: z.string().min(3),
});

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const sesion = await requerirSesionDeNegocio(req);
    const { medio, destino } = enviarSchema.parse(await req.json());

    const comprobante = await prisma.comprobante.findFirst({
      where: { id: params.id, negocioId: sesion.negocioId },
    });
    if (!comprobante) throw new ErrorNoEncontrado("Comprobante no encontrado");

    const actualizado = await prisma.comprobante.update({
      where: { id: params.id },
      data: { enviadoA: destino, medioEnvio: medio, enviadoEn: new Date() },
    });

    let enlace: string | null = null;
    if (medio === "WHATSAPP") {
      const snapshot = comprobante.snapshot as unknown as SnapshotComprobante;
      enlace = enlaceWhatsapp(destino, renderizarTexto(snapshot));
    }

    return NextResponse.json({ comprobante: actualizado, enlace });
  } catch (error) {
    return manejarErrorApi(error);
  }
}
