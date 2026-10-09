import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { hashPassword } from "@/lib/password";
import { firmarSesion, SESSION_COOKIE_NAME } from "@/lib/session";

export { prisma };

/** Vacía todas las tablas de la app (no la de migraciones de Prisma). */
export async function limpiarBD(): Promise<void> {
  const tablas = await prisma.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
  `;
  if (tablas.length === 0) return;
  const lista = tablas.map((t) => `"public"."${t.tablename}"`).join(", ");
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${lista} RESTART IDENTITY CASCADE`);
}

/** El límite de intentos vive en memoria del proceso: se reinicia entre pruebas. */
export function reiniciarLimites(): void {
  (globalThis as unknown as { limitesMicroDigital?: Map<string, unknown> }).limitesMicroDigital?.clear();
}

export const CLAVE = "ClaveDePrueba123";

async function crearNegocio(sufijo: string, stock: number) {
  const passwordHash = await hashPassword(CLAVE);
  const negocio = await prisma.negocio.create({
    data: { nombre: `Negocio ${sufijo}`, tipoNegocio: "Tienda", contacto: "3000000000" },
  });
  const admin = await prisma.usuario.create({
    data: { negocioId: negocio.id, nombre: `Admin ${sufijo}`, email: `admin.${sufijo}@test.local`, passwordHash, rol: "ADMINISTRADOR" },
  });
  const vendedor = await prisma.usuario.create({
    data: { negocioId: negocio.id, nombre: `Vendedor ${sufijo}`, email: `vendedor.${sufijo}@test.local`, passwordHash, rol: "VENDEDOR" },
  });
  const categoria = await prisma.categoria.create({ data: { negocioId: negocio.id, nombre: `Cat ${sufijo}` } });
  const categoriaGasto = await prisma.categoriaGasto.create({ data: { negocioId: negocio.id, nombre: `CatG ${sufijo}` } });
  const proveedor = await prisma.proveedor.create({ data: { negocioId: negocio.id, nombre: `Prov ${sufijo}` } });
  const cliente = await prisma.cliente.create({ data: { negocioId: negocio.id, nombre: `Cliente ${sufijo}` } });
  const producto = await prisma.producto.create({
    data: { negocioId: negocio.id, nombre: `Producto ${sufijo}`, precio: 1000, precioCosto: 600, stock, stockMinimo: 0, categoriaId: categoria.id },
  });
  return { negocio, admin, vendedor, categoria, categoriaGasto, proveedor, cliente, producto };
}

/** Dos negocios independientes: A es "el nuestro", B es el ajeno. */
export async function crearEscenario(opciones: { stockA?: number; stockB?: number } = {}) {
  const a = await crearNegocio("a", opciones.stockA ?? 10);
  const b = await crearNegocio("b", opciones.stockB ?? 10);
  return { a, b };
}

/** Cookie de sesión firmada como lo haría el login. */
export async function cookieDe(usuario: { id: string; negocioId: string | null; rol: "SUPERADMIN" | "ADMINISTRADOR" | "VENDEDOR"; email: string }) {
  const token = await firmarSesion({
    usuarioId: usuario.id,
    negocioId: usuario.negocioId,
    rol: usuario.rol,
    email: usuario.email,
  });
  return `${SESSION_COOKIE_NAME}=${token}`;
}

// `params` como any: cada ruta declara su propia forma ({ id }, { id, varianteId }...).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (req: NextRequest, ctx: { params: any }) => Promise<Response>;

/** Llama a un route handler de Next como si fuera una petición HTTP real. */
export async function llamar(
  handler: Handler,
  opciones: {
    metodo?: string;
    ruta?: string;
    cuerpo?: unknown;
    cookie?: string;
    params?: Record<string, string>;
    encabezados?: Record<string, string>;
  } = {}
): Promise<{ status: number; body: any; headers: Headers }> {
  const headers: Record<string, string> = { "content-type": "application/json", ...(opciones.encabezados ?? {}) };
  if (opciones.cookie) headers.cookie = opciones.cookie;
  const req = new NextRequest(`http://localhost:4000${opciones.ruta ?? "/"}`, {
    method: opciones.metodo ?? "GET",
    headers,
    body: opciones.cuerpo === undefined ? undefined : JSON.stringify(opciones.cuerpo),
  });
  const res = await handler(req, { params: opciones.params ?? {} });
  const texto = await res.text();
  let body: any = texto;
  try {
    body = JSON.parse(texto);
  } catch {
    /* respuesta no JSON (CSV, vacía) */
  }
  return { status: res.status, body, headers: res.headers };
}
