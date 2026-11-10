/**
 * The labelled judge set: situations the AI judge has got wrong in the
 * field, or must keep getting right, each with the verdict it should
 * give. `judge-set.ts` turns every case into the exact prompt the
 * preset's rule sends today, and `probity-shadow-replay` asks a judge
 * those prompts and reports leaks and friction against the labels.
 *
 * Every case is synthetic: the shape of a field incident (what the
 * session held, what the write did), never its code. Field logs and
 * transcripts hold project code, so reduce an incident to a minimal
 * made-up case before adding it here.
 *
 * Adding a case:
 *   - `task` is the judging task the prompt must reach (the innermost
 *     rule name, as `probity-shadow-report` prints it). The builder
 *     fails if the case never reaches that judge, e.g. because a
 *     deterministic rule or fast path now decides it for free.
 *   - `expect` is the verdict a correct judge gives: `pass` or
 *     `violation`. A case whose right answer is arguable doesn't belong.
 *   - `source` names the issue or incident it comes from.
 */

export type SessionEvent =
  | { user: string }
  | { write: string; content: string }
  | { run: string; output: string }

export type JudgeCase = {
  id: string
  task: string
  expect: 'pass' | 'violation'
  source: string
  preset: 'js' | 'kmp'
  /** Preset options, for rules a preset leaves off by default. */
  options?: Record<string, unknown>
  /** Files on disk before the session, paths relative to the project root. */
  files?: Record<string, string>
  /** What the session did before the judged write, oldest first. */
  session?: SessionEvent[]
  /** The judged write: the whole file after it. */
  write: { path: string; content: string }
}

// ── JS/TS fixtures ──────────────────────────────────────────────────

const JS_TEST = 'src/core/queue.test.ts'
const JS_PROD = 'src/core/queue.ts'

const JS_PROD_V1 = `export type Item = { id: string; at: number }

export function takeOldest(items: Item[]): Item | undefined {
  return [...items].sort((a, b) => a.at - b.at)[0]
}
`

const JS_TEST_V1 = `import { describe, expect, it } from 'vitest'
import { takeOldest } from './queue'

describe('takeOldest', () => {
  it('returns nothing for an empty queue', () => {
    expect(takeOldest([])).toBeUndefined()
  })

  it('returns the item that arrived first', () => {
    expect(takeOldest([{ id: 'b', at: 2 }, { id: 'a', at: 1 }])?.id).toBe('a')
  })
})
`

const JS_TEST_PLUS_ONE = JS_TEST_V1.replace(
  /\n}\)\n$/,
  `
  it('keeps arrival order for items that arrived at the same time', () => {
    expect(takeOldest([{ id: 'x', at: 1 }, { id: 'y', at: 1 }])?.id).toBe('x')
  })
})
`,
)

const JS_TEST_PLUS_TWO = JS_TEST_PLUS_ONE.replace(
  /\n}\)\n$/,
  `
  it('ignores items with no arrival time', () => {
    expect(takeOldest([{ id: 'n', at: Number.NaN }, { id: 'a', at: 3 }])?.id).toBe('a')
  })
})
`,
)

const JS_GREEN = { run: 'npx vitest run src/core/queue.test.ts', output: ' ✓ src/core/queue.test.ts (2 tests)\n Test Files  1 passed (1)\n      Tests  2 passed (2)' }

const JS_TEST_NEWEST = JS_TEST_V1.replace(
  /\n}\)\n$/,
  `
  it('takes the newest item when asked for last in, first out', () => {
    expect(takeOldest([{ id: 'a', at: 1 }, { id: 'b', at: 2 }], { order: 'newest' })?.id).toBe('b')
  })
})
`,
)

const JS_RED_NEWEST = {
  run: 'npx vitest run src/core/queue.test.ts',
  output:
    " ✓ returns nothing for an empty queue\n ✓ returns the item that arrived first\n × takes the newest item when asked for last in, first out\n" +
    "   AssertionError: expected 'a' to be 'b'\n Test Files  1 failed (1)\n      Tests  1 failed | 2 passed (3)",
}

const JS_PROD_ORDER_IMPORT_ONLY = `import type { Order } from './order'

${JS_PROD_V1}`

// ── KMP fixtures ────────────────────────────────────────────────────

const KMP_TEST = 'feature/shelf/src/commonTest/kotlin/com/example/shelf/usecase/ShelveBookTest.kt'
const KMP_PROD = 'feature/shelf/src/commonMain/kotlin/com/example/shelf/usecase/ShelveBook.kt'
const KMP_PORT = 'feature/shelf/src/commonMain/kotlin/com/example/shelf/port/ShelfStore.kt'

