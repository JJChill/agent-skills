// Issue #54: Probity refuses to read a session transcript over 100 MiB.
// ctx.history() then throws "file at <path> exceeds 104857600 bytes",
// and the engine reports every history-based rule as an opaque
// "rule error" until the session is restarted. probity-claude now hands
// Probity the tail of such a transcript; when a rule still hits the
// limit (the bare probity bin), it must deny with the cause and the fix.
import assert from 'node:assert/strict'
import test from 'node:test'

import type { Action, RuleContext } from '@nizos/probity'

import { requireGreenTestRun, withJudgeFailureDiagnostics } from './gates.ts'
import { withCharacterizationTest } from './kotlin.ts'

const TOO_LARGE = 'file at /home/u/.claude/projects/p/session.jsonl exceeds 104857600 bytes'

const ctxThrowing = (message: string, extra: Partial<RuleContext> = {}) =>
  ({
    history: async () => {
      throw new Error(message)
    },
    ...extra,
  }) as RuleContext

function assertNamesCauseAndFix(reason: string | undefined) {
  assert.match(reason ?? '', /session\.jsonl/)
  assert.match(reason ?? '', /100 MiB/)
  assert.match(reason ?? '', /probity-claude/)
  assert.match(reason ?? '', /new session/)
}

const commit: Action = { kind: 'command', command: 'git commit -m x' }

test('requireGreenTestRun: an over-limit transcript is a clear deny, not a rule error', async () => {
  const rule = requireGreenTestRun({
    command: /gradlew/,
    successPattern: /BUILD SUCCESSFUL/,
    failurePattern: /BUILD FAILED/,
  })
  const result = await rule(commit, ctxThrowing(TOO_LARGE))
  assert.equal(result.kind, 'violation')
  assertNamesCauseAndFix(result.kind === 'violation' ? result.reason : '')
})

test('requireGreenTestRun: any other history failure still fails closed as an error', async () => {
  const rule = requireGreenTestRun({
    command: /gradlew/,
    successPattern: /BUILD SUCCESSFUL/,
    failurePattern: /BUILD FAILED/,
  })
  await assert.rejects(rule(commit, ctxThrowing('EACCES: permission denied')), /EACCES/)
})

test('withJudgeFailureDiagnostics: an over-limit transcript in the judged rule is a clear deny', async () => {
  const judged = withJudgeFailureDiagnostics(async function enforceTdd(_action, ctx) {
    await ctx?.history?.()
    return { kind: 'pass' }
  })
  const write: Action = { kind: 'write', path: '/repo/src/main/kotlin/A.kt', content: '' }
  const result = await judged(write, ctxThrowing(TOO_LARGE))
  assert.equal(result.kind, 'violation')
  assertNamesCauseAndFix(result.kind === 'violation' ? result.reason : '')
})

test('withCharacterizationTest: removing a marker with an over-limit transcript is a clear deny', async () => {
  const path = '/repo/src/test/kotlin/TokenTest.kt'
  const before = '// probity: characterization\n@Test\nfun `rejects expired tokens`() {}\n'
  const after = '@Test\nfun `rejects expired tokens`() {}\n'
  const rule = withCharacterizationTest(async () => ({ kind: 'pass' }), {
    filePattern: /src[/\\]test[/\\]/,
  })
  const ctx = ctxThrowing(TOO_LARGE, {
    readFile: async () => ({ kind: 'present', content: before }),
  } as Partial<RuleContext>)
  const result = await rule({ kind: 'write', path, content: after }, ctx)
  assert.equal(result.kind, 'violation')
  assertNamesCauseAndFix(result.kind === 'violation' ? result.reason : '')
})
