import type { NextRequest } from "next/server";

/**
 * Límite de intentos para las rutas públicas de autenticación (login,
 * registro, recuperación). Sin esto, la contraseña de cualquier cuenta queda
 * expuesta a fuerza bruta y el endpoint de recuperación a abuso.
 *
 * Ventana fija EN MEMORIA del proceso. Es suficiente mientras el backend corra
 * en una sola instancia (el despliegue actual). Con varias instancias detrás
 * de un balanceador, cada una llevaría su propio conteo y el límite efectivo
 * se multiplicaría: en ese momento hay que mover este estado a Redis (o
 * equivalente) sin cambiar la firma de `exigirLimite`.
 */

interface Ventana {
  conteo: number;
  reiniciaEn: number;
}

// En `globalThis` para sobrevivir a la recarga de módulos de `next dev`
// (mismo patrón que el singleton de Prisma en lib/db.ts).
const globalLimites = globalThis as unknown as { limitesMicroDigital?: Map<string, Ventana> };
const ventanas: Map<string, Ventana> =
  globalLimites.limitesMicroDigital ?? (globalLimites.limitesMicroDigital = new Map());

const MAXIMO_CLAVES_ANTES_DE_LIMPIAR = 10_000;

export class ErrorLimiteSolicitudes extends Error {
  constructor(public reintentarEnSegundos: number) {
    super("Demasiados intentos. Espera unos minutos e inténtalo de nuevo.");
  }
}

/**
 * Cuenta un intento para `clave` y lanza `ErrorLimiteSolicitudes` (429) si ya
 * se superó `maximo` dentro de la ventana. Cuenta todos los intentos, no solo
 * los fallidos: es más simple y, con los topes elegidos, un usuario legítimo
 * no llega a ellos.
 */
export function exigirLimite(clave: string, maximo: number, ventanaSegundos: number): void {
  const ahora = Date.now();

  // Sin esto el Map crecería sin límite con cada IP/correo nuevo.
  if (ventanas.size > MAXIMO_CLAVES_ANTES_DE_LIMPIAR) {
    ventanas.forEach((v, k) => {
      if (v.reiniciaEn <= ahora) ventanas.delete(k);
    });
  }

  const actual = ventanas.get(clave);
  if (!actual || actual.reiniciaEn <= ahora) {
    ventanas.set(clave, { conteo: 1, reiniciaEn: ahora + ventanaSegundos * 1000 });
    return;
  }

  actual.conteo += 1;
  if (actual.conteo > maximo) {
    throw new ErrorLimiteSolicitudes(Math.ceil((actual.reiniciaEn - ahora) / 1000));
  }
}

/**
 * IP del cliente. `X-Forwarded-For` solo es confiable si un proxy propio lo
 * reescribe; un atacante que hable directo con el backend puede falsearlo.
 * Por eso las rutas que reciben un correo limitan TAMBIÉN por correo, que no
 * se puede rotar para esquivar el límite.
 */
export function ipDeCliente(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    req.ip ||
    "desconocida"
  );
}

const MINUTO = 60;
const HORA = 60 * MINUTO;

/** Topes por ruta, en un solo lugar para poder ajustarlos sin buscar en cada handler. */
export const LIMITES = {
  loginPorIp: { maximo: 20, ventana: 15 * MINUTO },
  loginPorCorreo: { maximo: 10, ventana: 15 * MINUTO },
  registroPorIp: { maximo: 5, ventana: HORA },
  recuperarPorIp: { maximo: 10, ventana: 15 * MINUTO },
  recuperarPorCorreo: { maximo: 3, ventana: 15 * MINUTO },
  confirmarPorIp: { maximo: 10, ventana: 15 * MINUTO },
} as const;
