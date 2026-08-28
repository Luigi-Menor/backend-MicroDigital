import { PrismaClient } from "@prisma/client";

// Singleton de Prisma Client. Ver skill de troubleshooting: instanciar Prisma
// directamente en cada request agota conexiones en entornos serverless.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
