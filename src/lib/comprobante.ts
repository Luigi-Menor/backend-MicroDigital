import type { Prisma, TipoComprobante, TipoConsecutivo } from "@prisma/client";
import { aNumero, formatearMoneda } from "./dinero";
import { construirFolio, siguienteConsecutivo } from "./consecutivos";

/**
 * Módulo 11 — Comprobantes digitales.
 *
 * POR QUÉ SE GUARDA UN SNAPSHOT Y NO SOLO LA REFERENCIA A LA VENTA:
 * un comprobante es un documento entregado a un tercero; una vez emitido no
 * puede cambiar. Si se re-renderizara leyendo las tablas vivas, subir el
 * precio de un producto o corregir la dirección del negocio reescribiría
 * retroactivamente comprobantes ya entregados al cliente. El `snapshot` JSON
 * congela el documento tal como se emitió, y las tablas vivas quedan libres
 * de evolucionar.
 */

export type OrigenComprobante =
  | { clase: "venta"; ventaId: string }
  | { clase: "abono"; abonoId: string };

export interface LineaComprobante {
  descripcion: string;
  cantidad: number;
  precioUnitario: number;
  descuento: number;
  subtotal: number;
}

export interface SnapshotComprobante {
  folio: string;
  tipo: TipoComprobante;
  emitidoEn: string;
  negocio: {
    nombre: string;
    nit: string | null;
    direccion: string | null;
    contacto: string;
    logoUrl: string | null;
    simboloMoneda: string;
    moneda: string;
  };
  cliente: { nombre: string; documento: string | null; contacto: string | null } | null;
  vendedor: { nombre: string };
  documento: {
    clase: "venta" | "abono";
    id: string;
    numero: number;
    fecha: string;
    formaPago: string;
    estado?: string;
  };
  lineas: LineaComprobante[];
  totales: {
    subtotal: number;
    descuento: number;
    impuesto: number;
    total: number;
    montoPagado: number | null;
    cambio: number | null;
    saldoPendiente: number;
  };
  nota: string | null;
}

/** Cada tipo de comprobante lleva su propia serie de numeración. */
const CONSECUTIVO_POR_TIPO: Record<TipoComprobante, TipoConsecutivo> = {
  TICKET: "TICKET",
  FACTURA: "FACTURA",
  RECIBO: "RECIBO",
  COTIZACION: "COTIZACION",
  COMPROBANTE_ABONO: "COMPROBANTE_ABONO",
};

export class ErrorComprobante extends Error {}

/**
 * Emite un comprobante para una venta o un abono.
 * Debe llamarse dentro de una transacción: consume un consecutivo, y ese
 * consumo tiene que deshacerse junto con el documento si algo falla después.
 */
export async function emitirComprobante(
  tx: Prisma.TransactionClient,
  params: {
    negocioId: string;
    usuarioId: string;
    tipo: TipoComprobante;
    serie?: string;
    origen: OrigenComprobante;
  }
) {
  const serie = params.serie ?? "A";
  const [negocio, numero] = await Promise.all([
    tx.negocio.findUniqueOrThrow({
      where: { id: params.negocioId },
      select: {
        nombre: true,
        nit: true,
        direccion: true,
        contacto: true,
        logoUrl: true,
        simboloMoneda: true,
        moneda: true,
      },
    }),
    siguienteConsecutivo(
      tx,
      params.negocioId,
      CONSECUTIVO_POR_TIPO[params.tipo],
      serie
    ),
  ]);
  const folio = construirFolio(params.tipo, serie, numero);

  const snapshot =
    params.origen.clase === "venta"
      ? await snapshotDeVenta(tx, params, negocio, folio)
      : await snapshotDeAbono(tx, params, negocio, folio);

  return tx.comprobante.create({
    data: {
      negocioId: params.negocioId,
      tipo: params.tipo,
      serie,
      numero,
      folio,
      ventaId: params.origen.clase === "venta" ? params.origen.ventaId : null,
      abonoId: params.origen.clase === "abono" ? params.origen.abonoId : null,
      snapshot: snapshot as unknown as Prisma.InputJsonValue,
      total: snapshot.totales.total,
      usuarioId: params.usuarioId,
    },
  });
}

type DatosNegocio = SnapshotComprobante["negocio"];

