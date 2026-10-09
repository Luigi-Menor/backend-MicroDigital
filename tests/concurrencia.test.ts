import { beforeEach, describe, expect, it } from "vitest";
import { prisma, limpiarBD, reiniciarLimites, crearEscenario, cookieDe, llamar } from "./helpers";
import * as ventas from "@/app/api/ventas/route";

// RNF-007 — El descuento de stock y la numeración deben soportar solicitudes
// concurrentes sin duplicados ni stock negativo. Las peticiones se lanzan en
// paralelo contra la base real, así que compiten de verdad por las filas.
describe("Concurrencia", () => {
  beforeEach(async () => {
    await limpiarBD();
    reiniciarLimites();
  });

  const vender = (cookie: string, productoId: string, encabezados?: Record<string, string>) =>
    llamar(ventas.POST, {
      metodo: "POST",
      cookie,
      encabezados,
      cuerpo: { formaPago: "EFECTIVO", items: [{ productoId, cantidad: 1 }] },
    });

  it("PT-05: 10 ventas simultáneas de la última unidad -> solo una se registra y el stock queda en 0", async () => {
    const { a } = await crearEscenario({ stockA: 1 });
    const cookie = await cookieDe(a.admin);

    const resultados = await Promise.all(Array.from({ length: 10 }, () => vender(cookie, a.producto.id)));
    const exitosas = resultados.filter((r) => r.status === 201);
    const rechazadas = resultados.filter((r) => r.status === 409);

    expect(exitosas).toHaveLength(1);
    expect(rechazadas).toHaveLength(9);
    const producto = await prisma.producto.findUniqueOrThrow({ where: { id: a.producto.id } });
    expect(producto.stock).toBe(0);
    expect(await prisma.venta.count()).toBe(1);
    expect(await prisma.movimientoInventario.count({ where: { tipo: "VENTA" } })).toBe(1);
  });

  it("PT-06: 20 ventas simultáneas reciben consecutivos 1..20 sin duplicados", async () => {
    const { a } = await crearEscenario({ stockA: 100 });
    const cookie = await cookieDe(a.admin);

    const resultados = await Promise.all(Array.from({ length: 20 }, () => vender(cookie, a.producto.id)));
    expect(resultados.every((r) => r.status === 201)).toBe(true);

    const numeros = (await prisma.venta.findMany({ select: { numero: true } })).map((v) => v.numero).sort((x, y) => x - y);
    expect(numeros).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    const producto = await prisma.producto.findUniqueOrThrow({ where: { id: a.producto.id } });
    expect(producto.stock).toBe(80);
  });

  it("los consecutivos son independientes por negocio", async () => {
    const { a, b } = await crearEscenario();
    const [cA, cB] = [await cookieDe(a.admin), await cookieDe(b.admin)];
    await Promise.all([vender(cA, a.producto.id), vender(cB, b.producto.id), vender(cA, a.producto.id)]);
    const ventasA = await prisma.venta.findMany({ where: { negocioId: a.negocio.id }, select: { numero: true } });
    const ventasB = await prisma.venta.findMany({ where: { negocioId: b.negocio.id }, select: { numero: true } });
    expect(ventasA.map((v) => v.numero).sort()).toEqual([1, 2]);
    expect(ventasB.map((v) => v.numero)).toEqual([1]);
  });

  it("PT-08: la misma Idempotency-Key enviada 5 veces a la vez registra UNA sola venta", async () => {
    const { a } = await crearEscenario({ stockA: 10 });
    const cookie = await cookieDe(a.admin);
    const clave = { "Idempotency-Key": "doble-click-123" };

    const resultados = await Promise.all(Array.from({ length: 5 }, () => vender(cookie, a.producto.id, clave)));
    // Una se ejecuta; las demás reciben la respuesta guardada (201) o
    // "se está procesando" (409). Ninguna repite el efecto.
    expect(resultados.every((r) => r.status === 201 || r.status === 409)).toBe(true);
    expect(await prisma.venta.count()).toBe(1);
    expect((await prisma.producto.findUniqueOrThrow({ where: { id: a.producto.id } })).stock).toBe(9);
  });
});
