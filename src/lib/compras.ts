import type { FormaPago, Prisma } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import { D, porcentajeDe, redondear } from "./dinero";
import { siguienteConsecutivo } from "./consecutivos";
import {
  aplicarMovimiento,
  cargarProductoDelNegocio,
  revertirMovimientosDeDocumento,
  validarUnidadStock,
} from "./inventario";
import { ErrorConflicto, ErrorDominio, ErrorNoEncontrado } from "./api-error";

/**
 * Módulo 7 — Proveedores y compras.
 *
 * CICLO DE VIDA DE UNA COMPRA (a propósito distinto al de una venta):
 *   BORRADOR  -> se está armando el pedido; el inventario NO se toca todavía.
 *   RECIBIDA  -> la mercancía llegó: se generan los movimientos de entrada y,
 *                si es a crédito, se acumula la deuda con el proveedor.
 *   ANULADA   -> revierte lo que RECIBIDA hizo (si llegó a recibirse).
 * Se modela así porque en la vida real el pedido y la llegada de la mercancía
 * casi nunca son el mismo instante: si se descontara inventario al crear la
 * compra, el stock mentiría mientras el pedido sigue en camino.
 */

export interface ItemCompra {
  productoId: string;
  varianteId?: string | null;
  cantidad: number;
  costoUnitario: number;
  descuento?: number | null;
  descuentoPorcentaje?: number | null;
}

export interface ParamsCrearCompra {
  negocioId: string;
  usuarioId: string;
  proveedorId: string;
  items: ItemCompra[];
  numeroFactura?: string | null;
  formaPago?: FormaPago;
  descuento?: number | null;
  descuentoPorcentaje?: number | null;
  impuesto?: number | null;
  fecha?: string | null;
  nota?: string | null;
  /** Si viene true, la compra se crea y se recibe en la misma operación. */
  recibirInmediatamente?: boolean;
}

function resolverDescuento(base: Decimal, monto: number | null | undefined, porcentaje: number | null | undefined, etiqueta: string): Decimal {
  if (monto != null && porcentaje != null) {
    throw new ErrorDominio(`${etiqueta}: usa 'descuento' o 'descuentoPorcentaje', no ambos`);
  }
  const valor = porcentaje != null ? porcentajeDe(base, porcentaje) : monto != null ? redondear(monto) : D(0);
  if (valor.lessThan(0)) throw new ErrorDominio(`${etiqueta}: el descuento no puede ser negativo`);
  if (valor.greaterThan(base)) {
    throw new ErrorDominio(`${etiqueta}: el descuento supera el importe de la línea`);
  }
  return valor;
}