async function snapshotDeVenta(
  tx: Prisma.TransactionClient,
  params: { negocioId: string; tipo: TipoComprobante; origen: OrigenComprobante },
  negocio: DatosNegocio,
  folio: string
): Promise<SnapshotComprobante> {
  if (params.origen.clase !== "venta") throw new ErrorComprobante("Origen inválido");

  const venta = await tx.venta.findFirst({
    where: { id: params.origen.ventaId, negocioId: params.negocioId },
    include: {
      detalles: { include: { producto: true, variante: true } },
      cliente: true,
      usuario: { select: { nombre: true } },
    },
  });
  if (!venta) throw new ErrorComprobante("Venta no encontrada en este negocio");
  if (venta.estado === "ANULADA") {
    throw new ErrorComprobante("No se puede emitir un comprobante de una venta anulada");
  }

  return {
    folio,
    tipo: params.tipo,
    emitidoEn: new Date().toISOString(),
    negocio,
    cliente: venta.cliente
      ? {
          nombre: venta.cliente.nombre,
          documento: venta.cliente.documento,
          contacto: venta.cliente.contacto,
        }
      : null,
    vendedor: { nombre: venta.usuario.nombre },
    documento: {
      clase: "venta",
      id: venta.id,
      numero: venta.numero,
      fecha: venta.createdAt.toISOString(),
      formaPago: venta.formaPago,
      estado: venta.estado,
    },
    lineas: venta.detalles.map((detalle) => ({
      // `descripcion` se congeló al vender; el nombre vivo del producto solo
      // se usa como respaldo para datos previos a esa columna.
      descripcion:
        detalle.descripcion ??
        [detalle.producto.nombre, detalle.variante?.nombre].filter(Boolean).join(" - "),
      cantidad: detalle.cantidad,
      precioUnitario: aNumero(detalle.precioUnitario),
      descuento: aNumero(detalle.descuento),
      subtotal: aNumero(detalle.subtotal),
    })),
    totales: {
      subtotal: aNumero(venta.subtotal),
      descuento: aNumero(venta.descuento),
      impuesto: aNumero(venta.impuesto),
      total: aNumero(venta.total),
      montoPagado: venta.montoPagado ? aNumero(venta.montoPagado) : null,
      cambio: venta.cambio ? aNumero(venta.cambio) : null,
      saldoPendiente: aNumero(venta.saldoPendiente),
    },
    nota: venta.nota,
  };
}

async function snapshotDeAbono(
  tx: Prisma.TransactionClient,
  params: { negocioId: string; tipo: TipoComprobante; origen: OrigenComprobante },
  negocio: DatosNegocio,
  folio: string
): Promise<SnapshotComprobante> {
  if (params.origen.clase !== "abono") throw new ErrorComprobante("Origen inválido");

  const abono = await tx.abono.findFirst({
    where: { id: params.origen.abonoId, negocioId: params.negocioId },
    include: { cliente: true, usuario: { select: { nombre: true } } },
  });
  if (!abono) throw new ErrorComprobante("Abono no encontrado en este negocio");

  const monto = aNumero(abono.monto);

  return {
    folio,
    tipo: params.tipo,
    emitidoEn: new Date().toISOString(),
    negocio,
    cliente: {
      nombre: abono.cliente.nombre,
      documento: abono.cliente.documento,
      contacto: abono.cliente.contacto,
    },
    vendedor: { nombre: abono.usuario.nombre },
    documento: {
      clase: "abono",
      id: abono.id,
      numero: abono.numero,
      fecha: abono.createdAt.toISOString(),
      formaPago: abono.formaPago,
    },
    lineas: [
      {
        descripcion: `Abono a cuenta de ${abono.cliente.nombre}`,
        cantidad: 1,
        precioUnitario: monto,
        descuento: 0,
        subtotal: monto,
      },
    ],
    totales: {
      subtotal: monto,
      descuento: 0,
      impuesto: 0,
      total: monto,
      montoPagado: monto,
      cambio: null,
      // Deuda que le queda al cliente DESPUÉS de este abono: es el dato por el
      // que pregunta el cliente al recibir el recibo.
      saldoPendiente: aNumero(abono.cliente.saldoDeuda),
    },
    nota: abono.nota,
  };
}

const ANCHO_TICKET = 40;

/**
 * Renderiza el comprobante como texto plano de 40 columnas: el formato que
 * entienden las impresoras térmicas de 80 mm y que además se puede pegar tal
 * cual en un mensaje de WhatsApp, que es como la mayoría de micronegocios
 * entrega el comprobante.
 */
