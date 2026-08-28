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
import { validarLimiteCredito } from "./fiados";
import { ErrorConflicto, ErrorDominio, ErrorNoEncontrado } from "./api-error";

/**
 * Módulo 1 — Ventas / POS.
 *
 * La lógica vive aquí y no en el route handler porque una venta toca cinco
 * módulos a la vez (inventario, fiados, clientes, comprobantes, empleados) y
 * todo eso debe ocurrir dentro de UNA transacción. Tener el flujo en una
 * función permite además reutilizarlo desde otras entradas sin duplicarlo.
 *
 * ORDEN DE CÁLCULO DE LOS DESCUENTOS (importante para que los totales cuadren):
 *   1. importe de línea  = precioUnitario * cantidad
 *   2. descuento línea   = monto fijo, o % sobre el importe de línea
 *   3. subtotal venta    = suma de (importe - descuento) de cada línea
 *   4. descuento global  = monto fijo, o % sobre el subtotal ya neteado
 *   5. base gravable     = subtotal - descuento global
 *   6. impuesto          = % del negocio sobre la base gravable
 *   7. total             = base gravable + impuesto
 * El % global se aplica DESPUÉS de los descuentos de línea para que un "10%
 * de descuento en toda la compra" no se acumule sobre precios ya rebajados.
 */

export interface ItemVenta {
  productoId: string;
  varianteId?: string | null;
  cantidad: number;
  /** Precio negociado. Si se omite, se usa el del catálogo. */
  precioUnitario?: number | null;
  descuento?: number | null;
  descuentoPorcentaje?: number | null;
}

export interface ParamsCrearVenta {
  negocioId: string;
  usuarioId: string;
  items: ItemVenta[];
  formaPago: FormaPago;
  clienteId?: string | null;
  descuento?: number | null;
  descuentoPorcentaje?: number | null;
  /** Aplica el % de impuesto configurado en el negocio. Por defecto, no. */
  aplicarImpuesto?: boolean;
  montoPagado?: number | null;
  nota?: string | null;
}

/** Resuelve el descuento de una base a partir de monto fijo o porcentaje. */
function resolverDescuento(
  base: Decimal,
  monto: number | null | undefined,
  porcentaje: number | null | undefined,
  etiqueta: string
): Decimal {
  if (monto != null && porcentaje != null) {
    throw new ErrorDominio(`${etiqueta}: usa 'descuento' o 'descuentoPorcentaje', no ambos`);
  }

  const valor =
    porcentaje != null ? porcentajeDe(base, porcentaje) : monto != null ? redondear(monto) : D(0);

  if (valor.lessThan(0)) throw new ErrorDominio(`${etiqueta}: el descuento no puede ser negativo`);
  if (valor.greaterThan(base)) {
    throw new ErrorDominio(
      `${etiqueta}: el descuento (${valor.toFixed(2)}) supera el importe (${base.toFixed(2)})`
    );
  }
  return valor;
}

/** Clave de consolidación: el mismo producto y la misma variante son la misma línea. */
function claveItem(item: ItemVenta): string {
  return `${item.productoId}::${item.varianteId ?? ""}::${item.precioUnitario ?? ""}`;
}