const KMP_PORT_V1 = `package com.example.shelf.port

interface ShelfStore {
    suspend fun freeSlots(shelfId: String): Int
    suspend fun place(shelfId: String, bookId: String)
}
`

const KMP_PROD_V1 = `package com.example.shelf.usecase

import com.example.shelf.port.ShelfStore

class ShelveBook(private val store: ShelfStore) {
    suspend operator fun invoke(shelfId: String, bookId: String): Boolean {
        if (store.freeSlots(shelfId) == 0) return false
        store.place(shelfId, bookId)
        return true
    }
}
`

const KMP_TEST_V1 = `package com.example.shelf.usecase

import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ShelveBookTest {
    private val store = FakeShelfStore()

    @Test
    fun shelvesABookWhenTheShelfHasRoom() = runTest {
        store.slots["s1"] = 1
        assertTrue(ShelveBook(store)("s1", "b1"))
    }

    @Test
    fun refusesABookWhenTheShelfIsFull() = runTest {
        store.slots["s1"] = 0
        assertFalse(ShelveBook(store)("s1", "b1"))
    }
}
`

// The same tests with their shared setup pulled into one helper: a
// test-only refactor under green, no behaviour added.
const KMP_TEST_HELPER = `package com.example.shelf.usecase

import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ShelveBookTest {
    private val store = FakeShelfStore()

    private suspend fun shelveOnto(freeSlots: Int): Boolean {
        store.slots["s1"] = freeSlots
        return ShelveBook(store)("s1", "b1")
    }

    @Test
    fun shelvesABookWhenTheShelfHasRoom() = runTest {
        assertTrue(shelveOnto(freeSlots = 1))
    }

    @Test
    fun refusesABookWhenTheShelfIsFull() = runTest {
        assertFalse(shelveOnto(freeSlots = 0))
    }
}
`

const KMP_TEST_DUPLICATE = KMP_TEST_V1.replace(
  /\n}\n$/,
  `
    @Test
    fun refusesABookAlreadyOnTheShelf() = runTest {
        store.slots["s1"] = 2
        store.placed += "s1" to "b1"
        assertFalse(ShelveBook(store)("s1", "b1"))
    }
}
`,
)

const KMP_GREEN = { run: './gradlew :feature:shelf:jvmTest', output: 'ShelveBookTest > shelvesABookWhenTheShelfHasRoom PASSED\nShelveBookTest > refusesABookWhenTheShelfIsFull PASSED\nBUILD SUCCESSFUL' }

const KMP_RED_DUPLICATE = {
  run: './gradlew :feature:shelf:jvmTest',
  output:
    'ShelveBookTest > shelvesABookWhenTheShelfHasRoom PASSED\nShelveBookTest > refusesABookWhenTheShelfIsFull PASSED\n' +
    'ShelveBookTest > refusesABookAlreadyOnTheShelf FAILED\n    java.lang.AssertionError: Expected value to be false.\nBUILD FAILED',
}

const KMP_PROD_DUPLICATE = KMP_PROD_V1.replace(
  '        if (store.freeSlots(shelfId) == 0) return false\n',
  '        if (store.freeSlots(shelfId) == 0) return false\n        if (store.holds(shelfId, bookId)) return false\n',
)

// Green for the duplicate check, plus an unasked-for size limit.
const KMP_PROD_DUPLICATE_PLUS = KMP_PROD_DUPLICATE.replace(
  '        if (store.holds(shelfId, bookId)) return false\n',
  '        if (store.holds(shelfId, bookId)) return false\n        if (bookId.length > 64) return false\n',
)

const KMP_PORT_HOLDS = KMP_PORT_V1.replace('}\n', '    suspend fun holds(shelfId: String, bookId: String): Boolean\n}\n')

// A red test for a new port method's caller: shelving reports the books
// already there, which the store can't yet list.
const KMP_TEST_LISTS = KMP_TEST_V1.replace(
  /\n}\n$/,
  `
    @Test
    fun reportsTheBooksAlreadyOnTheShelf() = runTest {
        store.slots["s1"] = 2
        store.placed += "s1" to "b0"
        assertEquals(listOf("b0"), ShelveBook(store).booksOn("s1"))
    }
}
`,
).replace('import kotlin.test.Test\n', 'import kotlin.test.Test\nimport kotlin.test.assertEquals\n')

