import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { prisma } from '../src/lib/prisma.js';
import { chunkKnowledgeMarkdown } from '../src/services/knowledge-chunker.js';
import { seedKnowledgeEmbeddings } from '../src/services/knowledge-service.js';

const SOURCE = 'siwake-jiten';
const KNOWLEDGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '../src/data/knowledge');

async function main() {
  const files = readdirSync(KNOWLEDGE_DIR).filter((f) => f.endsWith('.md'));
  let created = 0;
  let updated = 0;

  for (const file of files) {
    const md = readFileSync(join(KNOWLEDGE_DIR, file), 'utf-8');
    for (const c of chunkKnowledgeMarkdown(md, SOURCE)) {
      const existing = await prisma.knowledgeChunk.findUnique({
        where: { source_title: { source: c.source, title: c.title } },
        select: { id: true },
      });
      if (existing) {
        await prisma.knowledgeChunk.update({
          where: { id: existing.id },
          data: {
            page: c.page,
            content: c.content,
            accounts: c.accounts,
            taxClass: c.taxClass,
            tags: c.tags,
          },
        });
        updated += 1;
      } else {
        await prisma.knowledgeChunk.create({
          data: {
            source: c.source,
            page: c.page,
            title: c.title,
            content: c.content,
            accounts: c.accounts,
            taxClass: c.taxClass,
            tags: c.tags,
          },
        });
        created += 1;
      }
    }
  }

  const embed = await seedKnowledgeEmbeddings();
  const total = await prisma.knowledgeChunk.count();
  console.log(
    `[seed:knowledge] total=${total} created=${created} updated=${updated} embeddingsSeeded=${embed.seeded} embeddingsSkipped=${embed.skipped}`,
  );
}

main()
  .catch((err) => {
    console.error('[seed:knowledge] failed', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