export async function crearCompra(tx: Prisma.TransactionClient, params: ParamsCrearCompra) {
  if (params.items.length === 0) {
    throw new ErrorDominio("La compra debe tener al menos un producto");
  }

  const proveedor = await tx.proveedor.findFirst({
    where: { id: params.proveedorId, negocioId: params.negocioId },
    select: { id: true, nombre: true, activo: true },
  });
  if (!proveedor) throw new ErrorNoEncontrado("Proveedor no encontrado en este negocio");
  if (!proveedor.activo) throw new ErrorConflicto(`El proveedor ${proveedor.nombre} está inactivo`);

  const lineas: Array<{
    productoId: string;
    varianteId: string | null;
    descripcion: string;
    cantidad: number;
    costoUnitario: Decimal;
    descuento: Decimal;
    subtotal: Decimal;
  }> = [];

  const [productosCargados, variantesCargadas] = await Promise.all([
    Promise.all(
      params.items.map((item) => cargarProductoDelNegocio(tx, item.productoId, params.negocioId))
    ),
    Promise.all(
      params.items.map((item) =>
        item.varianteId
          ? // Igual que en ventas: sin productoId, una variante ajena pasaría
            // como válida y su nombre quedaría en el detalle de la compra.
            tx.productoVariante.findFirst({
              where: { id: item.varianteId, productoId: item.productoId },
              select: { nombre: true },
            })
          : Promise.resolve(null)
      )
    ),
  ]);

  for (let i = 0; i < params.items.length; i++) {
    const item = params.items[i];
    const producto = productosCargados[i];
    const variante = variantesCargadas[i];
    // Los tres arreglos tienen el mismo largo; la guarda solo existe para que
    // TypeScript (noUncheckedIndexedAccess) sepa que no son undefined.
    if (!item || !producto) throw new Error("Línea de documento fuera de rango");

    if (!Number.isInteger(item.cantidad) || item.cantidad <= 0) {
      throw new ErrorDominio("La cantidad de cada línea debe ser un entero positivo");
    }
    if (producto.tipo === "SERVICIO") {
      throw new ErrorDominio(`"${producto.nombre}" es un servicio: no se compra inventario para él`);
    }
    if (producto.tieneVariantes && !item.varianteId) {
      throw new ErrorDominio(
        `"${producto.nombre}" maneja variantes: debes indicar cuál (varianteId)`
      );
    }
    if (item.varianteId && !variante) {
      throw new ErrorDominio(`La variante indicada no pertenece a "${producto.nombre}"`);
    }

    let nombre = producto.nombre;
    if (variante) {
      nombre = `${nombre} - ${variante.nombre}`;
    }

    const costoUnitario = redondear(item.costoUnitario);
    const importe = redondear(costoUnitario.mul(item.cantidad));
    const descuento = resolverDescuento(importe, item.descuento, item.descuentoPorcentaje, `Línea "${nombre}"`);

    lineas.push({
      productoId: item.productoId,
      varianteId: item.varianteId ?? null,
      descripcion: nombre,
      cantidad: item.cantidad,
      costoUnitario,
      descuento,
      subtotal: redondear(importe.sub(descuento)),
    });
  }

  const subtotal = redondear(lineas.reduce<Decimal>((acc, l) => acc.add(l.subtotal), D(0)));
  const descuentoGlobal = resolverDescuento(subtotal, params.descuento, params.descuentoPorcentaje, "Descuento global");
  const baseGravable = redondear(subtotal.sub(descuentoGlobal));
  const impuesto = params.impuesto != null ? porcentajeDe(baseGravable, params.impuesto) : D(0);
  const total = redondear(baseGravable.add(impuesto));

  const numero = await siguienteConsecutivo(tx, params.negocioId, "COMPRA");

  const compra = await tx.compra.create({
    data: {
      negocioId: params.negocioId,
      proveedorId: params.proveedorId,
      numero,
      numeroFactura: params.numeroFactura,
      formaPago: params.formaPago ?? "TRANSFERENCIA",
      subtotal,
      descuento: descuentoGlobal,
      impuesto,
      total,
      saldoPendiente: total,
      fecha: params.fecha ? new Date(params.fecha) : undefined,
      nota: params.nota,
      usuarioId: params.usuarioId,
      detalles: {
        create: lineas.map((l) => ({
          productoId: l.productoId,
          varianteId: l.varianteId,
          descripcion: l.descripcion,
          cantidad: l.cantidad,
          costoUnitario: l.costoUnitario,
          descuento: l.descuento,
          subtotal: l.subtotal,
        })),
      },
    },
    include: { detalles: true, proveedor: true },
  });

  if (params.recibirInmediatamente) {
    return recibirCompra(tx, { negocioId: params.negocioId, compraId: compra.id, usuarioId: params.usuarioId });
  }

  return compra;
}

/**
 * Marca la compra como RECIBIDA: entra la mercancía al inventario (kardex de
 * tipo COMPRA) y, si no es de contado, se acumula la deuda con el proveedor.
 */
export async function recibirCompra(
  tx: Prisma.TransactionClient,
  params: { negocioId: string; compraId: string; usuarioId: string }
) {
  const compra = await tx.compra.findFirst({
    where: { id: params.compraId, negocioId: params.negocioId },
    include: { detalles: true },
  });
  if (!compra) throw new ErrorNoEncontrado("Compra no encontrada");
  if (compra.estado === "RECIBIDA") throw new ErrorConflicto("La compra ya fue recibida");
  if (compra.estado === "ANULADA") throw new ErrorConflicto("La compra está anulada");

  // En secuencia, no con Promise.all: dentro de una transacción interactiva
  // Prisma ejecuta las consultas de una en una sobre la misma conexión, así
  // que el paralelismo no gana nada; y si una línea falla, las que seguían en
  // vuelo chocaban con la transacción ya revertida.
  for (const detalle of compra.detalles) {
    await aplicarMovimiento(tx, {
      negocioId: params.negocioId,
      productoId: detalle.productoId,
      varianteId: detalle.varianteId,
      tipo: "COMPRA",
      cantidad: detalle.cantidad,
      costoUnitario: detalle.costoUnitario,
      referenciaTipo: "compra",
      referenciaId: compra.id,
      usuarioId: params.usuarioId,
      motivo: `Compra #${compra.numero}`,
    });

    // El costo de reposición del catálogo se actualiza con el precio de la
    // última compra: es la aproximación estándar de costeo para un
    // micronegocio sin sistema de costos promedio ponderado.
    if (detalle.varianteId) {
      await tx.productoVariante.update({
        where: { id: detalle.varianteId },
        data: { precioCosto: detalle.costoUnitario },
      });
    } else {
      await tx.producto.update({
        where: { id: detalle.productoId },
        data: { precioCosto: detalle.costoUnitario },
      });
    }
  }

  if (compra.formaPago !== "EFECTIVO" && compra.formaPago !== "TARJETA") {
    await tx.proveedor.update({
      where: { id: compra.proveedorId },
      data: { saldoDeuda: { increment: compra.total } },
    });
  } else {
    // De contado: no genera cuenta por pagar.
    await tx.compra.update({ where: { id: compra.id }, data: { saldoPendiente: D(0) } });
  }

  return tx.compra.update({
    where: { id: compra.id },
    data: { estado: "RECIBIDA" },
    include: { detalles: true, proveedor: true },
  });
}

