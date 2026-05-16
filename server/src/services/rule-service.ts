import { prisma } from '../lib/prisma.js';
import { ruleTemplates, type RuleTemplate } from '../data/rule-templates.js';
import { recomputeTaskScores } from './rule-task-score.js';

export interface CreateRuleInput {
  clientId: string;
  type: 'template' | 'custom';
  industry?: string;
  title: string;
  detail?: string;
  severity: 'high' | 'mid' | 'low';
  createdBy?: string;
}

export interface UpdateRuleInput {
  title?: string;
  detail?: string;
  severity?: 'high' | 'mid' | 'low';
  active?: boolean;
}

export async function listRules(clientId: string) {
  const rules = await prisma.rule.findMany({
    where: { clientId },
    include: { hits: { orderBy: { at: 'desc' }, take: 50 } },
    orderBy: [{ active: 'desc' }, { severity: 'asc' }, { createdAt: 'desc' }],
  });
  return rules.map((r) => ({
    ...r,
    hitCount: r.hits.length,
    lastHit: r.hits[0]?.at?.toISOString() ?? null,
  }));
}

export async function listTemplates(industry?: string): Promise<RuleTemplate[]> {
  if (!industry) {
    const seen = new Set<string>();
    const merged: RuleTemplate[] = [];
    for (const list of Object.values(ruleTemplates)) {
      for (const t of list) {
        if (!seen.has(t.title)) {
          seen.add(t.title);
          merged.push(t);
        }
      }
    }
    return merged;
  }
  return ruleTemplates[industry] ?? ruleTemplates['その他'];
}

export async function addRule(input: CreateRuleInput) {
  const rule = await prisma.rule.create({
    data: {
      clientId: input.clientId,
      type: input.type,
      industry: input.industry,
      title: input.title,
      detail: input.detail ?? '',
      severity: input.severity,
      createdBy: input.createdBy ?? 'user',
    },
  });
  await recomputeTaskScores(input.clientId);
  return rule;
}

export async function updateRule(ruleId: string, input: UpdateRuleInput) {
  const rule = await prisma.rule.update({
    where: { id: ruleId },
    data: input,
  });
  await recomputeTaskScores(rule.clientId);
  return rule;
}

export async function deleteRule(ruleId: string) {
  const rule = await prisma.rule.findUnique({ where: { id: ruleId } });
  await prisma.rule.delete({ where: { id: ruleId } });
  if (rule) await recomputeTaskScores(rule.clientId);
}

export async function listRuleHits(ruleId: string) {
  return prisma.ruleHit.findMany({
    where: { ruleId },
    orderBy: { at: 'desc' },
  });
}
