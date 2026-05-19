import OpenAI from 'openai';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { env } from '../env.js';

const AiResponseSchema = z.object({
  clientId: z.string().nullable(),
});

export interface AssignResult {
  clientId: string | null;
  reason: string;
}

export async function assignVoucherToClient(
  voucherId: string,
): Promise<AssignResult> {
  const v = await prisma.voucher.findUnique({
    where: { id: voucherId },
    select: { ocrJson: true },
  });
  if (!v || !v.ocrJson) return { clientId: null, reason: 'no_data' };
  const j = v.ocrJson as {
    addressee?: string | null;
    vendor_name?: string | null;
  };
  const clients = await prisma.client.findMany({
    select: { id: true, name: true, industry: true },
  });

  // 1. addressee の部分一致 (両側 ≥3 文字)
  if (j.addressee && j.addressee.length >= 3) {
    const addressee = j.addressee;
    const hit = clients.find(
      (c) =>
        c.name.length >= 3 &&
        (addressee.includes(c.name) || c.name.includes(addressee)),
    );
    if (hit) return { clientId: hit.id, reason: 'addressee' };
  }

  // 2. OpenAI 推測
  if (!env.OPENAI_API_KEY) return { clientId: null, reason: 'no_api_key' };

  const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  const prompt = `領収書の情報:
発行者: ${j.vendor_name ?? '(不明)'}
宛名: ${j.addressee ?? '(不明)'}

顧問先一覧:
${clients.map((c) => `- ${c.id}: ${c.name} (${c.industry})`).join('\n')}

この領収書を経費として計上する可能性が最も高い顧問先を 1 つ選んでください。判断できなければ clientId を null にしてください。`;

  const completion = await client.chat.completions.create({
    model: env.OPENAI_VISION_MODEL,
    messages: [
      { role: 'system', content: 'JSON でのみ回答してください。' },
      { role: 'user', content: prompt },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'client_assignment',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { clientId: { type: ['string', 'null'] } },
          required: ['clientId'],
        },
      },
    },
  });

  const text = completion.choices[0]?.message?.content ?? '{}';
  const parsed = AiResponseSchema.parse(JSON.parse(text));
  if (parsed.clientId && clients.find((c) => c.id === parsed.clientId)) {
    return { clientId: parsed.clientId, reason: 'ai' };
  }
  return { clientId: null, reason: 'ai_uncertain' };
}
