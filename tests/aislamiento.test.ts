import { beforeEach, describe, expect, it } from "vitest";
import { prisma, limpiarBD, reiniciarLimites, crearEscenario, cookieDe, llamar } from "./helpers";
import * as productoId from "@/app/api/productos/[id]/route";
import * as productos from "@/app/api/productos/route";
import * as gastos from "@/app/api/gastos/route";
import * as gastoId from "@/app/api/gastos/[id]/route";
import * as clientes from "@/app/api/clientes/route";
import * as recalcular from "@/app/api/fiados/recalcular/route";
import * as ventas from "@/app/api/ventas/route";

// RNF-005 / RN-025 — Ningún usuario puede leer ni modificar datos de otro
// negocio, ni enlazar sus registros a registros ajenos.
describe("Aislamiento entre negocios", () => {
  let e: Awaited<ReturnType<typeof crearEscenario>>;
  let cookieA: string;

  beforeEach(async () => {
    await limpiarBD();
    reiniciarLimites();
    e = await crearEscenario();
    cookieA = await cookieDe(e.a.admin);
  });

  it("PT-01: no puede leer un producto de otro negocio (404, no 403)", async () => {
    const r = await llamar(productoId.GET, { cookie: cookieA, params: { id: e.b.producto.id } });
    expect(r.status).toBe(404);
  });

  it("los listados solo devuelven registros del propio negocio", async () => {
    const r = await llamar(clientes.GET, { ruta: "/api/clientes", cookie: cookieA });
    expect(r.status).toBe(200);
    const ids = r.body.clientes.map((c: { id: string }) => c.id);
    expect(ids).toContain(e.a.cliente.id);
    expect(ids).not.toContain(e.b.cliente.id);
  });

  it("PT-02: un gasto no se puede enlazar a un proveedor de otro negocio", async () => {
    const r = await llamar(gastos.POST, {
      metodo: "POST",
      cookie: cookieA,
      cuerpo: { descripcion: "Prueba", monto: 100, proveedorId: e.b.proveedor.id },
    });
    expect(r.status).toBe(404);
    expect(await prisma.gasto.count()).toBe(0);
  });

  it("un gasto existente no se puede reasignar a una categoría de otro negocio", async () => {
    const gasto = await prisma.gasto.create({
      data: { negocioId: e.a.negocio.id, numero: 1, descripcion: "Luz", monto: 50, usuarioId: e.a.admin.id },
    });
    const r = await llamar(gastoId.PUT, {
      metodo: "PUT",
      cookie: cookieA,
      params: { id: gasto.id },
      cuerpo: { categoriaGastoId: e.b.categoriaGasto.id },
    });
    expect(r.status).toBe(404);
    const tras = await prisma.gasto.findUniqueOrThrow({ where: { id: gasto.id } });
    expect(tras.categoriaGastoId).toBeNull();
  });

  it("un producto no se puede crear con una categoría de otro negocio", async () => {
    const antes = await prisma.producto.count();
    const r = await llamar(productos.POST, {
      metodo: "POST",
      cookie: cookieA,
      cuerpo: { nombre: "Servicio X", tipo: "SERVICIO", precio: 10, categoriaId: e.b.categoria.id },
    });
    expect(r.status).toBe(404);
    expect(await prisma.producto.count()).toBe(antes);
  });

  it("recalcular saldos no puede modificar un cliente de otro negocio", async () => {
    await prisma.cliente.update({ where: { id: e.b.cliente.id }, data: { saldoDeuda: 50_000 } });
    const r = await llamar(recalcular.POST, {
      metodo: "POST",
      cookie: cookieA,
      cuerpo: { clienteId: e.b.cliente.id },
    });
    expect(r.status).toBe(409);
    const clienteB = await prisma.cliente.findUniqueOrThrow({ where: { id: e.b.cliente.id } });
    expect(Number(clienteB.saldoDeuda)).toBe(50_000);
  });

  it("una venta no puede usar la variante de un producto de otro negocio", async () => {
    const varianteB = await prisma.productoVariante.create({
      data: { productoId: e.b.producto.id, nombre: "Talla M", stock: 5 },
    });
    const r = await llamar(ventas.POST, {
      metodo: "POST",
      cookie: cookieA,
      cuerpo: {
        formaPago: "EFECTIVO",
        items: [{ productoId: e.a.producto.id, varianteId: varianteB.id, cantidad: 1 }],
      },
    });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(await prisma.venta.count()).toBe(0);
    const tras = await prisma.productoVariante.findUniqueOrThrow({ where: { id: varianteB.id } });
    expect(tras.stock).toBe(5);
  });
});
