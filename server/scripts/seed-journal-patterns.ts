import { prisma } from '../src/lib/prisma.js';
import { journalPatterns } from '../src/data/journal-patterns.js';
import { seedEmbeddings } from '../src/services/journal-pattern-service.js';

async function main() {
  let created = 0;
  let updated = 0;

  for (const pattern of journalPatterns) {
    const existing = await prisma.journalPattern.findFirst({
      where: {
        debit: pattern.debit,
        credit: pattern.credit,
        scenario: pattern.scenario,
      },
      select: { id: true },
    });

    if (existing) {
      await prisma.journalPattern.update({
        where: { id: existing.id },
        data: {
          memoExamples: pattern.memoExamples,
          industry: pattern.industry,
          tags: pattern.tags,
          amountHint: pattern.amountHint ?? null,
        },
      });
      updated += 1;
    } else {
      await prisma.journalPattern.create({
        data: {
          debit: pattern.debit,
          credit: pattern.credit,
          scenario: pattern.scenario,
          memoExamples: pattern.memoExamples,
          industry: pattern.industry,
          tags: pattern.tags,
          amountHint: pattern.amountHint ?? null,
        },
      });
      created += 1;
    }
  }

  const embed = await seedEmbeddings();
  const total = await prisma.journalPattern.count();

  console.log(`[seed:patterns] total=${total} created=${created} updated=${updated} embeddingsSeeded=${embed.seeded} embeddingsSkipped=${embed.skipped}`);
}

main()
  .catch((err) => {
    console.error('[seed:patterns] failed', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
