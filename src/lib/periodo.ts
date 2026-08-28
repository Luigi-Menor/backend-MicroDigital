import { z } from "zod";

/**
 * Resolución de rangos de fechas para estadísticas (módulo 8) y reportes
 * (módulo 9).
 *
 * NOTA SOBRE ZONA HORARIA: los cortes ("hoy", "esta semana") se calculan con
 * la hora local del servidor. Para un micronegocio con un único punto de venta
 * eso es lo correcto y lo esperado; si en el futuro un negocio opera en una
 * zona distinta a la del servidor, el corte del día se desplazaría y habría
 * que guardar la zona en `Negocio` y calcular aquí con ella.
 */

export const PERIODOS = ["hoy", "ayer", "semana", "mes", "anio", "todo"] as const;
export type Periodo = (typeof PERIODOS)[number];

export interface RangoFechas {
  desde: Date;
  hasta: Date;
  /** Etiqueta del período resuelto, útil para devolverla en la respuesta. */
  etiqueta: string;
}

export const rangoQuerySchema = z.object({
  periodo: z.enum(PERIODOS).optional(),
  desde: z.string().datetime().or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).optional(),
  hasta: z.string().datetime().or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).optional(),
});

function inicioDelDia(fecha: Date): Date {
  const d = new Date(fecha);
  d.setHours(0, 0, 0, 0);
  return d;
}

function finDelDia(fecha: Date): Date {
  const d = new Date(fecha);
  d.setHours(23, 59, 59, 999);
  return d;
}

/**
 * Convierte los parámetros de consulta en un rango cerrado [desde, hasta].
 *
 * Precedencia: si vienen `desde`/`hasta` explícitos, mandan sobre `periodo`.
 * Si no viene nada, el default es el mes en curso (el corte contable natural
 * de un micronegocio).
 *
 * Un `desde` sin `hasta` se interpreta como "desde esa fecha hasta ahora", y
 * un `hasta` sin `desde` como "todo lo anterior a esa fecha". Ambos casos son
 * los que un usuario espera al llenar un solo campo del filtro.
 */
export function resolverRango(searchParams: URLSearchParams): RangoFechas {
  const { periodo, desde, hasta } = rangoQuerySchema.parse({
    periodo: searchParams.get("periodo") ?? undefined,
    desde: searchParams.get("desde") ?? undefined,
    hasta: searchParams.get("hasta") ?? undefined,
  });

  if (desde || hasta) {
    const inicio = desde ? inicioDelDia(new Date(desde)) : new Date(0);
    const fin = hasta ? finDelDia(new Date(hasta)) : new Date();
    if (Number.isNaN(inicio.getTime()) || Number.isNaN(fin.getTime())) {
      throw new Error("Fechas inválidas: usa el formato YYYY-MM-DD");
    }
    if (inicio > fin) {
      throw new Error("La fecha 'desde' no puede ser posterior a 'hasta'");
    }
    return { desde: inicio, hasta: fin, etiqueta: "personalizado" };
  }

  return rangoDePeriodo(periodo ?? "mes");
}

export function rangoDePeriodo(periodo: Periodo): RangoFechas {
  const ahora = new Date();

  switch (periodo) {
    case "hoy":
      return { desde: inicioDelDia(ahora), hasta: finDelDia(ahora), etiqueta: "hoy" };

    case "ayer": {
      const ayer = new Date(ahora);
      ayer.setDate(ahora.getDate() - 1);
      return { desde: inicioDelDia(ayer), hasta: finDelDia(ayer), etiqueta: "ayer" };
    }

    case "semana": {
      // Semana que empieza en lunes (convención local, no la de getDay()
      // que arranca en domingo).
      const diaSemana = ahora.getDay() || 7; // domingo (0) -> 7
      const lunes = new Date(ahora);
      lunes.setDate(ahora.getDate() - diaSemana + 1);
      return { desde: inicioDelDia(lunes), hasta: finDelDia(ahora), etiqueta: "semana" };
    }

    case "anio":
      return {
        desde: new Date(ahora.getFullYear(), 0, 1),
        hasta: finDelDia(ahora),
        etiqueta: "anio",
      };

    case "todo":
      return { desde: new Date(0), hasta: finDelDia(ahora), etiqueta: "todo" };

    case "mes":
    default:
      return {
        desde: new Date(ahora.getFullYear(), ahora.getMonth(), 1),
        hasta: finDelDia(ahora),
        etiqueta: "mes",
      };
  }
}

/** Rango equivalente inmediatamente anterior, para comparativas "vs. período previo". */
export function rangoAnterior(rango: RangoFechas): RangoFechas {
  const duracion = rango.hasta.getTime() - rango.desde.getTime();
  return {
    desde: new Date(rango.desde.getTime() - duracion - 1),
    hasta: new Date(rango.desde.getTime() - 1),
    etiqueta: "anterior",
  };
}

/** Cláusula `where` de Prisma lista para el campo de fecha que corresponda. */
export function filtroFechas(rango: RangoFechas) {
  return { gte: rango.desde, lte: rango.hasta };
}

/** Clave de agrupación temporal para las series del módulo 8. */
export type Granularidad = "dia" | "semana" | "mes";

export function claveGranularidad(fecha: Date, granularidad: Granularidad): string {
  const anio = fecha.getFullYear();
  const mes = String(fecha.getMonth() + 1).padStart(2, "0");
  if (granularidad === "mes") return `${anio}-${mes}`;
  if (granularidad === "semana") {
    const lunes = new Date(fecha);
    lunes.setDate(fecha.getDate() - ((fecha.getDay() || 7) - 1));
    return `${lunes.getFullYear()}-${String(lunes.getMonth() + 1).padStart(2, "0")}-${String(
      lunes.getDate()
    ).padStart(2, "0")}`;
  }
  return `${anio}-${mes}-${String(fecha.getDate()).padStart(2, "0")}`;
}

/**
 * Elige automáticamente la granularidad según lo ancho que sea el rango, para
 * que una serie no devuelva 700 puntos cuando el usuario pidió "este año".
 */
export function granularidadAutomatica(rango: RangoFechas): Granularidad {
  const dias = (rango.hasta.getTime() - rango.desde.getTime()) / 86_400_000;
  if (dias <= 62) return "dia";
  if (dias <= 366) return "semana";
  return "mes";
}
