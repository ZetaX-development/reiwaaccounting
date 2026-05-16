import { prisma } from '../lib/prisma.js';

const SEVERITY_BOOST: Record<string, number> = {
  high: 10,
  mid: 5,
  low: 2,
};

// Re-compute Task.score based on active Rules. Simple keyword match: a rule
// "matches" a task when the task title or note contains a non-trivial token
// from the rule title. The matched rule is also recorded as a RuleHit so the
// AI panel can show "this rule fired N times this month".
export async function recomputeTaskScores(clientId: string): Promise<void> {
  const [tasks, rules] = await Promise.all([
    prisma.task.findMany({ where: { clientId }, select: { id: true, title: true, note: true, score: true } }),
    prisma.rule.findMany({ where: { clientId, active: true }, select: { id: true, title: true, severity: true } }),
  ]);

  for (const task of tasks) {
    const haystack = `${task.title} ${task.note}`;
    let boost = 0;
    let matchedRuleId: string | null = null;
    for (const rule of rules) {
      // Pick the first 4 chars of each whitespace-split token longer than 2 chars
      const tokens = rule.title.split(/[\s、。・/,]+/).filter((s) => s.length >= 2);
      const matched = tokens.some((t) => haystack.includes(t));
      if (matched) {
        boost += SEVERITY_BOOST[rule.severity] ?? 0;
        if (!matchedRuleId) matchedRuleId = rule.id;
      }
    }
    const newScore = Math.min(100, Math.max(0, (task.score ?? 50) + Math.min(boost, 30) - 10));
    await prisma.task.update({
      where: { id: task.id },
      data: {
        score: newScore,
        ruleId: matchedRuleId,
      },
    });
  }
}
