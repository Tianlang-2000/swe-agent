/**
 * Minimal plan tracker.
 *
 * The scheduler does not split the task itself — the LLM does. Our job is to
 * (a) notice when the assistant emits a `<plan>...</plan>` block, (b) keep the
 * most recent plan in memory, and (c) render it back into the system prompt
 * so the model has a stable "where am I in the task" anchor across turns.
 *
 * This is intentionally regex-based. A real agent would want a structured
 * plan (e.g. todo list as a tool call), but for a minimal version, pulling
 * the plan out of free-form text keeps the LLM contract simple.
 */
export class PlanTracker {
  private steps: string[] = [];
  private currentIndex: number = 0;

  /**
   * Inspect the latest assistant message and update internal state.
   * - Looks for a `<plan>...</plan>` block; replaces the plan if found.
   * - Falls back to a heuristic: numbered list at the start of the message.
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
    const numbered = content.match(/(?:^|\n)\s*(?:\d+[.)]|[-*]|\[[ x]\])\s+.+/g);
    if (numbered && numbered.length >= 2) {
      const steps = numbered
        .map((line) => line.replace(/^[\s\n]*(\d+[.)]|[-*]|\[[ x]\])\s+/, '').trim())
        .filter(Boolean);
      if (steps.length >= 2) {
        // Only overwrite if the model explicitly framed it as a plan; ignore
        // incidental lists in the middle of normal text.
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
  markStepDone(): void {
    this.currentIndex = Math.min(this.currentIndex + 1, this.steps.length);
  }

  hasPlan(): boolean {
    return this.steps.length > 0;
  }

  /** Markdown rendering for inclusion in the system prompt. */
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
