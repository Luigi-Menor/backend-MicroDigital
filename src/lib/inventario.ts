import type { Prisma, TipoMovimiento } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import { D } from "./dinero";

/**
 * Módulo 2 — Motor de inventario.
 *
 * ÚNICA PUERTA DE ESCRITURA DEL STOCK. Ningún handler debe hacer
 * `producto.update({ stock: ... })` por su cuenta: si lo hace, el kardex
 * (`MovimientoInventario`) deja de reflejar la realidad y el inventario se
 * vuelve inauditable. Todas las rutas — ventas, compras, ajustes manuales,
 * anulaciones — pasan por `aplicarMovimiento` o `ajustarStock`.
 *
 * DÓNDE VIVE EL STOCK (ver también el comentario en prisma/schema.prisma):
 *   - Producto SIN variantes -> `Producto.stock` es la verdad.
 *   - Producto CON variantes -> `ProductoVariante.stock` es la verdad, y
 *     `Producto.stock` se mantiene como caché de la suma de sus variantes.
 *   - `tipo = SERVICIO`      -> no hay stock: los movimientos se ignoran.
 */

/** Movimientos que suman existencias frente a los que las restan. */
const DIRECCION: Record<Exclude<TipoMovimiento, "AJUSTE">, 1 | -1> = {
  ENTRADA: 1,
  COMPRA: 1,
  ANULACION_VENTA: 1,
  SALIDA: -1,
  MERMA: -1,
  VENTA: -1,
  ANULACION_COMPRA: -1,
};

export class ErrorStock extends Error {}

export interface ParamsMovimiento {
  negocioId: string;
  productoId: string;
  varianteId?: string | null;
  tipo: Exclude<TipoMovimiento, "AJUSTE">;
  /** Magnitud, siempre positiva. El signo lo decide `tipo`. */
  cantidad: number;
  costoUnitario?: Decimal | number | string | null;
  motivo?: string | null;
  /** Documento que origina el movimiento: "venta" | "compra" | "ajuste". */
  referenciaTipo?: string | null;
  referenciaId?: string | null;
  usuarioId?: string | null;
  /**
   * Permite que una salida deje el stock negativo. Solo se usa al revertir
   * documentos (donde el stock ya fue alterado por otras operaciones y
   * bloquear la reversión dejaría el sistema en un estado peor).
   */
  permitirNegativo?: boolean;
}

interface ProductoStock {
  id: string;
  tipo: "PRODUCTO" | "SERVICIO";
  nombre: string;
  negocioId: string;
  tieneVariantes: boolean;
}

/**
 * Carga un producto del negocio y responde si maneja variantes.
 * Lanza si el producto no existe o es de otro negocio (aislamiento tenant).
 */
export async function cargarProductoDelNegocio(
  tx: Prisma.TransactionClient,
  productoId: string,
  negocioId: string
): Promise<ProductoStock> {
  const producto = await tx.producto.findFirst({
    where: { id: productoId, negocioId },
    select: {
      id: true,
      tipo: true,
      nombre: true,
      negocioId: true,
      _count: { select: { variantes: true } },
    },
  });

  if (!producto) {
    throw new ErrorStock("Uno o más productos no existen en este negocio");
  }

  return {
    id: producto.id,
    tipo: producto.tipo,
    nombre: producto.nombre,
    negocioId: producto.negocioId,
    tieneVariantes: producto._count.variantes > 0,
  };
}

/**
 * Valida que la combinación producto/variante sea coherente antes de mover
 * stock. Es la regla que impide vender "Camiseta" a secas cuando la camiseta
 * existe en tres tallas con stock distinto.
 */
export async function validarUnidadStock(
  tx: Prisma.TransactionClient,
  producto: ProductoStock,
  varianteId: string | null | undefined
): Promise<void> {
  if (producto.tipo === "SERVICIO") {
    if (varianteId) {
      throw new ErrorStock(`"${producto.nombre}" es un servicio y no admite variantes`);
    }
    return;
  }

  if (producto.tieneVariantes && !varianteId) {
    throw new ErrorStock(
      `"${producto.nombre}" maneja variantes: debes indicar cuál (varianteId)`
    );
  }

  if (varianteId) {
    const variante = await tx.productoVariante.findFirst({
      where: { id: varianteId, productoId: producto.id },
      select: { id: true },
    });
    if (!variante) {
      throw new ErrorStock(`La variante indicada no pertenece a "${producto.nombre}"`);
    }
  }
}

