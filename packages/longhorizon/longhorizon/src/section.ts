/**
 * Renders the model-visible "Task State" system-prompt section from the
 * durable snapshot plus the derived plan, verification, and facts. Re-entered
 * at every step so the objective, revision, requirements, plan, facts, budget,
 * and completion eligibility survive context compaction.
 * @module @deepseek-ai/dsh-longhorizon/section
 */

import { consecutiveFailurePeak, type TaskPlanningItem } from './fold.ts'
import type { RequirementVerification, TaskFailureCounts, TaskSnapshot } from './types.ts'

/** Cap on the facts lines re-entered per step (last ≤12 lines). */
const FACTS_LINE_CAP = 12

/** Cap per rendered line so the whole section stays well under ~600 tokens. */
const LINE_CHAR_CAP = 120

/** Cap on rendered plan lines. */
const PLAN_LINE_CAP = 8

/** Cap on rendered requirement lines. */
const REQ_LINE_CAP = 6

function clip(text: string): string {
  return text.length <= LINE_CHAR_CAP ? text : `${text.slice(0, LINE_CHAR_CAP - 1)}…`
}

/** Group the requirement verification state into verified / pending / failed lists. */
function groupRequirements(requirements: readonly RequirementVerification[]): {
  verified: readonly RequirementVerification[]
  pending: readonly RequirementVerification[]
  failed: readonly RequirementVerification[]
} {
  const verified: RequirementVerification[] = []
  const pending: RequirementVerification[] = []
  const failed: RequirementVerification[] = []
  for (const verification of requirements) {
    if (verification.verified) verified.push(verification)
    else if (verification.latest === undefined) pending.push(verification)
    else failed.push(verification)
  }
  return { verified, pending, failed }
}

/**
 * Render the Task State section exactly in the pinned shape. The replan note
 * appears only while durable replan coercion is armed (between the request and
 * the model's next material todo_write).
 * @param snapshot - the current durable run snapshot.
 * @param derived - the derived run facts folded from the base session log.
 * @param factsText - the raw facts text, or undefined when none exist yet.
 * @param replanArmed - whether a replan request is pending a plan refresh.
 * @returns the complete section text, ready to be concatenated into the system prompt.
 */
export function renderTaskStateSection(
  snapshot: TaskSnapshot,
  derived: {
    readonly plan: readonly TaskPlanningItem[]
    readonly stepCount: number
    readonly failures: TaskFailureCounts
    readonly requirements: readonly RequirementVerification[]
    readonly noProgressSteps: number
  },
  factsText: string | undefined,
  replanArmed: boolean,
): string {
  const { plan, stepCount, failures, requirements, noProgressSteps } = derived
  const planLines = plan.slice(0, PLAN_LINE_CAP)
    .map((item, index) => `${index + 1}. [${item.status}] ${clip(item.text)}`)
    .join('  ')
  const done = plan.filter(item => item.status === 'done').map(item => `#${item.index + 1}`).join(', ')
  const factsLines = factsText === undefined || factsText.trim() === ''
    ? '(none yet)'
    : factsText.split('\n').filter(line => line.trim() !== '').slice(-FACTS_LINE_CAP)
      .map(line => clip(line.trim()))
      .join(' · ')
  const byTool = Object.entries(failures.byTool)
    .map(([tool, count]) => `${tool} ${count}`)
    .join(', ')
  const latestFailure = failures.latest === undefined ? '' : ` · latest: ${clip(failures.latest.fingerprint)}`
  const failureLine = `total ${failures.total}${byTool === '' ? '' : ` (${byTool})`} · peak consecutive ${consecutiveFailurePeak(failures)}${latestFailure}`
  const unknownLine = failures.latestUnknown === undefined
    ? ''
    : `Uncertain effect: tool ${failures.latestUnknown.tool} outcome unknown (interrupted before its result persisted) — do not assume it succeeded or failed.`

  const groups = groupRequirements(requirements)
  const requirementLines = requirements.slice(0, REQ_LINE_CAP)
    .map((verification) => {
      const mark = verification.verified ? '✓' : verification.latest === undefined ? '○' : '✗'
      return `${mark} ${clip(verification.requirement.description)}`
    })
    .join(' · ')
  const required = requirements.filter(verification => verification.requirement.required)
  const requiredVerified = required.filter(verification => verification.verified)
  const completionAllowed = required.length > 0 && requiredVerified.length === required.length
  const completionLine = completionAllowed
    ? 'Completion: ALLOWED — every required condition is verified.'
    : `Completion: NOT ALLOWED — ${required.length - requiredVerified.length} required condition(s) unverified.`
  const verifiedLine = groups.verified.length === 0
    ? '(none yet)'
    : groups.verified.map(verification => clip(verification.requirement.description)).join(', ')
  const replan = replanArmed
    ? '\nReplan note: You seem stuck. Stop, refresh the plan with todo_write, and try a different approach.'
    : ''
  return [
    `## Task State (step ${stepCount}/${snapshot.maxSteps} · status ${snapshot.status})`,
    `Objective: ${clip(snapshot.objective)}`,
    `Revision: ${snapshot.taskRevision} (replans requested ${snapshot.replanCount}, accepted ${snapshot.planRevisionCount})`,
    `Plan: ${planLines === '' ? '(no plan yet — write one with todo_write)' : planLines}`,
    `Done: ${done === '' ? '(none)' : done}`,
    `Requirements: ${requirementLines === '' ? '(none declared — completion is impossible until one is verified)' : requirementLines}`,
    `Verified: ${clip(verifiedLine)}`,
    `No verified progress: ${noProgressSteps} step(s) since the last checkpoint`,
    `Recent facts: ${factsLines}`,
    `Failures: ${failureLine}`,
    unknownLine,
    completionLine,
    replan,
  ].filter(line => line !== '').join('\n')
}
