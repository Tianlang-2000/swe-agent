import { PlanTracker, updatePlanSchema } from '../agent/scheduler.js';
import type { RegisteredTool } from '../types.js';

/** Bind each tool to its session, without mutating a shared tool registry. */
export function createUpdatePlanTool(tracker: PlanTracker): RegisteredTool {
  return {
    definition: {
      name: 'update_plan',
      description: 'Updates the task plan. Provide an optional explanation and the complete list of plan items, each with a step and status (pending, in_progress, completed). At most one step can be in_progress at a time. An empty plan clears the plan. Completion records your assessment, not verified execution evidence.',
      schema: updatePlanSchema,
    },
    handler: async (args) => {
      const snapshot = tracker.applyUpdate(args);
      return { ok: true, output: JSON.stringify(snapshot) };
    },
  };
}