/**
 * Aplica un movimiento de inventario y deja constancia en el kardex.
 * Devuelve `null` cuando el ítem es un SERVICIO (no hay existencias que mover).
 *
 * CONCURRENCIA: las salidas se ejecutan con un `updateMany` cuya condición
 * `stock >= cantidad` viaja DENTRO del propio UPDATE. Si se leyera el stock,
 * se validara en JavaScript y después se decrementara, dos ventas simultáneas
 * podrían leer el mismo stock y ambas descontarlo, dejando existencias
 * negativas (Postgres corre en READ COMMITTED, no serializa esa secuencia).
 * Con la condición dentro del UPDATE, la segunda afecta 0 filas y abortamos.
 */
export async function aplicarMovimiento(
  tx: Prisma.TransactionClient,
  params: ParamsMovimiento
) {
  const producto = await cargarProductoDelNegocio(tx, params.productoId, params.negocioId);

  // Un servicio no tiene existencias: no se descuenta nada ni se registra kardex.
  if (producto.tipo === "SERVICIO") return null;

  await validarUnidadStock(tx, producto, params.varianteId);

  if (!Number.isInteger(params.cantidad) || params.cantidad <= 0) {
    throw new ErrorStock("La cantidad del movimiento debe ser un entero positivo");
  }

  const signo = DIRECCION[params.tipo];
  const { stockAnterior, stockResultante } = await moverExistencias(tx, {
    productoId: producto.id,
    varianteId: params.varianteId ?? null,
    negocioId: params.negocioId,
    cantidad: params.cantidad,
    signo,
    nombreProducto: producto.nombre,
    permitirNegativo: params.permitirNegativo ?? false,
  });

  // Si el stock real vive en la variante, el del producto padre es una caché
  // que hay que recomponer para que los listados del catálogo no mientan.
  if (params.varianteId) {
    await sincronizarStockPadre(tx, producto.id);
  }

  return tx.movimientoInventario.create({
    data: {
      negocioId: params.negocioId,
      productoId: producto.id,
      varianteId: params.varianteId ?? null,
      tipo: params.tipo,
      cantidad: params.cantidad,
      stockAnterior,
      stockResultante,
      costoUnitario: params.costoUnitario != null ? D(params.costoUnitario) : null,
      motivo: params.motivo ?? null,
      referenciaTipo: params.referenciaTipo ?? null,
      referenciaId: params.referenciaId ?? null,
      usuarioId: params.usuarioId ?? null,
    },
  });
}

/**
 * Fija el stock a un valor absoluto (conteo físico / inventario cíclico) y
 * registra el descuadre como movimiento AJUSTE.
 *
 * Se separa de `aplicarMovimiento` porque su entrada no es un delta sino el
 * resultado esperado: el usuario contó 47 unidades, no "quitó 3".
 */
export async function ajustarStock(
  tx: Prisma.TransactionClient,
  params: {
    negocioId: string;
    productoId: string;
    varianteId?: string | null;
    stockFinal: number;
    motivo: string;
    usuarioId?: string | null;
  }
) {
  const producto = await cargarProductoDelNegocio(tx, params.productoId, params.negocioId);
  if (producto.tipo === "SERVICIO") {
    throw new ErrorStock(`"${producto.nombre}" es un servicio: no tiene existencias que ajustar`);
  }
  await validarUnidadStock(tx, producto, params.varianteId);

  if (!Number.isInteger(params.stockFinal) || params.stockFinal < 0) {
    throw new ErrorStock("El stock final debe ser un entero mayor o igual a cero");
  }

  const stockAnterior = params.varianteId
    ? (await tx.productoVariante.findUniqueOrThrow({
        where: { id: params.varianteId },
        select: { stock: true },
      })).stock
    : (await tx.producto.findUniqueOrThrow({
        where: { id: producto.id },
        select: { stock: true },
      })).stock;

  if (stockAnterior === params.stockFinal) return null; // nada que ajustar

  if (params.varianteId) {
    await tx.productoVariante.update({
      where: { id: params.varianteId },
      data: { stock: params.stockFinal },
    });
    await sincronizarStockPadre(tx, producto.id);
  } else {
    await tx.producto.update({
      where: { id: producto.id },
      data: { stock: params.stockFinal },
    });
  }

  return tx.movimientoInventario.create({
    data: {
      negocioId: params.negocioId,
      productoId: producto.id,
      varianteId: params.varianteId ?? null,
      tipo: "AJUSTE",
      cantidad: Math.abs(params.stockFinal - stockAnterior),
      stockAnterior,
      stockResultante: params.stockFinal,
      motivo: params.motivo,
      referenciaTipo: "ajuste",
      usuarioId: params.usuarioId ?? null,
    },
  });
}

