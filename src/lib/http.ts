import { z } from "zod";

/**
 * Utilidades transversales de las rutas API: paginación y exportación CSV.
 */

const paginacionSchema = z.object({
  pagina: z.coerce.number().int().min(1).default(1),
  // Tope duro de 200: sin él, un `?limite=100000` obliga al servidor a
  // materializar toda la tabla de ventas de un negocio en memoria.
  limite: z.coerce.number().int().min(1).max(200).default(50),
});

export interface Paginacion {
  pagina: number;
  limite: number;
  skip: number;
}

export function parsePaginacion(searchParams: URLSearchParams): Paginacion {
  const { pagina, limite } = paginacionSchema.parse({
    pagina: searchParams.get("pagina") ?? undefined,
    limite: searchParams.get("limite") ?? undefined,
  });
  return { pagina, limite, skip: (pagina - 1) * limite };
}

export function metaPaginacion(total: number, { pagina, limite }: Paginacion) {
  return {
    total,
    pagina,
    limite,
    paginas: Math.max(1, Math.ceil(total / limite)),
  };
}

/** Lee un booleano de query string aceptando "true"/"1"/"si". */
export function leerBooleano(valor: string | null): boolean | undefined {
  if (valor === null) return undefined;
  const v = valor.toLowerCase();
  if (["true", "1", "si", "sí"].includes(v)) return true;
  if (["false", "0", "no"].includes(v)) return false;
  return undefined;
}

/**
 * Serializa filas a CSV.
 *
 * Se escribe a mano en vez de traer una dependencia porque el formato que
 * necesitamos es el mínimo de RFC 4180: comillas dobles alrededor de cada
 * campo y las comillas internas duplicadas. Eso ya cubre los tres caracteres
 * que rompen un CSV (coma, comilla y salto de línea) sin sumar supply chain.
 */
export function aCsv<T extends Record<string, unknown>>(
  filas: T[],
  columnas: Array<{ clave: keyof T & string; titulo: string }>
): string {
  const escapar = (valor: unknown): string => {
    if (valor === null || valor === undefined) return '""';
    const texto = valor instanceof Date ? valor.toISOString() : String(valor);
    return `"${texto.replace(/"/g, '""')}"`;
  };

  const encabezado = columnas.map((c) => escapar(c.titulo)).join(",");
  const cuerpo = filas.map((fila) => columnas.map((c) => escapar(fila[c.clave])).join(","));

  // El BOM UTF-8 hace que Excel en Windows abra el archivo con acentos
  // correctos; sin él, "Bogotá" se ve como "BogotÃ¡".
  return "﻿" + [encabezado, ...cuerpo].join("\r\n");
}

export function respuestaCsv(contenido: string, nombreArchivo: string): Response {
  return new Response(contenido, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${nombreArchivo}"`,
    },
  });
}

/** ¿El cliente pidió el reporte en CSV (`?formato=csv`)? */
export function quiereCsv(searchParams: URLSearchParams): boolean {
  return (searchParams.get("formato") ?? "").toLowerCase() === "csv";
}
