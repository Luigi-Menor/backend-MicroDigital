import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requerirSesionDeNegocio } from "@/lib/tenant";
import { manejarErrorApi, ErrorNoEncontrado } from "@/lib/api-error";
import { renderizarHtml, renderizarTexto, type SnapshotComprobante } from "@/lib/comprobante";

// MÓDULO 11 — Detalle de un comprobante. `?formato=html|texto` devuelve el
// documento renderizado en vez del JSON crudo (para imprimir o compartir).
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const sesion = await requerirSesionDeNegocio(req);
    const comprobante = await prisma.comprobante.findFirst({
      where: { id: params.id, negocioId: sesion.negocioId },
    });
    if (!comprobante) throw new ErrorNoEncontrado("Comprobante no encontrado");

    const snapshot = comprobante.snapshot as unknown as SnapshotComprobante;
    const formato = req.nextUrl.searchParams.get("formato");

    if (formato === "html") {
      return new NextResponse(renderizarHtml(snapshot), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    if (formato === "texto") {
      return new NextResponse(renderizarTexto(snapshot), {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    return NextResponse.json({ comprobante });
  } catch (error) {
    return manejarErrorApi(error);
  }
}