/**
 * Anula una compra. Si ya estaba RECIBIDA, revierte inventario y deuda con
 * el proveedor (por el saldo pendiente, igual que en la venta: lo ya pagado
 * no se le devuelve al proveedor como si nunca se hubiera pagado).
 */
export async function anularCompra(
  tx: Prisma.TransactionClient,
  params: { negocioId: string; compraId: string; usuarioId: string; motivo: string }
) {
  const compra = await tx.compra.findFirst({
    where: { id: params.compraId, negocioId: params.negocioId },
  });
  if (!compra) throw new ErrorNoEncontrado("Compra no encontrada");
  if (compra.estado === "ANULADA") throw new ErrorConflicto("La compra ya está anulada");

  if (compra.estado === "RECIBIDA") {
    await revertirMovimientosDeDocumento(tx, {
      negocioId: params.negocioId,
      referenciaTipo: "compra",
      referenciaId: compra.id,
      usuarioId: params.usuarioId,
      motivo: `Anulación de compra #${compra.numero}: ${params.motivo}`,
    });

    if (compra.saldoPendiente.greaterThan(0)) {
      await tx.proveedor.update({
        where: { id: compra.proveedorId },
        data: { saldoDeuda: { decrement: compra.saldoPendiente } },
      });
    }
  }

  return tx.compra.update({
    where: { id: compra.id },
    data: { estado: "ANULADA", saldoPendiente: D(0) },
    include: { detalles: true },
  });
}

/** Registra un pago (abono) del negocio a un proveedor. */
export async function aplicarPagoProveedor(
  tx: Prisma.TransactionClient,
  params: {
    negocioId: string;
    proveedorId: string;
    compraId?: string | null;
    monto: number;
    formaPago: FormaPago;
    nota?: string | null;
    usuarioId: string;
  }
) {
  const monto = redondear(params.monto);
  if (monto.lessThanOrEqualTo(0)) throw new ErrorDominio("El monto del pago debe ser mayor a cero");

  const proveedor = await tx.proveedor.findFirst({
    where: { id: params.proveedorId, negocioId: params.negocioId },
    select: { id: true, nombre: true, saldoDeuda: true },
  });
  if (!proveedor) throw new ErrorNoEncontrado("Proveedor no encontrado en este negocio");
  if (monto.greaterThan(proveedor.saldoDeuda)) {
    throw new ErrorConflicto(
      `El pago (${monto.toFixed(2)}) supera la deuda con ${proveedor.nombre} (${proveedor.saldoDeuda.toFixed(2)})`
    );
  }

  if (params.compraId) {
    const compra = await tx.compra.findFirst({
      where: { id: params.compraId, negocioId: params.negocioId, proveedorId: params.proveedorId },
      select: { id: true, saldoPendiente: true },
    });
    if (!compra) throw new ErrorNoEncontrado("Compra no encontrada para este proveedor");
    if (monto.greaterThan(compra.saldoPendiente)) {
      throw new ErrorConflicto("El pago supera el saldo pendiente de esa compra");
    }
    await tx.compra.update({
      where: { id: compra.id },
      data: { saldoPendiente: { decrement: monto } },
    });
  }

  await tx.proveedor.update({
    where: { id: params.proveedorId },
    data: { saldoDeuda: { decrement: monto } },
  });

  return tx.pagoProveedor.create({
    data: {
      negocioId: params.negocioId,
      proveedorId: params.proveedorId,
      compraId: params.compraId ?? null,
      monto,
      formaPago: params.formaPago,
      nota: params.nota,
      usuarioId: params.usuarioId,
    },
    include: { proveedor: true },
  });
}
