/**
 * Pure decision logic for the long-horizon guards: step-budget rejection,
 * per-tool consecutive-failure replan coercion, stall stop, terminal-status
 * classification, and the completion-gate continue message. The controller
 * wires these into the loop's extension points.
 * @module @deepseek-ai/dsh-longhorizon/guards
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { TaskStatus } from './types.ts'

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

/**
 * Whether a status is terminal. A terminal run must never execute another
 * agent turn: resume reports and returns immediately.
 */
export function isTerminalStatus(status: TaskStatus): boolean {
  return status !== 'running'
}

/** The process exit code for a final status: 0 done · 2 budget · 3 stalled · 1 error/other. */
export function finalExitCode(status: TaskStatus | undefined): number {
  if (status === 'done') return 0
  if (status === 'budget-exhausted') return 2
  if (status === 'stalled') return 3
  return 1
}

/** The model-visible replan nudge injected through the agent inbox. */
export const REPLAN_NUDGE_TEXT =
  'You seem stuck: the same kind of action keeps failing or no verified progress is happening. Stop, update the plan with todo_write to a materially different approach, and try again.'

/** A user-role nudge that lands in the next admitted pre-step. */
export function replanNudgeMessage(): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text: REPLAN_NUDGE_TEXT }], source: { kind: 'user' } })
}

/** The completion-gate continue message naming the still-unverified required conditions. */
export function continueMessage(unverified: string): UserMessage {
  const text = `The run is not complete: unverified required conditions: ${unverified}. Continue: inspect the state, finish the remaining work, and verify by producing the required artifact contents or making the verification command pass. Listing completion as text alone never completes the task.`
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}