export async function crearVenta(tx: Prisma.TransactionClient, params: ParamsCrearVenta) {
  if (params.items.length === 0) {
    throw new ErrorDominio("La venta debe tener al menos un producto");
  }

  // Si el carrito trae la misma unidad en dos líneas, se consolidan ANTES de
  // tocar la base de datos: evita descontar stock dos veces de forma
  // inconsistente y simplifica la verificación atómica de existencias.
  const consolidados = new Map<string, ItemVenta>();
  for (const item of params.items) {
    const clave = claveItem(item);
    const previo = consolidados.get(clave);
    if (previo) {
      previo.cantidad += item.cantidad;
      previo.descuento = (previo.descuento ?? 0) + (item.descuento ?? 0);
    } else {
      consolidados.set(clave, { ...item });
    }
  }

  // 1. Valorar cada línea contra el catálogo del negocio.
  const lineas: Array<{
    item: ItemVenta;
    productoId: string;
    varianteId: string | null;
    descripcion: string;
    precioUnitario: Decimal;
    costoUnitario: Decimal | null;
    cantidad: number;
    descuento: Decimal;
    subtotal: Decimal;
    esServicio: boolean;
  }> = [];

  const itemsArray = Array.from(consolidados.values());
  const [productosCargados, variantesCargadas] = await Promise.all([
    Promise.all(
      itemsArray.map((item) => cargarProductoDelNegocio(tx, item.productoId, params.negocioId))
    ),
    Promise.all(
      itemsArray.map((item) =>
        item.varianteId
          ? tx.productoVariante.findUniqueOrThrow({
              where: { id: item.varianteId },
              select: { nombre: true, precio: true, precioCosto: true, activo: true },
            })
          : Promise.resolve(null)
      )
    ),
  ]);

  for (let i = 0; i < itemsArray.length; i++) {
    const item = itemsArray[i];
    const producto = productosCargados[i];
    const variante = variantesCargadas[i];

    if (!Number.isInteger(item.cantidad) || item.cantidad <= 0) {
      throw new ErrorDominio("La cantidad de cada línea debe ser un entero positivo");
    }

    if (producto.tipo === "SERVICIO" && item.varianteId) {
      throw new ErrorDominio(`"${producto.nombre}" es un servicio y no admite variantes`);
    }
    if (producto.tieneVariantes && !item.varianteId) {
      throw new ErrorDominio(
        `"${producto.nombre}" maneja variantes: debes indicar cuál (varianteId)`
      );
    }
    if (item.varianteId && !variante) {
      throw new ErrorDominio(`La variante indicada no pertenece a "${producto.nombre}"`);
    }

    if (!producto.activo) {
      throw new ErrorConflicto(`"${producto.nombre}" está inactivo y no se puede vender`);
    }

    let nombre = producto.nombre;
    let precioCatalogo = producto.precio;
    let costo = producto.precioCosto;

    if (variante) {
      if (!variante.activo) {
        throw new ErrorConflicto(`La variante "${variante.nombre}" está inactiva`);
      }
      nombre = `${nombre} - ${variante.nombre}`;
      precioCatalogo = variante.precio ?? precioCatalogo;
      costo = variante.precioCosto ?? costo;
    }

    // El precio del catálogo manda salvo que el cajero negocie otro; el precio
    // efectivamente cobrado queda congelado en la línea, así que el
    // comprobante y los reportes siempre reflejan lo que se cobró de verdad.
    const precioUnitario =
      item.precioUnitario != null ? redondear(item.precioUnitario) : precioCatalogo;
    if (precioUnitario.lessThan(0)) {
      throw new ErrorDominio(`El precio de "${nombre}" no puede ser negativo`);
    }

    const importe = redondear(precioUnitario.mul(item.cantidad));
    const descuento = resolverDescuento(
      importe,
      item.descuento,
      item.descuentoPorcentaje,
      `Línea "${nombre}"`
    );

    lineas.push({
      item,
      productoId: item.productoId,
      varianteId: item.varianteId ?? null,
      descripcion: nombre,
      precioUnitario,
      costoUnitario: costo,
      cantidad: item.cantidad,
      descuento,
      subtotal: redondear(importe.sub(descuento)),
      esServicio: producto.tipo === "SERVICIO",
    });
  }

  // 2. Totales de la venta (ver el orden documentado arriba).
  const subtotal = redondear(lineas.reduce<Decimal>((acc, l) => acc.add(l.subtotal), D(0)));
  const descuentoGlobal = resolverDescuento(
    subtotal,
    params.descuento,
    params.descuentoPorcentaje,
    "Descuento global"
  );
  const baseGravable = redondear(subtotal.sub(descuentoGlobal));

  const negocio = await tx.negocio.findUniqueOrThrow({
    where: { id: params.negocioId },
    select: { impuestoPorcentaje: true },
  });
  const impuesto = params.aplicarImpuesto
    ? porcentajeDe(baseGravable, negocio.impuestoPorcentaje)
    : D(0);

  const total = redondear(baseGravable.add(impuesto));

  // 3. Reglas del fiado (RF-010 + módulo 5).
  const esFiado = params.formaPago === "FIADO";
  if (esFiado) {
    if (!params.clienteId) {
      throw new ErrorDominio("Una venta fiada requiere un cliente asociado");
    }
    await validarLimiteCredito(tx, {
      negocioId: params.negocioId,
      clienteId: params.clienteId,
      monto: total,
    });
  } else if (params.clienteId) {
    const cliente = await tx.cliente.findFirst({
      where: { id: params.clienteId, negocioId: params.negocioId },
      select: { id: true },
    });
    if (!cliente) throw new ErrorNoEncontrado("Cliente no encontrado en este negocio");
  }

  // 4. Efectivo recibido y cambio (informativos, para el arqueo de caja).
  let montoPagado: Decimal | null = params.montoPagado != null ? redondear(params.montoPagado) : null;
  let cambio: Decimal | null = null;
  if (montoPagado !== null && !esFiado) {
    if (montoPagado.lessThan(total)) {
      throw new ErrorDominio(
        `El monto recibido (${montoPagado.toFixed(2)}) es menor al total (${total.toFixed(2)})`
      );
    }
    cambio = redondear(montoPagado.sub(total));
  }

  // 5. Consecutivo y persistencia.
  const numero = await siguienteConsecutivo(tx, params.negocioId, "VENTA");

  const venta = await tx.venta.create({
    data: {
      negocioId: params.negocioId,
      numero,
      usuarioId: params.usuarioId,
      clienteId: params.clienteId ?? null,
      formaPago: params.formaPago,
      subtotal,
      descuento: descuentoGlobal,
      impuesto,
      total,
      montoPagado,
      cambio,
      saldoPendiente: esFiado ? total : D(0),
      nota: params.nota ?? null,
      detalles: {
        create: lineas.map((l) => ({
          productoId: l.productoId,
          varianteId: l.varianteId,
          descripcion: l.descripcion,
          cantidad: l.cantidad,
          precioUnitario: l.precioUnitario,
          costoUnitario: l.costoUnitario,
          descuento: l.descuento,
          subtotal: l.subtotal,
        })),
      },
    },
  });

  // 6. Descontar existencias. `aplicarMovimiento` valida el stock de forma
  //    atómica y deja el rastro en el kardex; los servicios se omiten solos.
  await Promise.all(
    lineas.map((linea) =>
      aplicarMovimiento(tx, {
        negocioId: params.negocioId,
        productoId: linea.productoId,
        varianteId: linea.varianteId,
        tipo: "VENTA",
        cantidad: linea.cantidad,
        costoUnitario: linea.costoUnitario,
        referenciaTipo: "venta",
        referenciaId: venta.id,
        usuarioId: params.usuarioId,
        motivo: `Venta #${numero}`,
      })
    )
  );

  // 7. Acumular la deuda del cliente si fue fiado.
  if (esFiado && params.clienteId) {
    await tx.cliente.update({
      where: { id: params.clienteId },
      data: { saldoDeuda: { increment: total } },
    });
  }

  return tx.venta.findUniqueOrThrow({
    where: { id: venta.id },
    include: {
      detalles: { include: { producto: true, variante: true } },
      cliente: true,
      usuario: { select: { id: true, nombre: true } },
      comprobantes: { select: { id: true, folio: true, tipo: true } },
    },
  });
}

