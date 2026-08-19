/**
 * Pure decision logic for the long-horizon guards: step-budget rejection,
 * per-tool consecutive-failure replan coercion, and stall stop. The controller
 * wires these into the loop's extension points.
 * @module @deepseek-ai/dsh-longhorizon/guards
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'

/** Whether the budget is exhausted and the next step must be rejected. */
export function budgetExhausted(stepCount: number, maxSteps: number): boolean {
  return stepCount >= maxSteps
}

/**
 * Whether the peak per-tool consecutive failure run crossed the limit while
 * replan attempts remain. Per-tool tracking makes one persistently failing
 * tool visible even while other tools succeed in between.
 */
export function shouldCoerceReplan(
  peakConsecutiveFailures: number, failureLimit: number, replanCount: number, replanLimit: number,
): boolean {
  return peakConsecutiveFailures >= failureLimit && replanCount < replanLimit
}

/** Whether the peak per-tool consecutive failure run crossed the limit with no replan attempts left. */
export function shouldStopStalled(
  peakConsecutiveFailures: number, failureLimit: number, replanCount: number, replanLimit: number,
): boolean {
  return peakConsecutiveFailures >= failureLimit && replanCount >= replanLimit
}

/** The model-visible replan nudge injected through the agent inbox. */
export const REPLAN_NUDGE_TEXT =
  'You seem stuck: the same kind of action keeps failing. Stop, update the plan with todo_write, and try a different approach before the next attempt.'

/** A user-role nudge that lands in the next admitted pre-step. */
export function replanNudgeMessage(): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text: REPLAN_NUDGE_TEXT }], source: { kind: 'user' } })
}

/** The completion-gate continue message naming the still-unconfirmed artifacts. */
export function continueMessage(missingArtifacts: readonly string[]): UserMessage {
  const text = `The run is not complete: unconfirmed artifacts: ${missingArtifacts.join(', ')}. Continue: inspect the state, finish the remaining work, and verify by rerunning.`
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}
