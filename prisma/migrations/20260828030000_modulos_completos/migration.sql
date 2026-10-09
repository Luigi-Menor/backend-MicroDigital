-- CreateEnum
CREATE TYPE "TipoItem" AS ENUM ('PRODUCTO', 'SERVICIO');

-- CreateEnum
CREATE TYPE "TipoMovimiento" AS ENUM ('ENTRADA', 'SALIDA', 'AJUSTE', 'MERMA', 'VENTA', 'ANULACION_VENTA', 'COMPRA', 'ANULACION_COMPRA');

-- CreateEnum
CREATE TYPE "EstadoCompra" AS ENUM ('BORRADOR', 'RECIBIDA', 'ANULADA');

-- CreateEnum
CREATE TYPE "EstadoComprobante" AS ENUM ('EMITIDO', 'ANULADO');

-- CreateEnum
CREATE TYPE "TipoComprobante" AS ENUM ('TICKET', 'FACTURA', 'RECIBO', 'COTIZACION', 'COMPROBANTE_ABONO');

-- CreateEnum
CREATE TYPE "MedioEnvio" AS ENUM ('WHATSAPP', 'EMAIL', 'SMS', 'DESCARGA');

-- CreateEnum
CREATE TYPE "TipoConsecutivo" AS ENUM ('VENTA', 'TICKET', 'FACTURA', 'RECIBO', 'COTIZACION', 'COMPROBANTE_ABONO', 'COMPRA', 'GASTO', 'ABONO');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "FormaPago" ADD VALUE 'TARJETA';
ALTER TYPE "FormaPago" ADD VALUE 'OTRO';

-- DropIndex
DROP INDEX "ventas_negocioId_idx";

-- AlterTable
ALTER TABLE "categorias" ADD COLUMN     "activo" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "clientes" ADD COLUMN     "activo" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "direccion" TEXT,
ADD COLUMN     "documento" TEXT,
ADD COLUMN     "email" TEXT,
ADD COLUMN     "limiteCredito" DECIMAL(12,2),
ADD COLUMN     "notas" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "negocios" ADD COLUMN     "activo" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "direccion" TEXT,
ADD COLUMN     "impuestoPorcentaje" DECIMAL(5,2) NOT NULL DEFAULT 0,
ADD COLUMN     "logoUrl" TEXT,
ADD COLUMN     "moneda" TEXT NOT NULL DEFAULT 'COP',
ADD COLUMN     "nit" TEXT,
ADD COLUMN     "simboloMoneda" TEXT NOT NULL DEFAULT '$',
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "productos" ADD COLUMN     "activo" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "descripcion" TEXT,
ADD COLUMN     "precioCosto" DECIMAL(12,2),
ADD COLUMN     "sku" TEXT,
ADD COLUMN     "tipo" "TipoItem" NOT NULL DEFAULT 'PRODUCTO',
ADD COLUMN     "unidad" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "usuarios" ADD COLUMN     "cargo" TEXT,
ADD COLUMN     "documento" TEXT,
ADD COLUMN     "fechaIngreso" TIMESTAMP(3),
ADD COLUMN     "metaVentasMensual" DECIMAL(12,2),
ADD COLUMN     "salarioBase" DECIMAL(12,2),
ADD COLUMN     "telefono" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "venta_detalles" ADD COLUMN     "costoUnitario" DECIMAL(12,2),
ADD COLUMN     "descripcion" TEXT,
ADD COLUMN     "descuento" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "subtotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "varianteId" TEXT;