export function renderizarTexto(snapshot: SnapshotComprobante): string {
  const simbolo = snapshot.negocio.simboloMoneda;
  const linea = (car = "-") => car.repeat(ANCHO_TICKET);
  const centrar = (texto: string) => {
    const t = texto.slice(0, ANCHO_TICKET);
    const izq = Math.max(0, Math.floor((ANCHO_TICKET - t.length) / 2));
    return " ".repeat(izq) + t;
  };
  const parEnLinea = (etiqueta: string, valor: string) => {
    const espacio = Math.max(1, ANCHO_TICKET - etiqueta.length - valor.length);
    return etiqueta + " ".repeat(espacio) + valor;
  };

  const out: string[] = [];
  out.push(centrar(snapshot.negocio.nombre.toUpperCase()));
  if (snapshot.negocio.nit) out.push(centrar(`NIT: ${snapshot.negocio.nit}`));
  if (snapshot.negocio.direccion) out.push(centrar(snapshot.negocio.direccion));
  out.push(centrar(snapshot.negocio.contacto));
  out.push(linea("="));
  out.push(centrar(snapshot.tipo.replace(/_/g, " ")));
  out.push(centrar(snapshot.folio));
  out.push(linea());
  out.push(parEnLinea("Fecha:", new Date(snapshot.documento.fecha).toLocaleString("es-CO")));
  out.push(parEnLinea("Atendió:", snapshot.vendedor.nombre));
  if (snapshot.cliente) out.push(parEnLinea("Cliente:", snapshot.cliente.nombre));
  out.push(parEnLinea("Pago:", snapshot.documento.formaPago));
  out.push(linea());

  for (const item of snapshot.lineas) {
    out.push(item.descripcion.slice(0, ANCHO_TICKET));
    const detalle = `  ${item.cantidad} x ${formatearMoneda(item.precioUnitario, simbolo)}`;
    out.push(parEnLinea(detalle, formatearMoneda(item.subtotal, simbolo)));
    if (item.descuento > 0) {
      out.push(parEnLinea("  Descuento", `-${formatearMoneda(item.descuento, simbolo)}`));
    }
  }

  out.push(linea());
  out.push(parEnLinea("Subtotal", formatearMoneda(snapshot.totales.subtotal, simbolo)));
  if (snapshot.totales.descuento > 0) {
    out.push(parEnLinea("Descuento", `-${formatearMoneda(snapshot.totales.descuento, simbolo)}`));
  }
  if (snapshot.totales.impuesto > 0) {
    out.push(parEnLinea("Impuesto", formatearMoneda(snapshot.totales.impuesto, simbolo)));
  }
  out.push(parEnLinea("TOTAL", formatearMoneda(snapshot.totales.total, simbolo)));

  if (snapshot.totales.montoPagado !== null) {
    out.push(parEnLinea("Recibido", formatearMoneda(snapshot.totales.montoPagado, simbolo)));
  }
  if (snapshot.totales.cambio !== null) {
    out.push(parEnLinea("Cambio", formatearMoneda(snapshot.totales.cambio, simbolo)));
  }
  if (snapshot.totales.saldoPendiente > 0) {
    out.push(parEnLinea("SALDO PENDIENTE", formatearMoneda(snapshot.totales.saldoPendiente, simbolo)));
  }

  out.push(linea("="));
  if (snapshot.nota) {
    out.push(snapshot.nota.slice(0, ANCHO_TICKET * 3));
    out.push(linea());
  }
  out.push(centrar("¡Gracias por su compra!"));
  out.push("");

  return out.join("\n");
}

