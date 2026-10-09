import { beforeEach, describe, expect, it } from "vitest";
import { prisma, limpiarBD, reiniciarLimites, crearEscenario, cookieDe, llamar } from "./helpers";
import * as ventas from "@/app/api/ventas/route";
import * as ventaId from "@/app/api/ventas/[id]/route";
import * as abonos from "@/app/api/fiados/abonos/route";
import * as compras from "@/app/api/compras/route";
import * as compraId from "@/app/api/compras/[id]/route";
import * as recibir from "@/app/api/compras/[id]/recibir/route";

// RNF-006 / RN-011..RN-016 — atomicidad de la venta, fiados e idempotencia.
describe("Integridad transaccional", () => {
  let e: Awaited<ReturnType<typeof crearEscenario>>;
  let cookie: string;

  beforeEach(async () => {
    await limpiarBD();
    reiniciarLimites();
    e = await crearEscenario({ stockA: 5 });
    cookie = await cookieDe(e.a.admin);
  });

  it("PT-07: si una línea falla, la venta completa se revierte (stock, venta, kardex y consecutivo)", async () => {
    const otro = await prisma.producto.create({
      data: { negocioId: e.a.negocio.id, nombre: "Escaso", precio: 500, stock: 1, stockMinimo: 0 },
    });
    const r = await llamar(ventas.POST, {
      metodo: "POST",
      cookie,
      cuerpo: {
        formaPago: "EFECTIVO",
        items: [
          { productoId: e.a.producto.id, cantidad: 2 },
          { productoId: otro.id, cantidad: 3 }, // no hay stock suficiente
        ],
      },
    });
    expect(r.status).toBe(409);
    expect((await prisma.producto.findUniqueOrThrow({ where: { id: e.a.producto.id } })).stock).toBe(5);
    expect((await prisma.producto.findUniqueOrThrow({ where: { id: otro.id } })).stock).toBe(1);
    expect(await prisma.venta.count()).toBe(0);
    expect(await prisma.movimientoInventario.count()).toBe(0);

    // El consecutivo consumido dentro de la transacción también se revirtió:
    // la siguiente venta válida es la número 1.
    const ok = await llamar(ventas.POST, {
      metodo: "POST",
      cookie,
      cuerpo: { formaPago: "EFECTIVO", items: [{ productoId: e.a.producto.id, cantidad: 1 }] },
    });
    expect(ok.status).toBe(201);
    expect(ok.body.venta.numero).toBe(1);
  });

  it("RN-012: el total cumple subtotal - descuento + impuesto", async () => {
    const r = await llamar(ventas.POST, {
      metodo: "POST",
      cookie,
      cuerpo: { formaPago: "EFECTIVO", descuento: 300, items: [{ productoId: e.a.producto.id, cantidad: 2 }] },
    });
    expect(r.status).toBe(201);
    const v = r.body.venta;
    expect(Number(v.subtotal)).toBe(2000);
    expect(Number(v.total)).toBe(Number(v.subtotal) - Number(v.descuento) + Number(v.impuesto));
    expect(Number(v.total)).toBe(1700);
  });

  it("RN-014: una venta fiada sin cliente se rechaza", async () => {
    const r = await llamar(ventas.POST, {
      metodo: "POST",
      cookie,
      cuerpo: { formaPago: "FIADO", items: [{ productoId: e.a.producto.id, cantidad: 1 }] },
    });
    expect(r.status).toBe(400);
    expect(await prisma.venta.count()).toBe(0);
  });

  it("PT-09: fiado y abonos mantienen el saldo; un abono no puede superar la deuda", async () => {
    const venta = await llamar(ventas.POST, {
      metodo: "POST",
      cookie,
      cuerpo: { formaPago: "FIADO", clienteId: e.a.cliente.id, items: [{ productoId: e.a.producto.id, cantidad: 3 }] },
    });
    expect(venta.status).toBe(201);
    const saldo = async () => Number((await prisma.cliente.findUniqueOrThrow({ where: { id: e.a.cliente.id } })).saldoDeuda);
    expect(await saldo()).toBe(3000);

    const excesivo = await llamar(abonos.POST, { metodo: "POST", cookie, cuerpo: { clienteId: e.a.cliente.id, monto: 3001 } });
    expect(excesivo.status).toBe(409);
    expect(await saldo()).toBe(3000);

    const parcial = await llamar(abonos.POST, { metodo: "POST", cookie, cuerpo: { clienteId: e.a.cliente.id, monto: 1000 } });
    expect(parcial.status).toBe(201);
    expect(await saldo()).toBe(2000);
  });

  it("anular una venta devuelve el stock y exige motivo", async () => {
    const venta = await llamar(ventas.POST, {
      metodo: "POST",
      cookie,
      cuerpo: { formaPago: "EFECTIVO", items: [{ productoId: e.a.producto.id, cantidad: 2 }] },
    });
    expect((await prisma.producto.findUniqueOrThrow({ where: { id: e.a.producto.id } })).stock).toBe(3);

    const sinMotivo = await llamar(ventaId.PUT, {
      metodo: "PUT", cookie, params: { id: venta.body.venta.id }, cuerpo: { accion: "ANULADA" },
    });
    expect(sinMotivo.status).toBe(400);

    const anulada = await llamar(ventaId.PUT, {
      metodo: "PUT", cookie, params: { id: venta.body.venta.id }, cuerpo: { accion: "ANULADA", motivo: "Error de digitación" },
    });
    expect(anulada.status).toBe(200);
    expect((await prisma.producto.findUniqueOrThrow({ where: { id: e.a.producto.id } })).stock).toBe(5);
    const auditoria = await prisma.ventaAuditoria.findFirst({ where: { ventaId: venta.body.venta.id } });
    expect(auditoria?.accion).toBe("ANULADA");
    expect(auditoria?.motivo).toBe("Error de digitación");
  });

  it("idempotencia: reintentar con la misma clave devuelve la misma venta sin repetirla", async () => {
    const enviar = () =>
      llamar(ventas.POST, {
        metodo: "POST",
        cookie,
        encabezados: { "Idempotency-Key": "reintento-1" },
        cuerpo: { formaPago: "EFECTIVO", items: [{ productoId: e.a.producto.id, cantidad: 1 }] },
      });
    const primera = await enviar();
    const segunda = await enviar();
    expect(primera.status).toBe(201);
    expect(segunda.status).toBe(201);
    expect(segunda.body.venta.id).toBe(primera.body.venta.id);
    expect(segunda.headers.get("Idempotent-Replay")).toBe("true");
    expect(await prisma.venta.count()).toBe(1);
  });
  it("RN-017..RN-019: una compra en borrador no toca el stock; recibirla suma; anularla revierte", async () => {
    const otro = await prisma.producto.create({
      data: { negocioId: e.a.negocio.id, nombre: "Insumo", precio: 300, stock: 0, stockMinimo: 0 },
    });
    const stock = async (id: string) => (await prisma.producto.findUniqueOrThrow({ where: { id } })).stock;

    const compra = await llamar(compras.POST, {
      metodo: "POST",
      cookie,
      cuerpo: {
        proveedorId: e.a.proveedor.id,
        formaPago: "EFECTIVO",
        items: [
          { productoId: e.a.producto.id, cantidad: 4, costoUnitario: 500 },
          { productoId: otro.id, cantidad: 7, costoUnitario: 100 },
        ],
      },
    });
    expect(compra.status).toBe(201);
    const id = compra.body.compra.id;
    expect(await stock(e.a.producto.id)).toBe(5); // borrador: sin cambios
    expect(await stock(otro.id)).toBe(0);

    expect((await llamar(recibir.POST, { metodo: "POST", cookie, params: { id } })).status).toBe(200);
    expect(await stock(e.a.producto.id)).toBe(9);
    expect(await stock(otro.id)).toBe(7);
    // Recibir dos veces no vuelve a sumar (RN-018).
    expect((await llamar(recibir.POST, { metodo: "POST", cookie, params: { id } })).status).toBe(409);
    expect(await stock(e.a.producto.id)).toBe(9);

    const anulada = await llamar(compraId.PUT, {
      metodo: "PUT", cookie, params: { id }, cuerpo: { accion: "ANULAR", motivo: "Proveedor equivocado" },
    });
    expect(anulada.status).toBe(200);
    expect(await stock(e.a.producto.id)).toBe(5);
    expect(await stock(otro.id)).toBe(0);
  });
});
