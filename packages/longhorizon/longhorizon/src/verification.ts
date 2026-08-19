/**
 * Host-side requirement verification: the executor that turns one requirement
 * verifier into durable evidence — artifact existence + regular file + size +
 * SHA-256 content identity, or a command argv whose exit code 0 passes.
 * Semantically richer checks stay in command/custom verifiers; V1 evidence only
 * proves that an artifact exists with concrete content.
 * @module @deepseek-ai/dsh-longhorizon/verification
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { TaskRequirement, VerificationEvidence } from './types.ts'

/** Cap on one host verification command's runtime; a timeout is `unknown`, never `passed`. */
export const COMMAND_TIMEOUT_MS = 30_000

/** The verifier-dependent outcome of one check. */
export interface VerifiedOutcome {
  readonly status: VerificationEvidence['status']
  readonly artifactPath?: string
  readonly artifactHash?: string
  readonly command?: string
  readonly exitCode?: number
}

/** SHA-256 hex digest of a file's content. */
export function fileSha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** Verify an artifact requirement: exists, is a regular file, size > 0, hashed. */
function verifyArtifact(relativePath: string, workspace: string): VerifiedOutcome {
  const absolute = join(workspace, relativePath)
  try {
    const stat = statSync(absolute)
    if (!stat.isFile() || stat.size <= 0) return { status: 'failed' }
    return { status: 'passed', artifactPath: relativePath, artifactHash: fileSha256(absolute) }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      // A deterministically absent artifact is a definitive failure, not unknown.
      return { status: 'failed' }
    }
    return { status: 'unknown' }
  }
}

/** Verify a command requirement: argv run in the workspace; exit 0 passes. */
function verifyCommand(command: readonly string[], workspace: string): VerifiedOutcome {
  const argv0 = command[0]
  if (argv0 === undefined) return { status: 'unknown' }
  const joined = command.join(' ')
  try {
    const result = spawnSync(argv0, [...command.slice(1)], {
      cwd: workspace,
      encoding: 'utf8',
      timeout: COMMAND_TIMEOUT_MS,
    })
    if (result.status === null) return { status: 'unknown', command: joined }
    return { status: result.status === 0 ? 'passed' : 'failed', command: joined, exitCode: result.status }
  } catch {
    return { status: 'unknown', command: joined }
  }
}

/** Execute one requirement's verifier against the workspace. */
export function verifyRequirement(verifier: TaskRequirement['verifier'], workspace: string): VerifiedOutcome {
  return verifier.type === 'artifact'
    ? verifyArtifact(verifier.path, workspace)
    : verifyCommand(verifier.command, workspace)
}

/** Build the durable evidence value for one check at one task revision. */
export function buildEvidence(
  requirement: TaskRequirement,
  outcome: VerifiedOutcome,
  taskRevision: number,
): VerificationEvidence {
  return {
    requirementId: requirement.id,
    taskRevision,
    status: outcome.status,
    verifierType: requirement.verifier.type,
    ...(outcome.artifactPath === undefined ? {} : { artifactPath: outcome.artifactPath }),
    ...(outcome.artifactHash === undefined ? {} : { artifactHash: outcome.artifactHash }),
    ...(outcome.command === undefined ? {} : { command: outcome.command }),
    ...(outcome.exitCode === undefined ? {} : { exitCode: outcome.exitCode }),
    checkedAt: new Date().toISOString(),
  }
}
