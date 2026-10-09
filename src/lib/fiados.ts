import type { Prisma } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import { D, redondear } from "./dinero";

/**
 * Módulo 5 — Fiados / cuentas por cobrar.
 *
 * MODELO DE DATOS DE LA DEUDA (dos niveles, a propósito):
 *   - `Venta.saldoPendiente`: cuánto falta por pagar de ESA venta. Es el
 *     detalle: permite decir "la del martes ya está paga, la del jueves no".
 *   - `Cliente.saldoDeuda`: el total que debe el cliente. Es un agregado
 *     materializado — el POS necesita mostrar la deuda al seleccionar al
 *     cliente, y recorrer todas sus ventas en cada tecleo sería carísimo.
 *
 * La invariante que este módulo debe preservar en TODA operación es:
 *   Cliente.saldoDeuda == SUM(Venta.saldoPendiente de sus ventas no anuladas)
 * Por eso ambos niveles se escriben siempre juntos y dentro de la misma
 * transacción; `recalcularSaldoCliente` existe para repararla si algo la rompe.
 */

export class ErrorFiado extends Error {}

export interface ImputacionAbono {
  ventaId: string;
  numeroVenta: number;
  montoAplicado: Decimal;
  saldoAnterior: Decimal;
  saldoRestante: Decimal;
}

/**
 * Distribuye un abono sobre las ventas fiadas del cliente y actualiza su deuda.
 *
 * Con `ventaId` el abono se imputa a esa venta puntual. Sin él se aplica en
 * orden cronológico (FIFO): se salda primero la deuda más antigua, que es la
 * convención de un fiado de barrio y la que evita discusiones sobre qué se
 * abonó.
 */
export async function aplicarAbono(
  tx: Prisma.TransactionClient,
  params: {
    negocioId: string;
    clienteId: string;
    ventaId?: string | null;
    monto: Decimal | number | string;
  }
): Promise<{
  imputaciones: ImputacionAbono[];
  saldoClienteAnterior: Decimal;
  saldoClienteNuevo: Decimal;
}> {
  const monto = redondear(params.monto);
  if (monto.lessThanOrEqualTo(0)) {
    throw new ErrorFiado("El monto del abono debe ser mayor a cero");
  }

  const cliente = await tx.cliente.findFirst({
    where: { id: params.clienteId, negocioId: params.negocioId },
    select: { id: true, nombre: true, saldoDeuda: true },
  });
  if (!cliente) throw new ErrorFiado("Cliente no encontrado en este negocio");

  // Se rechaza el sobrepago en vez de dejar saldo a favor: un saldo negativo
  // rompería la invariante de arriba y el MVP no modela anticipos de cliente.
  if (monto.greaterThan(cliente.saldoDeuda)) {
    throw new ErrorFiado(
      `El abono (${monto.toFixed(2)}) supera la deuda de ${cliente.nombre} (${cliente.saldoDeuda.toFixed(2)})`
    );
  }

  const ventasPendientes = await tx.venta.findMany({
    where: {
      negocioId: params.negocioId,
      clienteId: params.clienteId,
      estado: { not: "ANULADA" },
      saldoPendiente: { gt: 0 },
      ...(params.ventaId ? { id: params.ventaId } : {}),
    },
    orderBy: { createdAt: "asc" }, // FIFO: primero la deuda más vieja
    select: { id: true, numero: true, saldoPendiente: true },
  });

  if (ventasPendientes.length === 0) {
    throw new ErrorFiado(
      params.ventaId
        ? "La venta indicada no tiene saldo pendiente o no pertenece a este cliente"
        : "El cliente no tiene ventas fiadas pendientes"
    );
  }

  const totalPendiente = ventasPendientes.reduce<Decimal>(
    (acc, v) => acc.add(v.saldoPendiente),
    D(0)
  );
  if (monto.greaterThan(totalPendiente)) {
    throw new ErrorFiado(
      `El abono supera el saldo pendiente de la(s) venta(s) seleccionada(s) (${totalPendiente.toFixed(2)})`
    );
  }

  const imputaciones: ImputacionAbono[] = [];
  let restante = monto;

  for (const venta of ventasPendientes) {
    if (restante.lessThanOrEqualTo(0)) break;

    const aplicado = Decimal.min(restante, venta.saldoPendiente);
    const saldoRestante = redondear(venta.saldoPendiente.sub(aplicado));

    await tx.venta.update({
      where: { id: venta.id },
      data: { saldoPendiente: saldoRestante },
    });

    imputaciones.push({
      ventaId: venta.id,
      numeroVenta: venta.numero,
      montoAplicado: redondear(aplicado),
      saldoAnterior: venta.saldoPendiente,
      saldoRestante,
    });

    restante = redondear(restante.sub(aplicado));
  }

  const clienteActualizado = await tx.cliente.update({
    where: { id: params.clienteId },
    data: { saldoDeuda: { decrement: monto } },
    select: { saldoDeuda: true },
  });

  return {
    imputaciones,
    saldoClienteAnterior: cliente.saldoDeuda,
    saldoClienteNuevo: clienteActualizado.saldoDeuda,
  };
}

