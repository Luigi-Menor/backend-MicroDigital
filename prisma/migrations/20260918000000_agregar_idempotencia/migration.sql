-- CreateTable
CREATE TABLE "idempotent_requests" (
    "id" TEXT NOT NULL,
    "clave" TEXT NOT NULL,
    "negocioId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "respuestaStatus" INTEGER,
    "respuestaBody" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiraEn" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "idempotent_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "idempotent_requests_clave_key" ON "idempotent_requests"("clave");

-- CreateIndex
CREATE INDEX "idempotent_requests_negocioId_idx" ON "idempotent_requests"("negocioId");

-- CreateIndex
CREATE INDEX "idempotent_requests_expiraEn_idx" ON "idempotent_requests"("expiraEn");

-- AddForeignKey
ALTER TABLE "idempotent_requests" ADD CONSTRAINT "idempotent_requests_negocioId_fkey" FOREIGN KEY ("negocioId") REFERENCES "negocios"("id") ON DELETE CASCADE ON UPDATE CASCADE;
