import { prisma } from "@/lib/db";

async function main() {
  const user = await prisma.usuario.findUnique({
    where: { email: 'superadmin@microdigital.test' }
  });

  if (user) {
    console.log('✓ Usuario encontrado');
    console.log('  ID:', user.id);
    console.log('  Nombre:', user.nombre);
    console.log('  Activo:', user.activo);
    console.log('  Tiene contraseña:', !!user.passwordHash);
    if (user.passwordHash) {
      console.log('  Hash length:', user.passwordHash.length);
      console.log('  Hash primeros 20 chars:', user.passwordHash.substring(0, 20));
    }
  } else {
    console.log('✗ Usuario NO encontrado');
  }

  await prisma.$disconnect();
}

main().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
