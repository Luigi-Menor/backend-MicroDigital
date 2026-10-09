import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requerirSesionDeNegocio } from "@/lib/tenant";
import { manejarErrorApi, ErrorNoEncontrado, ErrorDominio } from "@/lib/api-error";
import {
  enlaceWhatsapp,
  renderizarHtml,
  renderizarTexto,
  type SnapshotComprobante,
} from "@/lib/comprobante";
import { enviarCorreo } from "@/lib/correo";
import { exigirLimite } from "@/lib/rate-limit";

// MÓDULO 11 — Envío del comprobante (RF-070).
//   EMAIL     -> se envía de verdad desde la cuenta de Gmail configurada
//                (lib/correo.ts) y solo se deja constancia si el envío salió bien.
//   WHATSAPP  -> entrega el enlace `wa.me` listo para abrir (sin API de WhatsApp).
//   SMS/DESCARGA -> solo se registra el envío; no hay proveedor de SMS.
const enviarSchema = z.object({
  medio: z.enum(["WHATSAPP", "EMAIL", "SMS", "DESCARGA"]),
  destino: z.string().min(3),
});

// Tope por negocio: un envío de correo sale de UNA cuenta de Gmail compartida,
// con cuota diaria. Sin tope, un solo negocio (o una cuenta comprometida)
// podría agotarla para todos los demás.
const MAX_CORREOS_POR_NEGOCIO_HORA = 30;

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const sesion = await requerirSesionDeNegocio(req);
    const { medio, destino } = enviarSchema.parse(await req.json());

    if (medio === "EMAIL" && !z.string().email().safeParse(destino).success) {
      throw new ErrorDominio("El destino debe ser un correo electrónico válido");
    }

    const comprobante = await prisma.comprobante.findFirst({
      where: { id: params.id, negocioId: sesion.negocioId },
    });
    if (!comprobante) throw new ErrorNoEncontrado("Comprobante no encontrado");

    const snapshot = comprobante.snapshot as unknown as SnapshotComprobante;

    if (medio === "EMAIL") {
      exigirLimite(`correo:negocio:${sesion.negocioId}`, MAX_CORREOS_POR_NEGOCIO_HORA, 3600);
      await enviarCorreo({
        para: destino,
        asunto: `${snapshot.negocio.nombre} — ${snapshot.folio}`,
        texto: renderizarTexto(snapshot),
        html: renderizarHtml(snapshot),
      });
    }

    const actualizado = await prisma.comprobante.update({
      where: { id: params.id },
      data: { enviadoA: destino, medioEnvio: medio, enviadoEn: new Date() },
    });

    let enlace: string | null = null;
    if (medio === "WHATSAPP") {
      enlace = enlaceWhatsapp(destino, renderizarTexto(snapshot));
    }

    return NextResponse.json({ comprobante: actualizado, enlace });
  } catch (error) {
    return manejarErrorApi(error);
  }
}
