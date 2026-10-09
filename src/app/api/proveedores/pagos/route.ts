import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requerirSesionDeNegocio, requerirRol } from "@/lib/tenant";
import { manejarErrorApi } from "@/lib/api-error";
import { aplicarPagoProveedor } from "@/lib/compras";
import { metaPaginacion, parsePaginacion } from "@/lib/http";
import { ejecutarIdempotente } from "@/lib/idempotencia";

// MÓDULO 7 — Pagos a proveedores (cuentas por pagar).
const crearPagoSchema = z.object({
  proveedorId: z.string().cuid(),
  compraId: z.string().cuid().nullish(),
  monto: z.number().positive(),
  formaPago: z.enum(["EFECTIVO", "TRANSFERENCIA", "TARJETA", "OTRO"]).default("EFECTIVO"),
  nota: z.string().max(300).nullish(),
});

export async function GET(req: NextRequest) {
  try {
    const sesion = await requerirSesionDeNegocio(req);
    const params = req.nextUrl.searchParams;
    const paginacion = parsePaginacion(params);
    const proveedorId = params.get("proveedorId");

    const where = { negocioId: sesion.negocioId, ...(proveedorId ? { proveedorId } : {}) };
    const [pagos, total] = await Promise.all([
      prisma.pagoProveedor.findMany({
        where,
        include: {
          proveedor: { select: { id: true, nombre: true } },
          compra: { select: { id: true, numero: true } },
          usuario: { select: { id: true, nombre: true } },
        },
        orderBy: { createdAt: "desc" },
        skip: paginacion.skip,
        take: paginacion.limite,
      }),
      prisma.pagoProveedor.count({ where }),
    ]);

    return NextResponse.json({ pagos, meta: metaPaginacion(total, paginacion) });
  } catch (error) {
    return manejarErrorApi(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    const sesion = await requerirSesionDeNegocio(req);
    requerirRol(sesion, "ADMINISTRADOR");

    // Un pago a proveedor duplicado por reintento descontaría la deuda dos
    // veces: ver ejecutarIdempotente.
    return await ejecutarIdempotente(
      req,
      { negocioId: sesion.negocioId, endpoint: "POST /api/proveedores/pagos" },
      async () => {
        try {
          const data = crearPagoSchema.parse(await req.json());

          const pago = await prisma.$transaction((tx) =>
            aplicarPagoProveedor(tx, { ...data, negocioId: sesion.negocioId, usuarioId: sesion.usuarioId })
          );

          return NextResponse.json({ pago }, { status: 201 });
        } catch (error) {
          return manejarErrorApi(error);
        }
      }
    );
  } catch (error) {
    return manejarErrorApi(error);
  }
}