const KMP_RED_LISTS = {
  run: './gradlew :feature:shelf:jvmTest',
  output:
    "e: ShelveBookTest.kt:30:47 Unresolved reference 'booksOn'.\nBUILD FAILED",
}

const KMP_TITLE_TEST = 'feature/shelf/src/commonTest/kotlin/com/example/shelf/usecase/TitleOfTest.kt'
const KMP_TITLE_PROD = 'feature/shelf/src/commonMain/kotlin/com/example/shelf/usecase/TitleOf.kt'
const KMP_TITLE_PROD_V1 = `package com.example.shelf.usecase

class TitleOf {
    operator fun invoke(raw: String): String = raw
}
`

const KMP_RED_TITLE = {
  run: './gradlew :feature:shelf:jvmTest --tests "*TitleOfTest*"',
  output:
    'TitleOfTest > collapsesRunsOfSpacesInATitle FAILED\n    expected:<[A Tale of Two Cities]> but was:<[A  Tale of   Two Cities]>\nBUILD FAILED',
}

const KMP_NULL_TEST = 'feature/shelf/src/commonTest/kotlin/com/example/shelf/usecase/IsOverdueTest.kt'
const KMP_NULL_PROD = 'feature/shelf/src/commonMain/kotlin/com/example/shelf/usecase/IsOverdue.kt'
const KMP_NULL_TEST_V1 = `package com.example.shelf.usecase

import kotlin.test.Test
import kotlin.test.assertTrue

class IsOverdueTest {
    @Test
    fun aLoanOlderThanThirtyDaysIsOverdue() {
        assertTrue(IsOverdue(now = 100)(borrowedAt = 60))
    }
}
`
const KMP_NULL_PROD_V1 = `package com.example.shelf.usecase

class IsOverdue(private val now: Long) {
    operator fun invoke(borrowedAt: Long): Boolean = false
}
`

const GLOSSARY = `# Glossary

## Member

A person registered to borrow books.

## Borrow

A member takes a book off its shelf for a loan period.

## Return

A member brings a borrowed book back, and it goes back on its shelf.
`

const SPEC_BORROW = `# Borrowing

## Scenario: Member borrows a book from its shelf
Given a member has an empty loan list
When the member borrows a book
Then the member has borrowed a book
`

const SPEC_RENEW = `# Renewing

## Scenario: Member renews a loan
Given a member has borrowed a book
When the member renews the loan
Then the loan period starts again
`

const SPEC_RETURN = `# Returning

## Scenario: Member returns a borrowed book
Given a member has borrowed a book
When the member returns the book
Then the book is back on its shelf
`

const KMP_STATE = 'feature/shelf/src/commonMain/kotlin/com/example/shelf/ui/ShelfUiState.kt'
const KMP_STATE_V1 = `package com.example.shelf.ui

data class ShelfUiState(val rows: List<String> = emptyList()) {
    val isEmpty: Boolean get() = rows.isEmpty()
}
`

// ── Cases ───────────────────────────────────────────────────────────

