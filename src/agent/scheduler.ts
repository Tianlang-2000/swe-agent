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
  private steps: string[] = [];
  private currentIndex: number = 0;

  /**
   * Inspect the latest assistant message and update internal state.
   * - Looks for a `<plan>...</plan>` block; replaces the plan if found.
   * - Falls back to a heuristic: numbered list at the start of the message.
   */
  /**
   * 检查最近一条 assistant 消息并更新内部状态。
   * - 优先找 `<plan>...</plan>` 块；找到就用它替换当前计划。
   * - 没找到则用启发式：消息开头的编号列表。
   */
  updateFromAssistant(content: string): void {
    const planBlock = content.match(/<plan>([\s\S]*?)<\/plan>/i);
    if (planBlock) {
      const steps = this.parseStepList(planBlock[1]);
      if (steps.length > 0) {
        this.steps = steps;
        this.currentIndex = 0;
        return;
      }
    }

    // Heuristic: lines starting with "1.", "-", "*", or "[ ]" near the top.
    // 启发式：靠近消息顶部的 "1.", "-", "*", "[ ]" 开头的行。
    const numbered = content.match(/(?:^|\n)\s*(?:\d+[.)]|[-*]|\[[ x]\])\s+.+/g);
    if (numbered && numbered.length >= 2) {
      const steps = numbered
        .map((line) => line.replace(/^[\s\n]*(\d+[.)]|[-*]|\[[ x]\])\s+/, '').trim())
        .filter(Boolean);
      if (steps.length >= 2) {
        // Only overwrite if the model explicitly framed it as a plan; ignore
        // incidental lists in the middle of normal text.
        // 只有当模型显式把它框定为 plan 时才覆盖；
        // 普通文本中间偶然出现的列表会被忽略。
        if (/^\s*(plan|steps?|todo)/i.test(content.slice(0, 200))) {
          this.steps = steps;
          this.currentIndex = 0;
        }
      }
    }
  }

  /**
   * Detect "step N done" markers (`<done>`, `[DONE]`, `<step done="2">`, etc.)
   * and advance the cursor. Also accepts a plain "<done/>" self-closing tag
   * meaning "the most recently referenced step is done".
   */
  /**
   * 检测 "step N done" 类标记（`<done>`、`[DONE]`、`<step done="2">` 等），
   * 并把游标前移。也接受一个自闭合标签 `<done/>`，
   * 含义是"最近引用到的那一步完成了"。
   */
  markStepDone(): void {
    this.currentIndex = Math.min(this.currentIndex + 1, this.steps.length);
  }

  hasPlan(): boolean {
    return this.steps.length > 0;
  }

  /** Markdown rendering for inclusion in the system prompt. */
  /** 渲染为 Markdown，用于塞进系统提示词。 */
  renderForPrompt(): string {
    if (this.steps.length === 0) return '(no plan yet)';
    return this.steps
      .map((s, i) => {
        const mark = i < this.currentIndex ? '[x]' : i === this.currentIndex ? '[>]' : '[ ]';
        return `${mark} ${i + 1}. ${s}`;
      })
      .join('\n');
  }

  private parseStepList(block: string): string[] {
    return block
      .split(/\r?\n/)
      .map((line) => line.replace(/^\s*(?:\d+[.)]|[-*]|\[[ x]\])\s+/, '').trim())
      .filter((line) => line.length > 0);
  }
}
