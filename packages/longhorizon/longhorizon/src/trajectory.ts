/**
 * Readable execution-trajectory renderer: one section per step over
 * APPEND-ORIGIN session events (the durable log, not the compaction-shadowed
 * surface), so the dump is a true transcript of what happened.
 * @module @deepseek-ai/dsh-longhorizon/trajectory
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { blockText, foldStepCount } from './fold.ts'
import type { TaskSnapshot } from './types.ts'

/** Cap on a tool-result text preview per line. */
const PREVIEW_CAP = 200

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= PREVIEW_CAP ? flat : `${flat.slice(0, PREVIEW_CAP - 1)}…`
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
  lines.push(`- Status: ${snapshot.status} · steps: ${foldStepCount(events)}/${snapshot.maxSteps} · replans: ${snapshot.replanCount}`)
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
      default:
        break
    }
  }
  lines.push('')
  lines.push('## Final task state')
  lines.push('')
  lines.push('```json')
  lines.push(JSON.stringify(snapshot, null, 2))
  lines.push('```')
  return `${lines.join('\n')}\n`
}

/** Write the rendered trajectory atomically to `path`. */
export function writeTrajectory(path: string, markdown: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.tmp`
  writeFileSync(temp, markdown, 'utf8')
  writeFileSync(path, markdown, 'utf8')
}
