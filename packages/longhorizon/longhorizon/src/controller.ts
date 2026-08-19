/**
 * Long-horizon controller plugin: wires the durable state domain into the
 * loop — the step-budget guard, the per-tool consecutive-failure replan/stall
 * guards, the no-progress replan guard, and durable replan acceptance when the
 * model submits a materially different plan. Mounted as the
 * `@deepseek-ai/dsh-longhorizon/controller` row.
 * @module @deepseek-ai/dsh-longhorizon/controller
 */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import { registerSummarySeed } from '@deepseek-ai/dsh-compaction-basic'
import { foldTaskState } from './fold.ts'
import {
  allRequiredVerified,
  budgetExhausted,
  consecutiveFailurePeak,
  foldNoProgressSteps,
  foldStepCount,
  foldFailuresWithCurrent,
  planRevisionAccepted,
  readFacts,
  replanNudgeMessage,
  shouldCoerceReplan,
  shouldStopStalled,
  type LongHorizonService,
} from './index.ts'

/** Stable Cordis plugin name. */
export const name = 'longhorizon-controller'

/** Services required before the loop guards can arm. */
export const inject = ['longhorizon']

/** Plugin config: the loop-guard tunables. */
export interface Config {
  /** Workspace root the facts file resolves against; defaults to the invocation cwd. */
  workspace?: string
  /** Facts file path relative to the workspace. */
  factsFile?: string
  /** Peak per-tool consecutive failures that trip one replan request. */
  failureLimit?: number
  /** Replan requests before the run is declared stalled. */
  replanLimit?: number
  /** Consecutive steps without verified progress that trip one replan request. */
  stallSteps?: number
}

export const Config: z<Config> = z.object({
  workspace: z.string().required(false),
  factsFile: z.string().required(false),
  failureLimit: z.number().step(1).min(1).required(false),
  replanLimit: z.number().step(1).min(1).required(false),
  stallSteps: z.number().step(1).min(1).required(false),
})

/**
 * Request one replan: flip the durable `replanRequired` flag on, count the
 * request, and inject the model-visible nudge. No-op when a replan request is
 * already pending, so repeated failures/no-progress cannot flood the inbox or
 * exhaust the stall budget while the model is trying to act.
 * @param service - the durable state service.
 * @param session - the run's session.
 * @param agent - the live agent to nudge, when available.
 * @returns true when a new replan request was issued durably.
 */
export function requestReplan(service: LongHorizonService, session: Session, agent: Agent | undefined): boolean {
  const snapshot = service.snapshot(session)
  if (snapshot === undefined || snapshot.status !== 'running' || snapshot.replanRequired) return false
  service.append(session, 'update', {
    ...snapshot,
    replanRequired: true,
    replanCount: snapshot.replanCount + 1,
  })
  if (agent !== undefined) agent.inject(replanNudgeMessage())
  return true
}

/**
 * Install the loop guards: the step budget rejects the next step once the
 * snapshot's cap is reached; per-tool consecutive failures and progress-less
 * stretches each request a durable replan (and, past the replan limit, stall
 * the run); a pending replan is cleared only by an accepted plan revision. All
 * transitions are durable `longhorizon/state` updates, so replan requests
 * survive process restart.
 * @param ctx - plugin context carrying the state service.
 * @param config - validated controller config.
 */
export function apply(ctx: Context, config: Config): void {
  const service = ctx.longhorizon
  // Durable task facts must survive compaction: seed the compaction summary
  // with the run's objective/status/revision/requirements so the summary
  // re-derives them instead of losing them to the truncated window.
  ctx.effect(() => registerSummarySeed((session: Session) => {
    const snapshot = foldTaskState(session.events).snapshot
    if (snapshot === undefined) return undefined
    const required = snapshot.requirements.filter(requirement => requirement.required).length
    return `Objective: ${snapshot.objective}\nStatus: ${snapshot.status}\nRevision: ${snapshot.taskRevision}\nStep budget: ${snapshot.maxSteps}\nVerified: ${allRequiredVerified(snapshot, session.events) ? 'all' : `unverified required: ${required}`}`
  }), 'longhorizon:summary-seed')
  const workspace = config.workspace ?? process.cwd()
  const factsPath = join(workspace, config.factsFile ?? '.run/facts.md')
  const failureLimit = config.failureLimit ?? 3
  const replanLimit = config.replanLimit ?? 3
  const stallSteps = config.stallSteps ?? 6

  ctx.on('agent/pre-step', async (payload, next) => {
    const snapshot = service.snapshot(payload.agent.session)
    if (snapshot === undefined) return next()
    if (snapshot.status !== 'running') return next()
    const stepCount = foldStepCount(payload.agent.session.events)
    if (budgetExhausted(stepCount, snapshot.maxSteps)) {
      service.append(payload.agent.session, 'update', { ...snapshot, status: 'budget-exhausted' })
      return { kind: 'reject' }
    }
    // No-progress replan: the model is advancing steps without new verification
    // evidence, plan-step completion, or requirement change. Distinct from tool
    // errors — this catches silent spinning — and it feeds the same durable
    // replan request path.
    const noProgress = foldNoProgressSteps(payload.agent.session.events)
    if (noProgress >= stallSteps) {
      if (snapshot.replanCount >= replanLimit) {
        service.append(payload.agent.session, 'update', { ...snapshot, status: 'stalled' })
      } else if (!snapshot.replanRequired) {
        requestReplan(service, payload.agent.session, payload.agent)
      }
    }
    return next()
  })

  ctx.on('tools/result', (exec, result) => {
    if (exec.agent === undefined) return
    const session = exec.agent.session
    const snapshot = service.snapshot(session)
    if (snapshot === undefined || snapshot.status !== 'running') return
    const failures = foldFailuresWithCurrent(session.events, exec.name, result.isError)
    const peak = consecutiveFailurePeak(failures)
    if (result.error !== undefined) {
      if (shouldStopStalled(peak, failureLimit, snapshot.replanCount, replanLimit)) {
        service.append(session, 'update', { ...snapshot, status: 'stalled' })
      } else if (!snapshot.replanRequired && shouldCoerceReplan(peak, failureLimit, snapshot.replanCount, replanLimit)) {
        requestReplan(service, session, exec.agent)
      }
    }
    // Replan acceptance: a pending replan clears only when the model submits a
    // materially different todo_write plan (deterministic content comparison).
    // An unrelated successful tool result never clears it. Accepted revisions
    // bump the task revision, invalidating stale evidence.
    const fresh = service.snapshot(session)
    if (fresh !== undefined && fresh.replanRequired && planRevisionAccepted(session.events)) {
      service.append(session, 'update', {
        ...fresh,
        replanRequired: false,
        planRevisionCount: fresh.planRevisionCount + 1,
        taskRevision: fresh.taskRevision + 1,
      })
    }
    // The facts file may have changed; warming the runtime keeps the first
    // assembly cheap, but the section provider reads it per assembly anyway.
    readFacts(factsPath)
  })
}