-- AlterTable
ALTER TABLE "ventas" ADD COLUMN     "cambio" DECIMAL(12,2),
ADD COLUMN     "descuento" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "impuesto" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "montoPagado" DECIMAL(12,2),
ADD COLUMN     "nota" TEXT,
ADD COLUMN     "numero" INTEGER,
ADD COLUMN     "saldoPendiente" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "subtotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Backfill de las ventas ya existentes antes de imponer NOT NULL / UNIQUE.
-- "numero" es un consecutivo POR NEGOCIO, asi que se numera con row_number()
-- particionado por negocioId y ordenado cronologicamente: cada negocio queda
-- con 1..N respetando el orden real en que ocurrieron sus ventas.
UPDATE "ventas" v
SET "numero" = s.rn
FROM (
  SELECT "id", row_number() OVER (PARTITION BY "negocioId" ORDER BY "createdAt", "id") AS rn
  FROM "ventas"
) s
WHERE v."id" = s."id" AND v."numero" IS NULL;

ALTER TABLE "ventas" ALTER COLUMN "numero" SET NOT NULL;

-- Antes de esta migracion no existia el desglose subtotal/descuento/impuesto:
-- el unico monto era "total". Se asume descuento e impuesto = 0 (los defaults
-- recien aplicados), por lo que subtotal == total para todo el historico.
UPDATE "ventas" SET "subtotal" = "total" WHERE "subtotal" = 0;

-- Las ventas FIADO activas quedan con saldo pendiente igual al total: no hay
-- historial de abonos previo a esta migracion (la tabla "abonos" nace aqui),
-- asi que ninguna pudo haber sido abonada todavia.
UPDATE "ventas" SET "saldoPendiente" = "total"
WHERE "formaPago" = 'FIADO' AND "estado" <> 'ANULADA';

