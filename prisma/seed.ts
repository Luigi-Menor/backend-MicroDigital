import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  const passwordHash = await bcrypt.hash("Password123", 10);

  // Superadministrador (sin negocioId)
  await prisma.usuario.upsert({
    where: { email: "superadmin@microdigital.test" },
    update: {},
    create: {
      nombre: "Super Administrador",
      email: "superadmin@microdigital.test",
      passwordHash,
      rol: "SUPERADMIN",
    },
  });

  // Negocio piloto
  const negocio = await prisma.negocio.create({
    data: {
      nombre: "Tienda Doña Rosa",
      tipoNegocio: "Tienda de barrio",
      contacto: "300 123 4567",
    },
  });

  const admin = await prisma.usuario.upsert({
    where: { email: "admin@donarosa.test" },
    update: {},
    create: {
      negocioId: negocio.id,
      nombre: "Rosa Pérez",
      email: "admin@donarosa.test",
      passwordHash,
      rol: "ADMINISTRADOR",
    },
  });

  await prisma.usuario.upsert({
    where: { email: "vendedor@donarosa.test" },
    update: {},
    create: {
      negocioId: negocio.id,
      nombre: "Carlos Vendedor",
      email: "vendedor@donarosa.test",
      passwordHash,
      rol: "VENDEDOR",
    },
  });

  const categoria = await prisma.categoria.create({
    data: { negocioId: negocio.id, nombre: "Abarrotes" },
  });

  await prisma.producto.createMany({
    data: [
      { negocioId: negocio.id, categoriaId: categoria.id, nombre: "Arroz 500g", precio: 3200, stock: 40, stockMinimo: 10 },
      { negocioId: negocio.id, categoriaId: categoria.id, nombre: "Panela 1lb", precio: 2500, stock: 8, stockMinimo: 10 },
      { negocioId: negocio.id, categoriaId: categoria.id, nombre: "Aceite 1L", precio: 9800, stock: 15, stockMinimo: 5 },
    ],
  });

  await prisma.cliente.create({
    data: { negocioId: negocio.id, nombre: "Juan Comprador", contacto: "301 555 0000" },
  });

  console.log("Seed completado:");
  console.log(`  Superadmin: superadmin@microdigital.test / Password123`);
  console.log(`  Admin (${negocio.nombre}): admin@donarosa.test / Password123`);
  console.log(`  Vendedor: vendedor@donarosa.test / Password123`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
