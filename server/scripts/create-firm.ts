import '../src/bootstrap.js';
import { createFirm } from '../src/services/firm-service.js';
import { prisma } from '../src/lib/prisma.js';

function usage(): never {
  console.error('Usage: npm run create-firm -- --name <name> --slug <slug> --owner-email <email>');
  process.exit(1);
}

const args = process.argv.slice(2);
function getArg(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : undefined;
}

const name = getArg('--name');
const slug = getArg('--slug');
const ownerEmail = getArg('--owner-email');

if (!name || !slug || !ownerEmail) usage();

try {
  const firm = await createFirm({ name, slug, ownerEmail });
  console.log(`Created firm: ${firm.id} (${firm.name})`);
  console.log(`Invite sent to: ${ownerEmail}`);
} catch (err) {
  console.error('Failed to create firm:', err);
  process.exit(1);
} finally {
  await prisma.$disconnect();
}
