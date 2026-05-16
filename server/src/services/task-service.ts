import { prisma } from '../lib/prisma.js';

export type Stage = 'staff_doing' | 'awaiting_approval' | 'approved' | 'rejected';
export type Role = 'staff' | 'tax_accountant';
export type TaskAction = 'staff_complete' | 'approve' | 'reject' | 'resubmit';

export interface TransitionInput {
  taskId: string;
  action: TaskAction;
  by: string;
  comment?: string;
}

interface TransitionRule {
  from: Stage[];
  toStage: Stage;
  toStatus: 'urgent' | 'open' | 'done';
}

const transitions: Record<TaskAction, TransitionRule> = {
  staff_complete: {
    from: ['staff_doing', 'rejected'],
    toStage: 'awaiting_approval',
    toStatus: 'open',
  },
  approve: {
    from: ['awaiting_approval'],
    toStage: 'approved',
    toStatus: 'done',
  },
  reject: {
    from: ['awaiting_approval'],
    toStage: 'rejected',
    toStatus: 'open',
  },
  resubmit: {
    from: ['rejected'],
    toStage: 'awaiting_approval',
    toStatus: 'open',
  },
};

export class TaskTransitionError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

export async function listTasks(clientId: string, role?: Role, stageFilter?: Stage) {
  const where: { clientId: string; stage?: { in: Stage[] } | Stage } = { clientId };
  if (stageFilter) {
    where.stage = stageFilter;
  } else if (role === 'staff') {
    where.stage = { in: ['staff_doing', 'rejected'] };
  } else if (role === 'tax_accountant') {
    where.stage = { in: ['awaiting_approval'] };
  }
  return prisma.task.findMany({
    where,
    orderBy: { score: 'desc' },
  });
}

export async function transitionTask(input: TransitionInput) {
  const task = await prisma.task.findUnique({ where: { id: input.taskId } });
  if (!task) {
    throw new TaskTransitionError('NOT_FOUND', 'task not found');
  }
  const rule = transitions[input.action];
  if (!rule) {
    throw new TaskTransitionError('INVALID_ACTION', `unknown action: ${input.action}`);
  }
  if (!rule.from.includes(task.stage as Stage)) {
    throw new TaskTransitionError(
      'INVALID_TRANSITION',
      `cannot ${input.action} from stage ${task.stage}`,
    );
  }

  const [updated] = await prisma.$transaction([
    prisma.task.update({
      where: { id: input.taskId },
      data: { stage: rule.toStage, status: rule.toStatus },
    }),
    prisma.taskHistory.create({
      data: {
        taskId: input.taskId,
        action: input.action,
        by: input.by,
        comment: input.comment,
      },
    }),
  ]);

  // Recompute simple client summary fields based on the new task state.
  await recomputeClientSummary(task.clientId);
  return updated;
}

export async function listHistory(taskId: string) {
  return prisma.taskHistory.findMany({
    where: { taskId },
    orderBy: { at: 'desc' },
  });
}

export async function recomputeClientSummary(clientId: string) {
  const tasks = await prisma.task.findMany({
    where: { clientId },
    select: { stage: true, status: true },
  });
  const total = tasks.length || 1;
  const done = tasks.filter((t) => t.status === 'done').length;
  const awaiting = tasks.filter((t) => t.stage === 'awaiting_approval').length;
  const rejected = tasks.filter((t) => t.stage === 'rejected').length;
  const tasksOpen = tasks.filter((t) => t.status !== 'done').length;
  const progress = Math.round((done / total) * 100);
  await prisma.client.update({
    where: { id: clientId },
    data: {
      progress,
      tasksOpen,
      risk: awaiting,
      diff: rejected,
    },
  });
}
