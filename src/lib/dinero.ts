import { Decimal } from "@prisma/client/runtime/library";

/**
 * Todo el dinero de la plataforma viaja como `Decimal` de Prisma, nunca como
 * `number`. Con `number` (float64) `0.1 + 0.2 !== 0.3`, y en un POS ese error
 * se acumula línea a línea hasta que el total impreso en el comprobante no
 * cuadra con la suma de sus renglones. Estas utilidades concentran la
 * conversión y el redondeo para que ningún handler improvise su propia
 * aritmética.
 */

/** Convierte cualquier entrada numérica a Decimal. `null`/`undefined` -> 0. */
export function D(valor: Decimal | number | string | null | undefined): Decimal {
  if (valor === null || valor === undefined) return new Decimal(0);
  return new Decimal(valor as Decimal.Value);
}

/**
 * Redondea a 2 decimales con "half up" (0.005 -> 0.01), que es como redondea
 * el comercio y como está declarada la columna `Decimal(12, 2)` en Postgres.
 * Si no se redondea antes de guardar, Postgres redondea igual pero por su
 * cuenta, y los totales calculados en memoria dejan de coincidir con los
 * persistidos.
 */
export function redondear(valor: Decimal | number | string): Decimal {
  return D(valor).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

export function sumar(...valores: Array<Decimal | number | string | null | undefined>): Decimal {
  return valores.reduce<Decimal>((acc, v) => acc.add(D(v)), new Decimal(0));
}

/** Aplica un porcentaje: porcentajeDe(1000, 19) -> 190.00 */
export function porcentajeDe(base: Decimal | number | string, porcentaje: Decimal | number | string): Decimal {
  return redondear(D(base).mul(D(porcentaje)).div(100));
}

export function esPositivo(valor: Decimal | number | string | null | undefined): boolean {
  return D(valor).greaterThan(0);
}

/**
 * Serializa Decimal -> number para el JSON de respuesta.
 *
 * Se hace explícito y en un solo lugar porque `JSON.stringify` de un Decimal
 * produce un string ("1500.00"), y el frontend que espera un número termina
 * concatenando en vez de sumar. Los montos de un micronegocio caben de sobra
 * en el rango seguro de float64, así que la conversión es inocua aquí (no lo
 * sería en cálculos, y por eso los cálculos nunca usan esta función).
 */
export function aNumero(valor: Decimal | number | string | null | undefined): number {
  if (valor === null || valor === undefined) return 0;
  return Number(D(valor).toFixed(2));
}

const formateadorMoneda = new Intl.NumberFormat("es-CO", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Formato legible para comprobantes: "$ 12.500,00" (estilo es-CO). */
export function formatearMoneda(
  valor: Decimal | number | string | null | undefined,
  simbolo = "$"
): string {
  const n = aNumero(valor);
  const formateado = formateadorMoneda.format(n);
  return `${simbolo} ${formateado}`;
}