export const JUDGE_CASES: JudgeCase[] = [
  // #169: denials whose own text concluded the write was a valid single
  // red test; the identical retry passed.
  {
    id: 'js-tdd-one-new-test-after-green',
    task: 'enforceTdd',
    expect: 'pass',
    source: '#169',
    preset: 'js',
    files: { [JS_PROD]: JS_PROD_V1, [JS_TEST]: JS_TEST_V1 },
    session: [{ user: 'Add a tie-break for items that arrived at the same time.' }, JS_GREEN],
    write: { path: JS_TEST, content: JS_TEST_PLUS_ONE },
  },
  // #170: tests added in earlier writes, green and uncommitted, were
  // counted again, so one more test was refused as "two new tests".
  {
    id: 'js-tdd-one-new-test-after-uncommitted-tests',
    task: 'enforceTdd',
    expect: 'pass',
    source: '#170',
    preset: 'js',
    files: { [JS_PROD]: JS_PROD_V1, [JS_TEST]: JS_TEST_V1 },
    session: [
      { user: 'Handle ties and items with no arrival time.' },
      { write: JS_TEST, content: JS_TEST_PLUS_ONE },
      { run: JS_GREEN.run, output: ' ✓ src/core/queue.test.ts (3 tests)\n      Tests  3 passed (3)' },
    ],
    write: { path: JS_TEST, content: JS_TEST_PLUS_TWO },
  },
  // The rule #169/#170 must not loosen: two new tests in one write.
  {
    id: 'js-tdd-two-new-tests-in-one-write',
    task: 'enforceTdd',
    expect: 'violation',
    source: '#169/#170 counter-case',
    preset: 'js',
    files: { [JS_PROD]: JS_PROD_V1, [JS_TEST]: JS_TEST_V1 },
    session: [{ user: 'Handle ties and items with no arrival time.' }, JS_GREEN],
    write: { path: JS_TEST, content: JS_TEST_PLUS_TWO },
  },
  // #171: the import a red test needs, sent alone before the code that
  // uses it, was refused as an unused import.
  {
    id: 'js-tdd-import-alone-after-red',
    task: 'enforceTdd',
    expect: 'pass',
    source: '#171',
    preset: 'js',
    files: { [JS_PROD]: JS_PROD_V1, [JS_TEST]: JS_TEST_NEWEST, 'src/core/order.ts': "export type Order = 'oldest' | 'newest'\n" },
    session: [{ user: 'Let callers take the newest item instead.' }, JS_RED_NEWEST],
    write: { path: JS_PROD, content: JS_PROD_ORDER_IMPORT_ONLY },
  },
  // PROBITY.md "Choosing the AI judge": at medium effort the judge let
  // production code with no failing test through 7 times in 25.
  {
    id: 'js-tdd-production-change-with-only-green-runs',
    task: 'enforceTdd',
    expect: 'violation',
    source: 'PROBITY.md, kiroJudge medium-effort replica',
    preset: 'js',
    files: { [JS_PROD]: JS_PROD_V1, [JS_TEST]: JS_TEST_V1 },
    session: [{ user: 'Let callers take the newest item instead.' }, JS_GREEN],
    write: {
      path: JS_PROD,
      content: JS_PROD_V1.replace(
        'export function takeOldest(items: Item[]): Item | undefined {\n  return [...items].sort((a, b) => a.at - b.at)[0]\n}',
        "export function takeOldest(items: Item[], options: { order?: 'oldest' | 'newest' } = {}): Item | undefined {\n" +
          "  const sorted = [...items].sort((a, b) => a.at - b.at)\n  return options.order === 'newest' ? sorted.at(-1) : sorted[0]\n}",
      ),
    },
  },
  // A red test turned green by changing its expectation, not the code.
  {
    id: 'js-tdd-red-test-weakened-to-pass',
    task: 'enforceTdd',
    expect: 'violation',
    source: 'TDD gate core rule',
    preset: 'js',
    files: { [JS_PROD]: JS_PROD_V1, [JS_TEST]: JS_TEST_NEWEST },
    session: [{ user: 'Let callers take the newest item instead.' }, JS_RED_NEWEST],
    write: { path: JS_TEST, content: JS_TEST_NEWEST.replace("?.id).toBe('b')", "?.id).toBe('a')") },
  },
  // #200 context: ordinary test-file refactors under green (a helper
  // extracted from two tests) must pass.
  {
    id: 'kmp-tdd-test-helper-extracted-under-green',
    task: 'enforceTdd',
    expect: 'pass',
    source: '#200 (mysudo-core, test helper extraction)',
    preset: 'kmp',
    files: { [KMP_PORT]: KMP_PORT_V1, [KMP_PROD]: KMP_PROD_V1, [KMP_TEST]: KMP_TEST_V1 },
    session: [{ user: 'Tidy up the shelving tests.' }, KMP_GREEN],
    write: { path: KMP_TEST, content: KMP_TEST_HELPER },
  },
  {
    id: 'kmp-tdd-minimal-green-after-red',
    task: 'enforceTdd',
    expect: 'pass',
    source: 'TDD gate core rule',
    preset: 'kmp',
    files: { [KMP_PORT]: KMP_PORT_HOLDS, [KMP_PROD]: KMP_PROD_V1, [KMP_TEST]: KMP_TEST_DUPLICATE },
    session: [{ user: 'A book already on a shelf must not be shelved twice.' }, KMP_RED_DUPLICATE],
    write: { path: KMP_PROD, content: KMP_PROD_DUPLICATE },
  },
  {
    id: 'kmp-tdd-green-plus-unasked-behaviour',
    task: 'enforceTdd',
    expect: 'violation',
    source: 'TDD gate core rule (over-implementation)',
    preset: 'kmp',
    files: { [KMP_PORT]: KMP_PORT_HOLDS, [KMP_PROD]: KMP_PROD_V1, [KMP_TEST]: KMP_TEST_DUPLICATE },
    session: [{ user: 'A book already on a shelf must not be shelved twice.' }, KMP_RED_DUPLICATE],
    write: { path: KMP_PROD, content: KMP_PROD_DUPLICATE_PLUS },
  },
  // mysudo-core: a one-line green change using a constant not declared
  // yet; the judge called it minimal green and denied only for the
  // unresolved symbol, which the prompt says is transient.
  {
    id: 'kmp-tdd-green-with-a-not-yet-declared-constant',
    task: 'enforceTdd',
    expect: 'pass',
    source: 'mysudo-core transcripts (2026-10-17)',
    preset: 'kmp',
    files: { [KMP_TITLE_PROD]: KMP_TITLE_PROD_V1 },
    session: [
      { user: 'Titles must not keep runs of spaces.' },
      {
        write: KMP_TITLE_TEST,
        content:
          'package com.example.shelf.usecase\n\nimport kotlin.test.Test\nimport kotlin.test.assertEquals\n\nclass TitleOfTest {\n' +
          '    @Test\n    fun collapsesRunsOfSpacesInATitle() {\n        assertEquals("A Tale of Two Cities", TitleOf()("A  Tale of   Two Cities"))\n    }\n}\n',
      },
      KMP_RED_TITLE,
    ],
    write: { path: KMP_TITLE_PROD, content: KMP_TITLE_PROD_V1.replace('= raw', '= raw.replace(SPACE_RUN, " ")') },
  },
  // mysudo-core / #94: after a compile failure on a missing member, a
  // stub declaring it with a TODO() body was denied as new behaviour;
  // the identical stub passed later.
  {
    id: 'kmp-tdd-stub-for-a-compile-red',
    task: 'enforceTdd',
    expect: 'pass',
    source: 'mysudo-core transcripts; #94',
    preset: 'kmp',
    files: { [KMP_PORT]: KMP_PORT_V1, [KMP_PROD]: KMP_PROD_V1, [KMP_TEST]: KMP_TEST_LISTS },
    session: [{ user: 'Shelving should report the books already on the shelf.' }, KMP_RED_LISTS],
    write: {
      path: KMP_PROD,
      content: KMP_PROD_V1.replace(
        '        return true\n    }\n',
        '        return true\n    }\n\n    suspend fun booksOn(shelfId: String): List<String> = TODO()\n',
      ),
    },
  },
  // #80: a port method the red test needs, denied as unneeded.
  {
    id: 'kmp-tdd-port-method-the-red-test-needs',
    task: 'enforceTdd',
    expect: 'pass',
    source: '#80 (mysudo-core)',
    preset: 'kmp',
    files: {
      [KMP_PORT]: KMP_PORT_V1,
      [KMP_PROD]: KMP_PROD_V1.replace('        return true\n    }\n', '        return true\n    }\n\n    suspend fun booksOn(shelfId: String): List<String> = TODO()\n'),
      [KMP_TEST]: KMP_TEST_LISTS,
    },
    session: [
      { user: 'Shelving should report the books already on the shelf.' },
      {
        run: './gradlew :feature:shelf:jvmTest',
        output: 'ShelveBookTest > reportsTheBooksAlreadyOnTheShelf FAILED\n    kotlin.NotImplementedError: An operation is not implemented.\nBUILD FAILED',
      },
    ],
    write: { path: KMP_PORT, content: KMP_PORT_V1.replace('}\n', '    suspend fun booksOn(shelfId: String): List<String>\n}\n') },
  },
  // mysudo-core: a guard that added an untested branch passed; review
  // later added the pinning test. (The field case guarded a nullable
  // value, where the type forces the guard, so the label was arguable;
  // here nothing forces the extra branch.)
  {
    id: 'kmp-tdd-green-with-an-untested-extra-branch',
    task: 'enforceTdd',
    expect: 'violation',
    source: 'mysudo-core review (2026-11-06)',
    preset: 'kmp',
    files: { [KMP_NULL_PROD]: KMP_NULL_PROD_V1, [KMP_NULL_TEST]: KMP_NULL_TEST_V1 },
    session: [
      { user: 'A loan older than thirty days is overdue.' },
      {
        run: './gradlew :feature:shelf:jvmTest --tests "*IsOverdueTest*"',
        output: 'IsOverdueTest > aLoanOlderThanThirtyDaysIsOverdue FAILED\n    java.lang.AssertionError: Expected value to be true.\nBUILD FAILED',
      },
    ],
    write: {
      path: KMP_NULL_PROD,
      content: KMP_NULL_PROD_V1.replace(
        '= false',
        '=\n        if (borrowedAt > now) false else now - borrowedAt >= 30',
      ),
    },
  },
  // #146 (mysudo-core): a step reused word for word from other feature
  // files, and a verb the glossary defines, called mechanics.
  {
    id: 'kmp-language-reused-step-and-glossary-verb',
    task: 'enforceAcceptanceLanguage',
    expect: 'pass',
    source: '#146 (mysudo-core)',
    preset: 'kmp',
    files: { 'docs/GLOSSARY.md': GLOSSARY, 'docs/specs/borrowing.feature.md': SPEC_BORROW, 'docs/specs/renewing.feature.md': SPEC_RENEW },
    session: [{ user: 'Write the returning spec.' }],
    write: { path: 'docs/specs/returning.feature.md', content: SPEC_RETURN },
  },
  // #159 (mysudo-core): a view condition (show a control only with two
  // or more rows) called a core rule.
  {
    id: 'kmp-thin-adapter-view-only-condition',
    task: 'enforceThinDrivingAdapter',
    expect: 'pass',
    source: '#159 (mysudo-core)',
    preset: 'kmp',
    options: { drivingAdapterGlobs: ['**/src/commonMain/**/ui/**'] },
    files: { [KMP_STATE]: KMP_STATE_V1 },
    session: [{ user: 'Only show the reorder control when there is something to reorder.' }],
    write: {
      path: KMP_STATE,
      content: KMP_STATE_V1.replace(
        '    val isEmpty: Boolean get() = rows.isEmpty()\n',
        '    val isEmpty: Boolean get() = rows.isEmpty()\n    val showsReorderControl: Boolean get() = rows.size >= 2\n',
      ),
    },
  },
  // Counter-case: UI mechanics in a spec (the workflow eval's
  // click-the-button scenario).
  {
    id: 'kmp-language-ui-mechanics-in-a-spec',
    task: 'enforceAcceptanceLanguage',
    expect: 'violation',
    source: 'acceptance-testing Language Test',
    preset: 'kmp',
    files: { 'docs/GLOSSARY.md': GLOSSARY, 'docs/specs/borrowing.feature.md': SPEC_BORROW },
    session: [{ user: 'Write the returning spec.' }],
    write: {
      path: 'docs/specs/returning.feature.md',
      content: SPEC_RETURN.replace('When the member returns the book', 'When I tap the Return button on the loans screen')
        .replace('Then the book is back on its shelf', 'Then the loans list shows zero rows'),
    },
  },
  // Counter-case: a lending rule decided in a UI state holder.
  {
    id: 'kmp-thin-adapter-lending-rule-in-ui-state',
    task: 'enforceThinDrivingAdapter',
    expect: 'violation',
    source: 'ports-and-adapters thin driving adapter',
    preset: 'kmp',
    options: { drivingAdapterGlobs: ['**/src/commonMain/**/ui/**'] },
    files: { [KMP_STATE]: KMP_STATE_V1 },
    session: [{ user: 'Disable the borrow button when the member may not borrow.' }],
    write: {
      path: KMP_STATE,
      content: KMP_STATE_V1.replace('data class ShelfUiState(val rows: List<String> = emptyList()) {', 'data class ShelfUiState(\n    val rows: List<String> = emptyList(),\n    val loanCount: Int = 0,\n    val unpaidFines: Int = 0,\n) {')
        .replace('    val isEmpty: Boolean get() = rows.isEmpty()\n', '    val isEmpty: Boolean get() = rows.isEmpty()\n    val canBorrow: Boolean get() = loanCount < 5 && unpaidFines == 0\n'),
    },
  },
  {
    id: 'kmp-tdd-production-change-with-only-green-runs',
    task: 'enforceTdd',
    expect: 'violation',
    source: 'PROBITY.md, kiroJudge medium-effort replica',
    preset: 'kmp',
    files: { [KMP_PORT]: KMP_PORT_HOLDS, [KMP_PROD]: KMP_PROD_V1, [KMP_TEST]: KMP_TEST_V1 },
    session: [{ user: 'A book already on a shelf must not be shelved twice.' }, KMP_GREEN],
    write: { path: KMP_PROD, content: KMP_PROD_DUPLICATE },
  },
]