/**
 * Verifica que fiar `monto` no exceda el cupo del cliente.
 * `limiteCredito` null significa "sin tope" (comportamiento por defecto).
 */
export async function validarLimiteCredito(
  tx: Prisma.TransactionClient,
  params: { negocioId: string; clienteId: string; monto: Decimal | number | string }
): Promise<void> {
  const cliente = await tx.cliente.findFirst({
    where: { id: params.clienteId, negocioId: params.negocioId },
    select: { nombre: true, saldoDeuda: true, limiteCredito: true, activo: true },
  });
  if (!cliente) throw new ErrorFiado("Cliente no encontrado en este negocio");
  if (!cliente.activo) throw new ErrorFiado(`El cliente ${cliente.nombre} está inactivo`);
  if (cliente.limiteCredito === null) return;

  const deudaProyectada = cliente.saldoDeuda.add(D(params.monto));
  if (deudaProyectada.greaterThan(cliente.limiteCredito)) {
    throw new ErrorFiado(
      `La venta deja a ${cliente.nombre} en ${deudaProyectada.toFixed(2)}, por encima de su cupo de ${cliente.limiteCredito.toFixed(2)}`
    );
  }
}

/**
 * Reconstruye `Cliente.saldoDeuda` desde las ventas. Es la reparación de la
 * invariante descrita arriba: se expone en el endpoint de fiados para poder
 * corregir un cliente descuadrado sin tocar la base a mano.
 */
export async function recalcularSaldoCliente(
  tx: Prisma.TransactionClient,
  negocioId: string,
  clienteId: string
): Promise<Decimal> {
  const agregado = await tx.venta.aggregate({
    where: { negocioId, clienteId, estado: { not: "ANULADA" } },
    _sum: { saldoPendiente: true },
  });
  const saldo = redondear(agregado._sum.saldoPendiente ?? 0);

  // `negocioId` en el WHERE del UPDATE es lo que impide que un clienteId de
  // otro negocio (que el agregado de arriba resuelve a 0) termine con su
  // deuda borrada.
  const { count } = await tx.cliente.updateMany({
    where: { id: clienteId, negocioId },
    data: { saldoDeuda: saldo },
  });
  if (count === 0) throw new ErrorFiado("Cliente no encontrado en este negocio");
  return saldo;
}

/**
 * Clasifica una deuda por antigüedad ("aging"), el corte estándar para
 * priorizar cobros.
 */
export function tramoAntiguedad(fechaVenta: Date): "0-30" | "31-60" | "61-90" | "90+" {
  const dias = Math.floor((Date.now() - fechaVenta.getTime()) / 86_400_000);
  if (dias <= 30) return "0-30";
  if (dias <= 60) return "31-60";
  if (dias <= 90) return "61-90";
  return "90+";
}
