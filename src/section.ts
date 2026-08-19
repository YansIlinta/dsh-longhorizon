/**
 * Renders the model-visible "Task State" system-prompt section from the
 * durable snapshot plus the derived plan and facts. Re-entered at every step
 * so the objective, plan, facts, and budget survive context compaction.
 * @module @deepseek-ai/dsh-longhorizon/section
 */

import { consecutiveFailurePeak, type TaskPlanningItem } from './fold.ts'
import type { TaskFailureCounts, TaskSnapshot } from './types.ts'

/** Cap on the facts lines re-entered per step (last ≤12 lines). */
const FACTS_LINE_CAP = 12

/** Cap per rendered line so the whole section stays well under ~600 tokens. */
const LINE_CHAR_CAP = 120

/** Cap on rendered plan lines. */
const PLAN_LINE_CAP = 8

function clip(text: string): string {
  return text.length <= LINE_CHAR_CAP ? text : `${text.slice(0, LINE_CHAR_CAP - 1)}…`
}

/**
 * Render the Task State section exactly in the pinned shape. The replan note
 * appears only while replan coercion is armed between the nudge injection and
 * the model's next todo_write.
 * @param snapshot - the current durable run snapshot.
 * @param derived - the derived run facts folded from the base session log.
 * @param factsText - the raw facts text, or undefined when none exist yet.
 * @param replanArmed - whether a replan nudge is pending a plan refresh.
 * @returns the complete section text, ready to be concatenated into the system prompt.
 */
export function renderTaskStateSection(
  snapshot: TaskSnapshot,
  derived: { readonly plan: readonly TaskPlanningItem[]; readonly stepCount: number; readonly failures: TaskFailureCounts },
  factsText: string | undefined,
  replanArmed: boolean,
): string {
  const { plan, stepCount, failures } = derived
  const planLines = plan.slice(0, PLAN_LINE_CAP)
    .map((item, index) => `${index + 1}. [${item.status}] ${clip(item.text)}`)
    .join('  ')
  const done = plan.filter(item => item.status === 'done').map(item => item.id).join(', ')
  const factsLines = factsText === undefined || factsText.trim() === ''
    ? '(none yet)'
    : factsText.split('\n').filter(line => line.trim() !== '').slice(-FACTS_LINE_CAP)
      .map(line => clip(line.trim()))
      .join(' · ')
  const byTool = Object.entries(failures.byTool)
    .map(([tool, count]) => `${tool} ${count}`)
    .join(', ')
  const failureLine = `total ${failures.total}${byTool === '' ? '' : ` (${byTool})`} · peak consecutive ${consecutiveFailurePeak(failures)}`
  const replan = replanArmed
    ? '\nReplan note: You seem stuck. Stop, refresh the plan with todo_write, and try a different approach.'
    : ''
  return [
    `## Task State (step ${stepCount}/${snapshot.maxSteps} · status ${snapshot.status})`,
    `Objective: ${clip(snapshot.objective)}`,
    `Plan: ${planLines === '' ? '(no plan yet — write one with todo_write)' : planLines}`,
    `Done: ${done === '' ? '(none)' : done}`,
    `Recent facts: ${factsLines}`,
    `Failures: ${failureLine}`,
    replan,
  ].filter(line => line !== '').join('\n')
}
