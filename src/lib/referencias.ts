import type { Prisma } from "@prisma/client";
import { ErrorNoEncontrado } from "./api-error";

/**
 * Aislamiento multi-tenant de las CLAVES FORÁNEAS que llegan en el cuerpo de
 * una petición (RN-025 / RNF-005).
 *
 * Filtrar por `negocioId` el registro principal no basta: si el cliente manda
 * `proveedorId` de OTRO negocio, Prisma lo acepta (la FK es simple, no
 * compuesta) y el `include` de la respuesta termina devolviendo datos ajenos.
 * Toda ruta que reciba un id de otra tabla desde el body debe pasarlo por aquí
 * antes de escribir.
 *
 * Responde 404 (no 403) a propósito: igual que en el resto de la API, no se
 * distingue "no existe" de "existe pero es de otro negocio".
 */
export async function validarReferenciasDelNegocio(
  db: Prisma.TransactionClient,
  negocioId: string,
  refs: {
    categoriaId?: string | null;
    categoriaGastoId?: string | null;
    proveedorId?: string | null;
  }
): Promise<void> {
  const [categoria, categoriaGasto, proveedor] = await Promise.all([
    refs.categoriaId
      ? db.categoria.findFirst({ where: { id: refs.categoriaId, negocioId }, select: { id: true } })
      : true,
    refs.categoriaGastoId
      ? db.categoriaGasto.findFirst({
          where: { id: refs.categoriaGastoId, negocioId },
          select: { id: true },
        })
      : true,
    refs.proveedorId
      ? db.proveedor.findFirst({ where: { id: refs.proveedorId, negocioId }, select: { id: true } })
      : true,
  ]);

  if (!categoria) throw new ErrorNoEncontrado("Categoría no encontrada");
  if (!categoriaGasto) throw new ErrorNoEncontrado("Categoría de gasto no encontrada");
  if (!proveedor) throw new ErrorNoEncontrado("Proveedor no encontrado");
}
