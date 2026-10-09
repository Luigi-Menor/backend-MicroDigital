import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requerirSesionDeNegocio } from "@/lib/tenant";
import { manejarErrorApi } from "@/lib/api-error";
import { aplicarAbono } from "@/lib/fiados";
import { siguienteConsecutivo } from "@/lib/consecutivos";
import { emitirComprobante } from "@/lib/comprobante";
import { aNumero } from "@/lib/dinero";
import { metaPaginacion, parsePaginacion } from "@/lib/http";
import { ejecutarIdempotente } from "@/lib/idempotencia";

// MÓDULO 5 — Registro de abonos a la deuda de un cliente.
// GET  /api/fiados/abonos -> historial de abonos
// POST /api/fiados/abonos -> registrar abono (imputado FIFO o a una venta puntual)

const crearAbonoSchema = z.object({
  clienteId: z.string().cuid(),
  ventaId: z.string().cuid().nullish(),
  monto: z.number().positive(),
  formaPago: z.enum(["EFECTIVO", "TRANSFERENCIA", "TARJETA", "OTRO"]).default("EFECTIVO"),
  nota: z.string().max(300).nullish(),
  emitirComprobante: z.boolean().optional().default(false),
});

export async function GET(req: NextRequest) {
  try {
    const sesion = await requerirSesionDeNegocio(req);
    const params = req.nextUrl.searchParams;
    const paginacion = parsePaginacion(params);
    const clienteId = params.get("clienteId");

    const where = { negocioId: sesion.negocioId, ...(clienteId ? { clienteId } : {}) };
    const [abonos, total] = await Promise.all([
      prisma.abono.findMany({
        where,
        include: {
          cliente: { select: { id: true, nombre: true } },
          usuario: { select: { id: true, nombre: true } },
          venta: { select: { id: true, numero: true } },
        },
        orderBy: { createdAt: "desc" },
        skip: paginacion.skip,
        take: paginacion.limite,
      }),
      prisma.abono.count({ where }),
    ]);

    return NextResponse.json({ abonos, meta: metaPaginacion(total, paginacion) });
  } catch (error) {
    return manejarErrorApi(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    const sesion = await requerirSesionDeNegocio(req);

    // Un abono duplicado por reintento descontaría la deuda del cliente dos
    // veces: ver ejecutarIdempotente.
    return await ejecutarIdempotente(
      req,
      { negocioId: sesion.negocioId, endpoint: "POST /api/fiados/abonos" },
      async () => {
        try {
          const data = crearAbonoSchema.parse(await req.json());

          const resultado = await prisma.$transaction(async (tx) => {
            const [{ imputaciones, saldoClienteAnterior, saldoClienteNuevo }, numero] = await Promise.all([
              aplicarAbono(tx, {
                negocioId: sesion.negocioId,
                clienteId: data.clienteId,
                ventaId: data.ventaId,
                monto: data.monto,
              }),
              siguienteConsecutivo(tx, sesion.negocioId, "ABONO"),
            ]);
            const abono = await tx.abono.create({
              data: {
                negocioId: sesion.negocioId,
                clienteId: data.clienteId,
                ventaId: data.ventaId ?? imputaciones[0]?.ventaId ?? null,
                numero,
                monto: data.monto,
                formaPago: data.formaPago,
                nota: data.nota,
                usuarioId: sesion.usuarioId,
              },
              include: { cliente: true },
            });

            let comprobante = null;
            if (data.emitirComprobante) {
              comprobante = await emitirComprobante(tx, {
                negocioId: sesion.negocioId,
                usuarioId: sesion.usuarioId,
                tipo: "COMPROBANTE_ABONO",
                origen: { clase: "abono", abonoId: abono.id },
              });
            }

            return {
              abono,
              comprobante,
              imputaciones: imputaciones.map((i) => ({
                ...i,
                montoAplicado: aNumero(i.montoAplicado),
                saldoAnterior: aNumero(i.saldoAnterior),
                saldoRestante: aNumero(i.saldoRestante),
              })),
              saldoClienteAnterior: aNumero(saldoClienteAnterior),
              saldoClienteNuevo: aNumero(saldoClienteNuevo),
            };
          });

          return NextResponse.json(resultado, { status: 201 });
        } catch (error) {
          return manejarErrorApi(error);
        }
      }
    );
  } catch (error) {
    return manejarErrorApi(error);
  }
}