-- CreateTable
CREATE TABLE "producto_variantes" (
    "id" TEXT NOT NULL,
    "productoId" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "sku" TEXT,
    "precio" DECIMAL(12,2),
    "precioCosto" DECIMAL(12,2),
    "stock" INTEGER NOT NULL DEFAULT 0,
    "stockMinimo" INTEGER NOT NULL DEFAULT 0,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "producto_variantes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "movimientos_inventario" (
    "id" TEXT NOT NULL,
    "negocioId" TEXT NOT NULL,
    "productoId" TEXT NOT NULL,
    "varianteId" TEXT,
    "tipo" "TipoMovimiento" NOT NULL,
    "cantidad" INTEGER NOT NULL,
    "stockAnterior" INTEGER NOT NULL,
    "stockResultante" INTEGER NOT NULL,
    "costoUnitario" DECIMAL(12,2),
    "motivo" TEXT,
    "referenciaTipo" TEXT,
    "referenciaId" TEXT,
    "usuarioId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "movimientos_inventario_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "abonos" (
    "id" TEXT NOT NULL,
    "negocioId" TEXT NOT NULL,
    "clienteId" TEXT NOT NULL,
    "ventaId" TEXT,
    "numero" INTEGER NOT NULL,
    "monto" DECIMAL(12,2) NOT NULL,
    "formaPago" "FormaPago" NOT NULL DEFAULT 'EFECTIVO',
    "nota" TEXT,
    "usuarioId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "abonos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categorias_gasto" (
    "id" TEXT NOT NULL,
    "negocioId" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "categorias_gasto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gastos" (
    "id" TEXT NOT NULL,
    "negocioId" TEXT NOT NULL,
    "categoriaGastoId" TEXT,
    "proveedorId" TEXT,
    "numero" INTEGER NOT NULL,
    "descripcion" TEXT NOT NULL,
    "monto" DECIMAL(12,2) NOT NULL,
    "formaPago" "FormaPago" NOT NULL DEFAULT 'EFECTIVO',
    "fecha" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "comprobanteUrl" TEXT,
    "nota" TEXT,
    "usuarioId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gastos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "proveedores" (
    "id" TEXT NOT NULL,
    "negocioId" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "contacto" TEXT,
    "email" TEXT,
    "telefono" TEXT,
    "nit" TEXT,
    "direccion" TEXT,
    "notas" TEXT,
    "saldoDeuda" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "proveedores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compras" (
    "id" TEXT NOT NULL,
    "negocioId" TEXT NOT NULL,
    "proveedorId" TEXT NOT NULL,
    "numero" INTEGER NOT NULL,
    "numeroFactura" TEXT,
    "estado" "EstadoCompra" NOT NULL DEFAULT 'BORRADOR',
    "formaPago" "FormaPago" NOT NULL DEFAULT 'EFECTIVO',
    "subtotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "descuento" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "impuesto" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "saldoPendiente" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "fecha" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "nota" TEXT,
    "usuarioId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "compras_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compra_detalles" (
    "id" TEXT NOT NULL,
    "compraId" TEXT NOT NULL,
    "productoId" TEXT NOT NULL,
    "varianteId" TEXT,
    "descripcion" TEXT,
    "cantidad" INTEGER NOT NULL,
    "costoUnitario" DECIMAL(12,2) NOT NULL,
    "descuento" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "subtotal" DECIMAL(12,2) NOT NULL DEFAULT 0,

    CONSTRAINT "compra_detalles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pagos_proveedor" (
    "id" TEXT NOT NULL,
    "negocioId" TEXT NOT NULL,
    "proveedorId" TEXT NOT NULL,
    "compraId" TEXT,
    "monto" DECIMAL(12,2) NOT NULL,
    "formaPago" "FormaPago" NOT NULL DEFAULT 'EFECTIVO',
    "nota" TEXT,
    "usuarioId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pagos_proveedor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comprobantes" (
    "id" TEXT NOT NULL,
    "negocioId" TEXT NOT NULL,
    "tipo" "TipoComprobante" NOT NULL,
    "serie" TEXT NOT NULL DEFAULT 'A',
    "numero" INTEGER NOT NULL,
    "folio" TEXT NOT NULL,
    "ventaId" TEXT,
    "abonoId" TEXT,
    "estado" "EstadoComprobante" NOT NULL DEFAULT 'EMITIDO',
    "snapshot" JSONB NOT NULL,
    "total" DECIMAL(12,2) NOT NULL,
    "enviadoA" TEXT,
    "medioEnvio" "MedioEnvio",
    "enviadoEn" TIMESTAMP(3),
    "usuarioId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "comprobantes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consecutivos" (
    "id" TEXT NOT NULL,
    "negocioId" TEXT NOT NULL,
    "tipo" "TipoConsecutivo" NOT NULL,
    "serie" TEXT NOT NULL DEFAULT 'A',
    "valor" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "consecutivos_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "producto_variantes_productoId_idx" ON "producto_variantes"("productoId");

-- CreateIndex
CREATE UNIQUE INDEX "producto_variantes_productoId_nombre_key" ON "producto_variantes"("productoId", "nombre");

-- CreateIndex
CREATE INDEX "movimientos_inventario_negocioId_createdAt_idx" ON "movimientos_inventario"("negocioId", "createdAt");

-- CreateIndex
CREATE INDEX "movimientos_inventario_productoId_idx" ON "movimientos_inventario"("productoId");

-- CreateIndex
CREATE INDEX "movimientos_inventario_referenciaTipo_referenciaId_idx" ON "movimientos_inventario"("referenciaTipo", "referenciaId");

-- CreateIndex
CREATE INDEX "abonos_negocioId_createdAt_idx" ON "abonos"("negocioId", "createdAt");

-- CreateIndex
CREATE INDEX "abonos_clienteId_idx" ON "abonos"("clienteId");

-- CreateIndex
CREATE UNIQUE INDEX "abonos_negocioId_numero_key" ON "abonos"("negocioId", "numero");

-- CreateIndex
CREATE INDEX "categorias_gasto_negocioId_idx" ON "categorias_gasto"("negocioId");

-- CreateIndex
CREATE UNIQUE INDEX "categorias_gasto_negocioId_nombre_key" ON "categorias_gasto"("negocioId", "nombre");

-- CreateIndex
CREATE INDEX "gastos_negocioId_fecha_idx" ON "gastos"("negocioId", "fecha");

-- CreateIndex
CREATE UNIQUE INDEX "gastos_negocioId_numero_key" ON "gastos"("negocioId", "numero");

-- CreateIndex
CREATE INDEX "proveedores_negocioId_idx" ON "proveedores"("negocioId");

-- CreateIndex
CREATE INDEX "compras_negocioId_fecha_idx" ON "compras"("negocioId", "fecha");

-- CreateIndex
CREATE INDEX "compras_proveedorId_idx" ON "compras"("proveedorId");

-- CreateIndex
CREATE UNIQUE INDEX "compras_negocioId_numero_key" ON "compras"("negocioId", "numero");

-- CreateIndex
CREATE INDEX "compra_detalles_compraId_idx" ON "compra_detalles"("compraId");

-- CreateIndex
CREATE INDEX "pagos_proveedor_negocioId_createdAt_idx" ON "pagos_proveedor"("negocioId", "createdAt");

-- CreateIndex
CREATE INDEX "pagos_proveedor_proveedorId_idx" ON "pagos_proveedor"("proveedorId");

-- CreateIndex
CREATE INDEX "comprobantes_negocioId_createdAt_idx" ON "comprobantes"("negocioId", "createdAt");

-- CreateIndex
CREATE INDEX "comprobantes_ventaId_idx" ON "comprobantes"("ventaId");

-- CreateIndex
CREATE UNIQUE INDEX "comprobantes_negocioId_tipo_serie_numero_key" ON "comprobantes"("negocioId", "tipo", "serie", "numero");

-- CreateIndex
CREATE UNIQUE INDEX "consecutivos_negocioId_tipo_serie_key" ON "consecutivos"("negocioId", "tipo", "serie");

-- CreateIndex
CREATE UNIQUE INDEX "categorias_negocioId_nombre_key" ON "categorias"("negocioId", "nombre");

-- CreateIndex
CREATE INDEX "productos_negocioId_activo_idx" ON "productos"("negocioId", "activo");

-- CreateIndex
CREATE UNIQUE INDEX "productos_negocioId_sku_key" ON "productos"("negocioId", "sku");

-- CreateIndex
CREATE INDEX "venta_detalles_productoId_idx" ON "venta_detalles"("productoId");

-- CreateIndex
CREATE INDEX "ventas_negocioId_createdAt_idx" ON "ventas"("negocioId", "createdAt");

-- CreateIndex
CREATE INDEX "ventas_negocioId_estado_idx" ON "ventas"("negocioId", "estado");

-- CreateIndex
CREATE INDEX "ventas_clienteId_idx" ON "ventas"("clienteId");

-- CreateIndex
CREATE INDEX "ventas_usuarioId_idx" ON "ventas"("usuarioId");

-- CreateIndex
CREATE UNIQUE INDEX "ventas_negocioId_numero_key" ON "ventas"("negocioId", "numero");

-- AddForeignKey
ALTER TABLE "producto_variantes" ADD CONSTRAINT "producto_variantes_productoId_fkey" FOREIGN KEY ("productoId") REFERENCES "productos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "movimientos_inventario" ADD CONSTRAINT "movimientos_inventario_negocioId_fkey" FOREIGN KEY ("negocioId") REFERENCES "negocios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "movimientos_inventario" ADD CONSTRAINT "movimientos_inventario_productoId_fkey" FOREIGN KEY ("productoId") REFERENCES "productos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "movimientos_inventario" ADD CONSTRAINT "movimientos_inventario_varianteId_fkey" FOREIGN KEY ("varianteId") REFERENCES "producto_variantes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "movimientos_inventario" ADD CONSTRAINT "movimientos_inventario_usuarioId_fkey" FOREIGN KEY ("usuarioId") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venta_detalles" ADD CONSTRAINT "venta_detalles_varianteId_fkey" FOREIGN KEY ("varianteId") REFERENCES "producto_variantes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "abonos" ADD CONSTRAINT "abonos_negocioId_fkey" FOREIGN KEY ("negocioId") REFERENCES "negocios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "abonos" ADD CONSTRAINT "abonos_clienteId_fkey" FOREIGN KEY ("clienteId") REFERENCES "clientes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "abonos" ADD CONSTRAINT "abonos_ventaId_fkey" FOREIGN KEY ("ventaId") REFERENCES "ventas"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "abonos" ADD CONSTRAINT "abonos_usuarioId_fkey" FOREIGN KEY ("usuarioId") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categorias_gasto" ADD CONSTRAINT "categorias_gasto_negocioId_fkey" FOREIGN KEY ("negocioId") REFERENCES "negocios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gastos" ADD CONSTRAINT "gastos_negocioId_fkey" FOREIGN KEY ("negocioId") REFERENCES "negocios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gastos" ADD CONSTRAINT "gastos_categoriaGastoId_fkey" FOREIGN KEY ("categoriaGastoId") REFERENCES "categorias_gasto"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gastos" ADD CONSTRAINT "gastos_proveedorId_fkey" FOREIGN KEY ("proveedorId") REFERENCES "proveedores"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gastos" ADD CONSTRAINT "gastos_usuarioId_fkey" FOREIGN KEY ("usuarioId") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proveedores" ADD CONSTRAINT "proveedores_negocioId_fkey" FOREIGN KEY ("negocioId") REFERENCES "negocios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compras" ADD CONSTRAINT "compras_negocioId_fkey" FOREIGN KEY ("negocioId") REFERENCES "negocios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compras" ADD CONSTRAINT "compras_proveedorId_fkey" FOREIGN KEY ("proveedorId") REFERENCES "proveedores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compras" ADD CONSTRAINT "compras_usuarioId_fkey" FOREIGN KEY ("usuarioId") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compra_detalles" ADD CONSTRAINT "compra_detalles_compraId_fkey" FOREIGN KEY ("compraId") REFERENCES "compras"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compra_detalles" ADD CONSTRAINT "compra_detalles_productoId_fkey" FOREIGN KEY ("productoId") REFERENCES "productos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compra_detalles" ADD CONSTRAINT "compra_detalles_varianteId_fkey" FOREIGN KEY ("varianteId") REFERENCES "producto_variantes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pagos_proveedor" ADD CONSTRAINT "pagos_proveedor_negocioId_fkey" FOREIGN KEY ("negocioId") REFERENCES "negocios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pagos_proveedor" ADD CONSTRAINT "pagos_proveedor_proveedorId_fkey" FOREIGN KEY ("proveedorId") REFERENCES "proveedores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pagos_proveedor" ADD CONSTRAINT "pagos_proveedor_compraId_fkey" FOREIGN KEY ("compraId") REFERENCES "compras"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pagos_proveedor" ADD CONSTRAINT "pagos_proveedor_usuarioId_fkey" FOREIGN KEY ("usuarioId") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comprobantes" ADD CONSTRAINT "comprobantes_negocioId_fkey" FOREIGN KEY ("negocioId") REFERENCES "negocios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comprobantes" ADD CONSTRAINT "comprobantes_ventaId_fkey" FOREIGN KEY ("ventaId") REFERENCES "ventas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comprobantes" ADD CONSTRAINT "comprobantes_abonoId_fkey" FOREIGN KEY ("abonoId") REFERENCES "abonos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comprobantes" ADD CONSTRAINT "comprobantes_usuarioId_fkey" FOREIGN KEY ("usuarioId") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consecutivos" ADD CONSTRAINT "consecutivos_negocioId_fkey" FOREIGN KEY ("negocioId") REFERENCES "negocios"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Sembrar el contador de consecutivos de VENTA para que las proximas ventas
-- continuen la numeracion en vez de chocar con el UNIQUE (negocioId, numero).
INSERT INTO "consecutivos" ("id", "negocioId", "tipo", "serie", "valor")
SELECT md5(random()::text || "negocioId"), "negocioId", 'VENTA', 'A', MAX("numero")
FROM "ventas"
GROUP BY "negocioId"
ON CONFLICT ("negocioId", "tipo", "serie") DO NOTHING;