/**
 * RF-011 — Anula una venta: deja constancia en auditoría, devuelve el stock y
 * revierte la deuda que la venta hubiera generado.
 */
export async function anularVenta(
  tx: Prisma.TransactionClient,
  params: { negocioId: string; ventaId: string; usuarioId: string; motivo: string }
) {
  const venta = await tx.venta.findFirst({
    where: { id: params.ventaId, negocioId: params.negocioId },
    select: {
      id: true,
      numero: true,
      estado: true,
      clienteId: true,
      formaPago: true,
      saldoPendiente: true,
    },
  });
  if (!venta) throw new ErrorNoEncontrado("Venta no encontrada");
  if (venta.estado === "ANULADA") throw new ErrorConflicto("La venta ya está anulada");

  // Registro inmutable: quién, cuándo, qué acción y por qué.
  await tx.ventaAuditoria.create({
    data: {
      ventaId: venta.id,
      usuarioId: params.usuarioId,
      accion: "ANULADA",
      motivo: params.motivo,
    },
  });

  // Se restituye leyendo el kardex del propio documento, no recalculando desde
  // los detalles: así la devolución coincide exactamente con lo que se
  // descontó (los servicios, por ejemplo, nunca descontaron nada).
  await revertirInventarioDeVenta(tx, params, venta.numero);

  // La deuda se revierte por el SALDO PENDIENTE, no por el total: si el
  // cliente ya abonó parte de esta venta, ese dinero ya lo pagó y no debe
  // devolverse a su deuda. Los abonos quedan registrados como historial.
  if (venta.clienteId && venta.saldoPendiente.greaterThan(0)) {
    await tx.cliente.update({
      where: { id: venta.clienteId },
      data: { saldoDeuda: { decrement: venta.saldoPendiente } },
    });
  }

  return tx.venta.update({
    where: { id: venta.id },
    data: { estado: "ANULADA", saldoPendiente: D(0) },
    include: {
      detalles: true,
      cliente: { select: { id: true, nombre: true, saldoDeuda: true } },
    },
  });
}

async function revertirInventarioDeVenta(
  tx: Prisma.TransactionClient,
  params: { negocioId: string; ventaId: string; usuarioId: string; motivo: string },
  numeroVenta: number
) {
  return revertirMovimientosDeDocumento(tx, {
    negocioId: params.negocioId,
    referenciaTipo: "venta",
    referenciaId: params.ventaId,
    usuarioId: params.usuarioId,
    motivo: `Anulación de venta #${numeroVenta}: ${params.motivo}`,
  });
}
