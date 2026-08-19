/**
 * Readable execution-trajectory renderer: one section per step over
 * APPEND-ORIGIN session events (the durable log, not the compaction-shadowed
 * surface), so the dump is a true transcript of what happened. Closed with the
 * verification evidence and the exact completion reason that justified the
 * final status.
 * @module @deepseek-ai/dsh-longhorizon/trajectory
 */

import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { blockText, foldEvidence, foldStepCount } from './fold.ts'
import type { TaskSnapshot } from './types.ts'

/** Cap on a tool-result text preview per line. */
const PREVIEW_CAP = 200

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= PREVIEW_CAP ? flat : `${flat.slice(0, PREVIEW_CAP - 1)}…`
}

/** The verifier-independent reason the run concluded, or undefined while running. */
function completionReason(snapshot: TaskSnapshot, events: readonly SessionEvent[]): string {
  if (snapshot.status === 'running') return 'run not concluded'
  const required = snapshot.requirements.filter(requirement => requirement.required)
  const verifiedCount = required.filter(requirement =>
    events.some(event => event.type === 'longhorizon/evidence'
      && event.data.evidence.requirementId === requirement.id
      && event.data.evidence.taskRevision === snapshot.taskRevision
      && event.data.evidence.status === 'passed')).length
  const verifiedNote = `${verifiedCount}/${required.length} required condition(s) verified at revision ${snapshot.taskRevision}`
  if (snapshot.status === 'done') return `all required conditions verified: ${verifiedNote}`
  return `concluded ${snapshot.status}; ${verifiedNote}`
}

/**
 * Render the trajectory of one run as readable markdown.
 * @param sessionId - the run's session id.
 * @param snapshot - the final run snapshot.
 * @param events - the append-origin session events.
 * @returns the markdown document.
 */
export function renderTrajectory(sessionId: string, snapshot: TaskSnapshot, events: readonly SessionEvent[]): string {
  const lines: string[] = []
  lines.push(`# Run trajectory — ${sessionId}`)
  lines.push('')
  lines.push(`- Objective: ${snapshot.objective}`)
  lines.push(`- Status: ${snapshot.status} · revision: ${snapshot.taskRevision} · steps: ${foldStepCount(events)}/${snapshot.maxSteps} · replans: ${snapshot.replanCount} (accepted ${snapshot.planRevisionCount}) · replan required: ${snapshot.replanRequired}`)
  lines.push('')
  for (const event of events) {
    switch (event.type) {
      case 'turn/start':
        lines.push(`## Turn ${event.data.turn}`)
        break
      case 'step/start':
        lines.push(`### Step ${event.data.step}`)
        break
      case 'user/message': {
        const text = event.data.content.map(blockText).filter((part): part is string => part !== undefined).join('')
        if (text !== '') lines.push(`> USER: ${clip(text)}`)
        break
      }
      case 'assistant/message': {
        const text = event.data.message.content.map(blockText).filter((part): part is string => part !== undefined).join('')
        if (text !== '') lines.push(`ASSISTANT: ${clip(text)}`)
        for (const call of event.data.message.content) {
          if (call.type === 'tool-call') lines.push(`- TOOL: ${call.name} ${call.arguments.length <= 120 ? call.arguments : `${call.arguments.slice(0, 120)}…`}`)
        }
        break
      }
      case 'tool/call':
        lines.push(`- run: ${event.data.name} ${event.data.arguments.length <= 120 ? event.data.arguments : `${event.data.arguments.slice(0, 120)}…`}`)
        break
      case 'tool/result': {
        const text = event.data.message.content.map(blockText).filter((part): part is string => part !== undefined).join('')
        lines.push(`  → ${event.data.error === undefined ? 'ok' : `error ${event.data.error.code}`}: ${clip(text)}`)
        break
      }
      case 'turn/end':
        lines.push(`- turn ${event.data.turn} ended: ${event.data.reason.kind}`)
        break
      case 'longhorizon/evidence': {
        lines.push(`- evidence: ${event.data.evidence.requirementId}@r${event.data.evidence.taskRevision} ${event.data.evidence.status}${event.data.evidence.artifactHash === undefined ? '' : ` hash ${event.data.evidence.artifactHash.slice(0, 12)}`}${event.data.evidence.exitCode === undefined ? '' : ` exit ${event.data.evidence.exitCode}`}`)
        break
      }
      default:
        break
    }
  }
  lines.push('')
  lines.push('## Verification evidence')
  lines.push('')
  const evidence = foldEvidence(events)
  if (evidence.length === 0) {
    lines.push('(no verification checks were recorded)')
  } else {
    for (const item of evidence) {
      const identity = `${item.requirementId}@r${item.taskRevision}`
      const detail = item.verifierType === 'artifact'
        ? `${item.artifactPath ?? '?'}${item.artifactHash === undefined ? '' : ` (sha256 ${item.artifactHash.slice(0, 12)}…)`}`
        : `${item.command ?? '?'}${item.exitCode === undefined ? '' : ` exit ${item.exitCode}`}`
      lines.push(`- ${item.status} ${identity} — ${detail} @ ${item.checkedAt}`)
    }
  }
  lines.push('')
  lines.push('## Final task state')
  lines.push('')
  lines.push(`- Completion reason: ${completionReason(snapshot, events)}`)
  lines.push('')
  lines.push('```json')
  lines.push(JSON.stringify(snapshot, null, 2))
  lines.push('```')
  return `${lines.join('\n')}\n`
}

/**
 * Write the rendered trajectory atomically: write a process-unique temp file,
 * then same-filesystem rename over the target, so readers never observe a
 * partial dump.
 * @param path - the target markdown path.
 * @param markdown - the rendered document.
 */
export function writeTrajectory(path: string, markdown: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.tmp.${process.pid}`
  writeFileSync(temp, markdown, 'utf8')
  renameSync(temp, path)
}
