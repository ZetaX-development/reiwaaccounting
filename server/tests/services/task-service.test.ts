import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { prisma } from '../../src/lib/prisma.js';
import {
  listTasks,
  transitionTask,
  TaskTransitionError,
} from '../../src/services/task-service.js';

let testTaskId: string;

beforeEach(async () => {
  // Create a fresh task for each test so transitions don't interfere
  const created = await prisma.task.create({
    data: {
      clientId: 'aoyama-design',
      title: 'TEST 承認ワークフロー',
      note: 'transition test',
      category: 'AI仕訳候補',
      status: 'urgent',
      score: 50,
      stage: 'staff_doing',
      assignee: '鈴木',
      approver: '畠山',
    },
  });
  testTaskId = created.id;
});

afterAll(async () => {
  await prisma.task.deleteMany({ where: { title: 'TEST 承認ワークフロー' } });
  await prisma.$disconnect();
});

describe('listTasks role filter', () => {
  it('returns staff_doing/rejected for role=staff', async () => {
    const rows = await listTasks('aoyama-design', 'staff');
    expect(rows.every((r) => r.stage === 'staff_doing' || r.stage === 'rejected')).toBe(
      true,
    );
  });

  it('returns awaiting_approval for role=tax_accountant', async () => {
    const rows = await listTasks('aoyama-design', 'tax_accountant');
    expect(rows.every((r) => r.stage === 'awaiting_approval')).toBe(true);
  });
});

describe('transitionTask', () => {
  it('staff_complete moves staff_doing → awaiting_approval', async () => {
    const updated = await transitionTask({
      taskId: testTaskId,
      action: 'staff_complete',
      by: '鈴木',
    });
    expect(updated.stage).toBe('awaiting_approval');
    const hist = await prisma.taskHistory.findMany({
      where: { taskId: testTaskId },
      orderBy: { at: 'desc' },
    });
    expect(hist[0].action).toBe('staff_complete');
  });

  it('approve moves awaiting_approval → approved/done', async () => {
    await transitionTask({ taskId: testTaskId, action: 'staff_complete', by: '鈴木' });
    const updated = await transitionTask({
      taskId: testTaskId,
      action: 'approve',
      by: '畠山',
    });
    expect(updated.stage).toBe('approved');
    expect(updated.status).toBe('done');
  });

  it('reject moves awaiting_approval → rejected/open', async () => {
    await transitionTask({ taskId: testTaskId, action: 'staff_complete', by: '鈴木' });
    const updated = await transitionTask({
      taskId: testTaskId,
      action: 'reject',
      by: '畠山',
      comment: '消費税区分が違います',
    });
    expect(updated.stage).toBe('rejected');
    expect(updated.status).toBe('open');
  });

  it('rejects invalid transition (approve from staff_doing)', async () => {
    await expect(
      transitionTask({ taskId: testTaskId, action: 'approve', by: '畠山' }),
    ).rejects.toBeInstanceOf(TaskTransitionError);
  });
});
