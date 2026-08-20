/**
 * Long-horizon controller plugin: wires the durable state domain into the
 * loop — the step-budget guard, the per-tool consecutive-failure replan/stall
 * guards, and the shared controller runtime the Task State section reads.
 * Mounted as the `@deepseek-ai/dsh-longhorizon/controller` row.
 * @module @deepseek-ai/dsh-longhorizon/controller
 */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Session } from '@deepseek-ai/dsh-session'
import * as CompactionBasic from '@deepseek-ai/dsh-compaction-basic'
import { foldTaskState } from './fold.ts'
import {
  budgetExhausted,
  consecutiveFailurePeak,
  foldStepCount,
  foldFailuresWithCurrent,
  markReplanArmed,
  readFacts,
  shouldCoerceReplan,
  shouldStopStalled,
  replanNudgeMessage,
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
  /** Peak per-tool consecutive failures that trip one replan coercion. */
  failureLimit?: number
  /** Replan coercions before the run is declared stalled. */
  replanLimit?: number
}

export const Config: z<Config> = z.object({
  workspace: z.string().required(false),
  factsFile: z.string().required(false),
  failureLimit: z.number().step(1).min(1).required(false),
  replanLimit: z.number().step(1).min(1).required(false),
})

type SummarySeedRegistrar = (provider: (session: Session) => string | undefined) => () => void

/**
 * Published compaction-basic releases may not expose the summary-seed hook yet.
 * Treat it as an optional compatibility enhancement instead of making the
 * entire standalone package fail to typecheck/build on an absent named export.
 */
const registerSummarySeed = (CompactionBasic as unknown as {
  registerSummarySeed?: SummarySeedRegistrar
}).registerSummarySeed

/**
 * Install the loop guards: the step budget rejects the next step once the
 * snapshot's cap is reached; per-tool consecutive failures inject a replan
 * nudge and, past the replan limit, stall the run. Both transitions are
 * durable `longhorizon/state` updates.
 * @param ctx - plugin context carrying the state service.
 * @param config - validated controller config.
 */
export function apply(ctx: Context, config: Config): void {
  const service = ctx.longhorizon
  // Durable task facts should survive compaction when the host exposes the
  // summary-seed hook. Older published compaction-basic versions omit it;
  // longhorizon still runs because Task State is re-rendered from durable state.
  if (registerSummarySeed !== undefined) {
    ctx.effect(() => registerSummarySeed((session: Session) => {
      const snapshot = foldTaskState(session.events).snapshot
      if (snapshot === undefined) return undefined
      return `Objective: ${snapshot.objective}\nStatus: ${snapshot.status}\nStep budget: ${snapshot.maxSteps}`
    }), 'longhorizon:summary-seed')
  }
  const workspace = config.workspace ?? process.cwd()
  const factsPath = join(workspace, config.factsFile ?? '.run/facts.md')
  const failureLimit = config.failureLimit ?? 3
  const replanLimit = config.replanLimit ?? 3

  ctx.on('agent/pre-step', async (payload, next) => {
    const snapshot = service.snapshot(payload.agent.session)
    if (snapshot === undefined) return next()
    const stepCount = foldStepCount(payload.agent.session.events)
    if (budgetExhausted(stepCount, snapshot.maxSteps)) {
      service.append(payload.agent.session, 'update', { ...snapshot, status: 'budget-exhausted' })
      return { kind: 'reject' }
    }
    return next()
  })

  ctx.on('tools/result', (exec, result) => {
    if (exec.agent === undefined) return
    const snapshot = service.snapshot(exec.agent.session)
    if (snapshot === undefined) return
    const failures = foldFailuresWithCurrent(exec.agent.session.events, exec.name, result.isError)
    const peak = consecutiveFailurePeak(failures)
    if (result.error !== undefined) {
      if (shouldCoerceReplan(peak, failureLimit, snapshot.replanCount, replanLimit)) {
        service.append(exec.agent.session, 'update', { ...snapshot, replanCount: snapshot.replanCount + 1 })
        markReplanArmed(exec.agent.session, true)
        exec.agent.inject(replanNudgeMessage())
      } else if (shouldStopStalled(peak, failureLimit, snapshot.replanCount, replanLimit)) {
        service.append(exec.agent.session, 'update', { ...snapshot, status: 'stalled' })
      }
    } else {
      markReplanArmed(exec.agent.session, false)
    }
    // The facts file may have changed; warming the runtime keeps the first
    // assembly cheap, but the section provider reads it per assembly anyway.
    readFacts(factsPath)
  })
}