/** Escapa texto que se inyecta en el HTML del comprobante. */
function escaparHtml(texto: string): string {
  return texto
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Versión HTML imprimible/compartible. Es un documento autocontenido (estilos
 * en línea) para que se vea igual abierto desde un enlace, guardado como
 * archivo o impreso, sin depender de assets del frontend.
 */
export function renderizarHtml(snapshot: SnapshotComprobante): string {
  const simbolo = snapshot.negocio.simboloMoneda;
  const money = (v: number) => escaparHtml(formatearMoneda(v, simbolo));

  const filas = snapshot.lineas
    .map(
      (item) => `
      <tr>
        <td>${escaparHtml(item.descripcion)}${
          item.descuento > 0
            ? `<br><small>Descuento: -${money(item.descuento)}</small>`
            : ""
        }</td>
        <td class="num">${item.cantidad}</td>
        <td class="num">${money(item.precioUnitario)}</td>
        <td class="num">${money(item.subtotal)}</td>
      </tr>`
    )
    .join("");

  const filaOpcional = (etiqueta: string, valor: number | null, condicion = true) =>
    valor !== null && condicion
      ? `<tr><td colspan="3" class="num">${escaparHtml(etiqueta)}</td><td class="num">${money(valor)}</td></tr>`
      : "";

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escaparHtml(snapshot.folio)}</title>
<style>
  :root { color-scheme: light; }
  body { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
         background: #f4f4f5; margin: 0; padding: 24px; color: #18181b; }
  .doc { max-width: 620px; margin: 0 auto; background: #fff; padding: 32px;
         border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,.12); }
  header { text-align: center; border-bottom: 2px solid #18181b; padding-bottom: 16px; }
  h1 { font-size: 20px; margin: 0 0 4px; letter-spacing: .04em; }
  .meta { font-size: 13px; color: #52525b; }
  .folio { display: inline-block; margin-top: 12px; padding: 4px 12px;
           background: #18181b; color: #fff; border-radius: 999px;
           font-size: 12px; letter-spacing: .08em; }
  dl { display: grid; grid-template-columns: auto 1fr; gap: 4px 16px;
       font-size: 14px; margin: 20px 0; }
  dt { color: #71717a; }
  dd { margin: 0; text-align: right; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; margin-top: 8px; }
  th, td { padding: 8px 4px; border-bottom: 1px solid #e4e4e7; text-align: left; vertical-align: top; }
  th { font-size: 12px; text-transform: uppercase; color: #71717a; letter-spacing: .05em; }
  .num { text-align: right; white-space: nowrap; }
  small { color: #71717a; }
  .total td { font-weight: 700; font-size: 17px; border-top: 2px solid #18181b; border-bottom: none; }
  .pendiente td { color: #b91c1c; font-weight: 600; }
  footer { margin-top: 24px; text-align: center; font-size: 13px; color: #71717a; }
  @media print { body { background: #fff; padding: 0; } .doc { box-shadow: none; } }
</style>
</head>
<body>
  <div class="doc">
    <header>
      <h1>${escaparHtml(snapshot.negocio.nombre)}</h1>
      <div class="meta">
        ${snapshot.negocio.nit ? `NIT: ${escaparHtml(snapshot.negocio.nit)}<br>` : ""}
        ${snapshot.negocio.direccion ? `${escaparHtml(snapshot.negocio.direccion)}<br>` : ""}
        ${escaparHtml(snapshot.negocio.contacto)}
      </div>
      <div class="folio">${escaparHtml(snapshot.tipo.replace(/_/g, " "))} · ${escaparHtml(snapshot.folio)}</div>
    </header>

    <dl>
      <dt>Fecha</dt><dd>${escaparHtml(new Date(snapshot.documento.fecha).toLocaleString("es-CO"))}</dd>
      <dt>Atendió</dt><dd>${escaparHtml(snapshot.vendedor.nombre)}</dd>
      ${snapshot.cliente ? `<dt>Cliente</dt><dd>${escaparHtml(snapshot.cliente.nombre)}</dd>` : ""}
      <dt>Forma de pago</dt><dd>${escaparHtml(snapshot.documento.formaPago)}</dd>
    </dl>

    <table>
      <thead>
        <tr><th>Descripción</th><th class="num">Cant.</th><th class="num">Precio</th><th class="num">Importe</th></tr>
      </thead>
      <tbody>${filas}</tbody>
      <tfoot>
        ${filaOpcional("Subtotal", snapshot.totales.subtotal)}
        ${filaOpcional("Descuento", snapshot.totales.descuento, snapshot.totales.descuento > 0)}
        ${filaOpcional("Impuesto", snapshot.totales.impuesto, snapshot.totales.impuesto > 0)}
        <tr class="total"><td colspan="3" class="num">TOTAL</td><td class="num">${money(snapshot.totales.total)}</td></tr>
        ${filaOpcional("Recibido", snapshot.totales.montoPagado)}
        ${filaOpcional("Cambio", snapshot.totales.cambio)}
        ${
          snapshot.totales.saldoPendiente > 0
            ? `<tr class="pendiente"><td colspan="3" class="num">Saldo pendiente</td><td class="num">${money(snapshot.totales.saldoPendiente)}</td></tr>`
            : ""
        }
      </tfoot>
    </table>

    ${snapshot.nota ? `<p><small>${escaparHtml(snapshot.nota)}</small></p>` : ""}
    <footer>¡Gracias por su compra!</footer>
  </div>
</body>
</html>`;
}

/** Texto listo para enviar por WhatsApp (wa.me admite el cuerpo url-encoded). */
export function enlaceWhatsapp(telefono: string, texto: string): string {
  const numero = telefono.replace(/\D/g, "");
  return `https://wa.me/${numero}?text=${encodeURIComponent(texto)}`;
}