/** Recalcula `Producto.stock` como la suma del stock de sus variantes. */
export async function sincronizarStockPadre(
  tx: Prisma.TransactionClient,
  productoId: string
): Promise<void> {
  const agregado = await tx.productoVariante.aggregate({
    where: { productoId },
    _sum: { stock: true },
  });
  await tx.producto.update({
    where: { id: productoId },
    data: { stock: agregado._sum.stock ?? 0 },
  });
}

async function moverExistencias(
  tx: Prisma.TransactionClient,
  p: {
    productoId: string;
    varianteId: string | null;
    negocioId: string;
    cantidad: number;
    signo: 1 | -1;
    nombreProducto: string;
    permitirNegativo: boolean;
  }
): Promise<{ stockAnterior: number; stockResultante: number }> {
  if (p.signo === 1) {
    // Las entradas nunca fallan por disponibilidad: un `update` simple basta y
    // además devuelve el registro con el stock ya actualizado.
    const actualizado = p.varianteId
      ? await tx.productoVariante.update({
          where: { id: p.varianteId },
          data: { stock: { increment: p.cantidad } },
          select: { stock: true },
        })
      : await tx.producto.update({
          where: { id: p.productoId },
          data: { stock: { increment: p.cantidad } },
          select: { stock: true },
        });

    return {
      stockAnterior: actualizado.stock - p.cantidad,
      stockResultante: actualizado.stock,
    };
  }

  // Salida: la condición de disponibilidad va dentro del UPDATE (ver nota de
  // concurrencia en el encabezado de `aplicarMovimiento`).
  const condicionStock = p.permitirNegativo ? {} : { stock: { gte: p.cantidad } };

  const resultado = p.varianteId
    ? await tx.productoVariante.updateMany({
        where: { id: p.varianteId, ...condicionStock },
        data: { stock: { decrement: p.cantidad } },
      })
    : await tx.producto.updateMany({
        where: { id: p.productoId, negocioId: p.negocioId, ...condicionStock },
        data: { stock: { decrement: p.cantidad } },
      });

  if (resultado.count === 0) {
    throw new ErrorStock(`Stock insuficiente para "${p.nombreProducto}"`);
  }

  // Tras nuestro UPDATE la fila queda bloqueada hasta el commit, así que este
  // SELECT lee exactamente el valor que acabamos de escribir.
  const actual = p.varianteId
    ? await tx.productoVariante.findUniqueOrThrow({
        where: { id: p.varianteId },
        select: { stock: true },
      })
    : await tx.producto.findUniqueOrThrow({
        where: { id: p.productoId },
        select: { stock: true },
      });

  return {
    stockAnterior: actual.stock + p.cantidad,
    stockResultante: actual.stock,
  };
}

/**
 * Revierte todos los movimientos generados por un documento (venta o compra).
 * Se usa al anular: en vez de recalcular a mano qué sumar y qué restar, se
 * lee el kardex del documento y se aplica el movimiento inverso, dejando
 * además la reversión registrada como un movimiento más (nunca se borra
 * historial).
 */
export async function revertirMovimientosDeDocumento(
  tx: Prisma.TransactionClient,
  params: {
    negocioId: string;
    referenciaTipo: "venta" | "compra";
    referenciaId: string;
    usuarioId?: string | null;
    motivo?: string | null;
  }
) {
  const movimientos = await tx.movimientoInventario.findMany({
    where: {
      negocioId: params.negocioId,
      referenciaTipo: params.referenciaTipo,
      referenciaId: params.referenciaId,
      tipo: params.referenciaTipo === "venta" ? "VENTA" : "COMPRA",
    },
  });

  const tipoInverso: Exclude<TipoMovimiento, "AJUSTE"> =
    params.referenciaTipo === "venta" ? "ANULACION_VENTA" : "ANULACION_COMPRA";

  await Promise.all(
    movimientos.map((movimiento) =>
      aplicarMovimiento(tx, {
        negocioId: params.negocioId,
        productoId: movimiento.productoId,
        varianteId: movimiento.varianteId,
        tipo: tipoInverso,
        cantidad: movimiento.cantidad,
        costoUnitario: movimiento.costoUnitario,
        motivo: params.motivo ?? `Reversión de ${params.referenciaTipo}`,
        referenciaTipo: params.referenciaTipo,
        referenciaId: params.referenciaId,
        usuarioId: params.usuarioId,
        permitirNegativo: tipoInverso === "ANULACION_COMPRA",
      })
    )
  );

  return movimientos.length;
}
