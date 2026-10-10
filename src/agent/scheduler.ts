import { z } from 'zod';

export const planStepSchema = z.object({
  step: z.string().trim().min(1),
  status: z.enum(['pending', 'in_progress', 'completed']),
}).strict();

// Codex-style update_plan: submit a complete snapshot, never parse prose.
export const updatePlanSchema = z.object({
  explanation: z.string().optional(),
  plan: z.array(planStepSchema).refine(
    (steps) => steps.filter((step) => step.status === 'in_progress').length <= 1,
    'At most one step can be in_progress at a time.',
  ),
}).strict();

export type PlanStep = z.infer<typeof planStepSchema>;
export type PlanStatus = PlanStep['status'];
export type PlanUpdate = z.infer<typeof updatePlanSchema>;
export type PlanSnapshot = PlanUpdate;

/** Session-local state. Validate before replacing; completion is model-reported. */
export class PlanTracker {
  private snapshot: PlanSnapshot = { plan: [] };

  applyUpdate(update: unknown): PlanSnapshot {
    this.snapshot = updatePlanSchema.parse(update);
    return this.getSnapshot();
  }

  /** Detached copies prevent callers from bypassing validation. */
  getSnapshot(): PlanSnapshot {
    return {
      ...this.snapshot,
      plan: this.snapshot.plan.map((step) => ({ ...step })),
    };
  }

  hasPlan(): boolean {
    return this.snapshot.plan.length > 0;
  }

  /** Render accepted state only; titles are quoted to keep newlines inside data. */
  renderForPrompt(): string {
    if (!this.hasPlan()) return '(no plan yet)';
    const marks: Record<PlanStatus, string> = {
      pending: '[ ]',
      in_progress: '[>]',
      completed: '[x]',
    };
    return this.snapshot.plan
      .map(({ step, status }, i) => `${marks[status]} ${i + 1}. ${JSON.stringify(step)}`)
      .join('\n');
  }
}
