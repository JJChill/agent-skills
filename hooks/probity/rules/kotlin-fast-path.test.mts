import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { withKotlinFastPath } from './kotlin.ts'

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as {
  optionalDependencies?: Record<string, string>
  repository?: { type: string; url: string; directory?: string }
}

test('published installs include the Kotlin fast-path parser dependencies', () => {
  assert.deepEqual(packageJson.optionalDependencies, {
    '@ast-grep/lang-kotlin': '0.0.7',
    '@ast-grep/napi': '0.45.1',
  })
})

test('package repository metadata matches GitHub Actions provenance', () => {
  assert.deepEqual(packageJson.repository, {
    type: 'git',
    url: 'https://github.com/JJChill/agent-skills',
    directory: 'hooks/probity',
  })
})

const before = `import kotlin.test.Test

class ExampleTest {
  @Test
  fun existing() {
    check(true)
  }
}
`

function contextWith(content: string) {
  return {
    readFile: async () => ({ kind: 'present' as const, content }),
  }
}

function delegateSpy() {
  let calls = 0
  return {
    calls: () => calls,
    rule: async () => {
      calls += 1
      return { kind: 'violation' as const, reason: 'delegated' }
    },
  }
}

async function evaluate(after: string) {
  const delegate = delegateSpy()
  const rule = withKotlinFastPath(delegate.rule)
  const result = await rule(
    {
      kind: 'write',
      path: '/project/src/commonTest/kotlin/ExampleTest.kt',
      content: after,
    },
    contextWith(before),
  )
  return { delegate, result }
}

test('one additive Kotlin test passes without delegating', async () => {
  const after = before.replace(
    '\n}\n',
    `
  @Test
  fun added() {
    check(true)
  }
}
`,
  )

  const { delegate, result } = await evaluate(after)

  assert.equal(result.kind, 'pass')
  assert.deepEqual(result.kind === 'pass' ? result.notes : undefined, [
    { kind: 'fast-path' },
  ])
  assert.equal(delegate.calls(), 0)
})

test('weakening an existing test while adding one delegates', async () => {
  const after = before
    .replace('check(true)', 'check(false)')
    .replace(
      '\n}\n',
      `
  @Test
  fun added() {
    check(true)
  }
}
`,
    )

  const { delegate, result } = await evaluate(after)

  assert.equal(result.kind, 'violation')
  assert.equal(delegate.calls(), 1)
})

test('deleting one existing test while adding two delegates', async () => {
  const after = `import kotlin.test.Test

class ExampleTest {
  @Test
  fun addedOne() {
    check(true)
  }

  @Test
  fun addedTwo() {
    check(true)
  }
}
`

  const { delegate, result } = await evaluate(after)

  assert.equal(result.kind, 'violation')
  assert.equal(delegate.calls(), 1)
})

test('adding multiple tests delegates', async () => {
  const after = before.replace(
    '\n}\n',
    `
  @Test
  fun addedOne() {
    check(true)
  }

  @Test
  fun addedTwo() {
    check(true)
  }
}
`,
  )

  const { delegate, result } = await evaluate(after)

  assert.equal(result.kind, 'violation')
  assert.equal(delegate.calls(), 1)
})

test('production-only Kotlin changes delegate', async () => {
  const after = before.replace(
    'class ExampleTest {',
    'class ExampleTest {\n  fun productionHelper() = 42',
  )

  const { delegate, result } = await evaluate(after)

  assert.equal(result.kind, 'violation')
  assert.equal(delegate.calls(), 1)
})

test('disabling an existing test while adding one delegates', async () => {
  const after = before.replace(
    '  @Test\n  fun existing()',
    `  @Test
  fun added() {
    check(true)
  }

  @Disabled
  @Test
  fun existing()`,
  )

  const { delegate, result } = await evaluate(after)

  assert.equal(result.kind, 'violation')
  assert.equal(delegate.calls(), 1)
})

test('parser fallback is visible when deterministic analysis fails', async () => {
  const delegate = delegateSpy()
  const rule = withKotlinFastPath(delegate.rule, {
    patterns: [Symbol('invalid ast-grep pattern')],
  })

  const result = await rule(
    {
      kind: 'write',
      path: '/project/src/commonTest/kotlin/ExampleTest.kt',
      content: `${before}\n`,
    },
    contextWith(before),
  )

  assert.equal(result.kind, 'violation')
  assert.match(
    result.kind === 'violation' ? result.reason : '',
    /Kotlin fast path unavailable.*parsing failed/i,
  )
  assert.equal(delegate.calls(), 1)
})

test('functions mentioning @Test in comments or strings delegate', async () => {
  const productionBefore = `class Production {
}
`
  const mentions = [
    'fun commentOnly() { // @Test mention\n  }',
    'fun stringOnly() = "@Test annotation name"',
  ]

  for (const mention of mentions) {
    const delegate = delegateSpy()
    const rule = withKotlinFastPath(delegate.rule)
    const result = await rule(
      {
        kind: 'write',
        path: '/project/src/commonTest/kotlin/CommentMentionTest.kt',
        content: productionBefore.replace('}', `  ${mention}\n}`),
      },
      contextWith(productionBefore),
    )

    assert.equal(result.kind, 'violation', mention)
    assert.equal(delegate.calls(), 1, mention)
  }
})

test('one new Kotlin test plus its import passes without delegating', async () => {
  const after = `import kotlin.test.Test

class ImportedExampleTest {
  @Test
  fun added() {
    check(true)
  }
}
`
  const delegate = delegateSpy()
  const rule = withKotlinFastPath(delegate.rule)

  const result = await rule(
    {
      kind: 'write',
      path: '/project/src/commonTest/kotlin/ImportedExampleTest.kt',
      content: after,
    },
    { readFile: async () => ({ kind: 'absent' as const }) },
  )

  assert.equal(result.kind, 'pass')
  assert.equal(delegate.calls(), 0)
})

test('missing current file content reports an unavailable fast path', async () => {
  const delegate = delegateSpy()
  const rule = withKotlinFastPath(delegate.rule)

  const result = await rule(
    {
      kind: 'write',
      path: '/project/src/commonTest/kotlin/ExampleTest.kt',
      content: `${before}\n`,
    },
    {},
  )

  assert.equal(result.kind, 'violation')
  assert.match(
    result.kind === 'violation' ? result.reason : '',
    /Kotlin fast path unavailable.*current file content unavailable/i,
  )
  assert.equal(delegate.calls(), 1)
})

test('a real @Test function on a production path delegates', async () => {
  const productionBefore = `class Production {
}
`
  const after = productionBefore.replace(
    '}',
    `  @Test
  fun misplacedTest() {
    check(true)
  }
}`,
  )
  const delegate = delegateSpy()
  const rule = withKotlinFastPath(delegate.rule)

  const result = await rule(
    {
      kind: 'write',
      path: '/project/src/commonMain/kotlin/Production.kt',
      content: after,
    },
    contextWith(productionBefore),
  )

  assert.equal(result.kind, 'violation')
  assert.equal(delegate.calls(), 1)
})

test('adding a helper inside an existing test class delegates', async () => {
  const after = before
    .replace('class ExampleTest {', 'class ExampleTest {\n  fun helper() = 42')
    .replace(
      '\n}\n',
      `
  @Test
  fun added() {
    check(true)
  }
}
`,
    )

  const { delegate, result } = await evaluate(after)

  assert.equal(result.kind, 'violation')
  assert.equal(delegate.calls(), 1)
})

test('a brand-new one-test Kotlin file passes', async () => {
  const delegate = delegateSpy()
  const rule = withKotlinFastPath(delegate.rule)
  const result = await rule(
    {
      kind: 'write',
      path: '/project/src/commonTest/kotlin/NewTest.kt',
      content: `import kotlin.test.Test

class NewTest {
  @Test
  fun added() {
    check(true)
  }
}
`,
    },
    { readFile: async () => ({ kind: 'absent' as const }) },
  )

  assert.equal(result.kind, 'pass')
  assert.equal(delegate.calls(), 0)
})

test('parser fallback adds an operator note to a wrapped pass', async () => {
  const rule = withKotlinFastPath(
    async () => ({ kind: 'pass' as const }),
    { patterns: [Symbol('invalid ast-grep pattern')] },
  )

  const result = await rule(
    {
      kind: 'write',
      path: '/project/src/commonTest/kotlin/ExampleTest.kt',
      content: `${before}\n`,
    },
    contextWith(before),
  )

  assert.equal(result.kind, 'pass')
  assert.match(result.kind === 'pass' ? (result.reason ?? '') : '', /parsing failed/)
  assert.deepEqual(result.kind === 'pass' ? result.notes : undefined, [
    { kind: 'kotlin-fast-path-unavailable' },
  ])
})

test('disabling the test class while adding one test delegates', async () => {
  const after = before
    .replace(
      'import kotlin.test.Test',
      'import kotlin.test.Ignore\nimport kotlin.test.Test',
    )
    .replace('class ExampleTest {', '@Ignore\nclass ExampleTest {')
    .replace(
      '\n}\n',
      `
  @Test
  fun added() {
    check(true)
  }
}
`,
    )

  const { delegate, result } = await evaluate(after)

  assert.equal(result.kind, 'violation')
  assert.equal(delegate.calls(), 1)
})

test('adding a disabled test delegates', async () => {
  const after = before.replace(
    '\n}\n',
    `
  @Ignore
  @Test
  fun added() {
    check(true)
  }
}
`,
  )

  const { delegate, result } = await evaluate(after)

  assert.equal(result.kind, 'violation')
  assert.equal(delegate.calls(), 1)
})

test('shadowing an assertion used by existing tests delegates', async () => {
  const after = before
    .replace(
      'class ExampleTest {',
      'private fun check(value: Boolean) = Unit\n\nclass ExampleTest {',
    )
    .replace(
      '\n}\n',
      `
  @Test
  fun added() {
    check(true)
  }
}
`,
    )

  const { delegate, result } = await evaluate(after)

  assert.equal(result.kind, 'violation')
  assert.equal(delegate.calls(), 1)
})

test('custom testFilePattern enables nonstandard test layouts', async () => {
  const after = before.replace(
    '\n}\n',
    `
  @Test
  fun added() {
    check(true)
  }
}
`,
  )
  const delegate = delegateSpy()
  const rule = withKotlinFastPath(delegate.rule, {
    testFilePattern: /\/custom-tests\//g,
  })

  const result = await rule(
    {
      kind: 'write',
      path: '/project/custom-tests/ExampleTest.kt',
      content: after,
    },
    contextWith(before),
  )

  assert.equal(result.kind, 'pass')
  assert.equal(delegate.calls(), 0)
})

test('adding a verbatim duplicate test delegates', async () => {
  const duplicate = `  @Test
  fun existing() {
    check(true)
  }
`
  const after = before.replace('\n}\n', `\n${duplicate}}\n`)

  const { delegate, result } = await evaluate(after)

  assert.equal(result.kind, 'violation')
  assert.equal(delegate.calls(), 1)
})

test('shadowing an assertion with an import alias delegates', async () => {
  const after = before
    .replace(
      'import kotlin.test.Test',
      'import evil.assertions.noop as check\nimport kotlin.test.Test',
    )
    .replace(
      '\n}\n',
      `
  @Test
  fun added() {
    check(true)
  }
}
`,
    )

  const { delegate, result } = await evaluate(after)

  assert.equal(result.kind, 'violation')
  assert.equal(delegate.calls(), 1)
})

test('nested annotated functions are not runnable tests', async () => {
  const fixtures = [
    `class FakeTest {
  fun helper() {
    @Test
    fun nested() {
      check(true)
    }
  }
}
`,
    `class FakeTest {
  val holder = object {
    @Test
    fun nested() {
      check(true)
    }
  }
}
`,
    `class FakeTest {
  class NestedTest {
    @Test
    fun nested() {
      check(true)
    }
  }
}
`,
  ]

  for (const content of fixtures) {
    const delegate = delegateSpy()
    const rule = withKotlinFastPath(delegate.rule)
    const result = await rule(
      {
        kind: 'write',
        path: '/project/src/commonTest/kotlin/FakeTest.kt',
        content,
      },
      { readFile: async () => ({ kind: 'absent' as const }) },
    )

    assert.equal(result.kind, 'violation')
    assert.equal(delegate.calls(), 1)
  }
})

test('wrapping prior test source in a comment while adding one test delegates', async () => {
  const kotestBefore = `class ExistingSpec : StringSpec({
  "works" {
    check(true)
  }
})
`
  const after = `/*${kotestBefore}*/
class AddedTest {
  @Test
  fun added() {
    check(true)
  }
}
`
  const delegate = delegateSpy()
  const rule = withKotlinFastPath(delegate.rule)

  const result = await rule(
    {
      kind: 'write',
      path: '/project/src/commonTest/kotlin/ExistingSpec.kt',
      content: after,
    },
    contextWith(kotestBefore),
  )

  assert.equal(result.kind, 'violation')
  assert.equal(delegate.calls(), 1)
})

test('adding a star import and one test to an existing file delegates', async () => {
  const after = before
    .replace(
      'import kotlin.test.Test',
      'import evil.assertions.*\nimport kotlin.test.Test',
    )
    .replace(
      '\n}\n',
      `
  @Test
  fun added() {
    check(true)
  }
}
`,
    )

  const { delegate, result } = await evaluate(after)

  assert.equal(result.kind, 'violation')
  assert.equal(delegate.calls(), 1)
})

test('a nested src/test substring cannot make a production path eligible', async () => {
  const delegate = delegateSpy()
  const rule = withKotlinFastPath(delegate.rule)
  const after = before.replace(
    '\n}\n',
    `
  @Test
  fun added() {
    check(true)
  }
}
`,
  )

  const result = await rule(
    {
      kind: 'write',
      path: '/project/src/main/kotlin/generated/src/test/kotlin/ExampleTest.kt',
      content: after,
    },
    contextWith(before),
  )

  assert.equal(result.kind, 'violation')
  assert.equal(delegate.calls(), 1)
})

test('a trailing line comment cannot disable the following old lifecycle annotation', async () => {
  const lifecycleBefore = `import kotlin.test.AfterTest
import kotlin.test.Test

class LifecycleTest {
  @Test
  fun existing() {
    check(true)
  }

  @AfterTest
  fun verifyNoStrayCharges() {
    check(true)
  }
}
`
  const after = lifecycleBefore.replace(
    '  @AfterTest',
    `  // added test
  @Test
  fun added() {
    check(true)
  }
  //  @AfterTest`,
  )
  const delegate = delegateSpy()
  const rule = withKotlinFastPath(delegate.rule)
  const result = await rule(
    {
      kind: 'write',
      path: '/project/src/commonTest/kotlin/LifecycleTest.kt',
      content: after,
    },
    contextWith(lifecycleBefore),
  )

  assert.equal(result.kind, 'violation')
  assert.equal(delegate.calls(), 1)
})

test('a duplicate test inserted into a nested class delegates', async () => {
  const nestedBefore = `import kotlin.test.Test

class OuterTest {
  @Test
  fun existing() {
    check(true)
  }

  class Nested {
  }
}
`
  const duplicate = `    @Test
    fun existing() {
      check(true)
    }
`
  const after = nestedBefore.replace('  class Nested {\n', `  class Nested {\n${duplicate}`)
  const delegate = delegateSpy()
  const rule = withKotlinFastPath(delegate.rule)
  const result = await rule(
    {
      kind: 'write',
      path: '/project/src/commonTest/kotlin/OuterTest.kt',
      content: after,
    },
    contextWith(nestedBefore),
  )

  assert.equal(result.kind, 'violation')
  assert.equal(delegate.calls(), 1)
})

test('a checkout below a src directory still recognizes its test source set', async () => {
  const after = before.replace(
    '\n}\n',
    `
  @Test
  fun added() {
    check(true)
  }
}
`,
  )
  const delegate = delegateSpy()
  const rule = withKotlinFastPath(delegate.rule)
  const result = await rule(
    {
      kind: 'write',
      path: '/Users/developer/src/project/src/commonTest/kotlin/ExampleTest.kt',
      content: after,
    },
    contextWith(before),
  )

  assert.equal(result.kind, 'pass')
  assert.equal(delegate.calls(), 0)
})

test('a duplicate test inserted into a top-level sibling class delegates', async () => {
  const sibling = `
class SiblingTest {
  @Test
  fun existing() {
    check(true)
  }
}
`
  const delegate = delegateSpy()
  const rule = withKotlinFastPath(delegate.rule)
  const result = await rule(
    {
      kind: 'write',
      path: '/project/src/commonTest/kotlin/ExampleTest.kt',
      content: before + sibling,
    },
    contextWith(before),
  )

  assert.equal(result.kind, 'violation')
  assert.equal(delegate.calls(), 1)
})

test('adding a test to an already ignored class delegates', async () => {
  const ignoredBefore = before.replace(
    'class ExampleTest {',
    '@Ignore\nclass ExampleTest {',
  )
  const after = ignoredBefore.replace(
    '\n}\n',
    `
  @Test
  fun added() {
    check(true)
  }
}
`,
  )
  const delegate = delegateSpy()
  const rule = withKotlinFastPath(delegate.rule)
  const result = await rule(
    {
      kind: 'write',
      path: '/project/src/commonTest/kotlin/ExampleTest.kt',
      content: after,
    },
    contextWith(ignoredBefore),
  )

  assert.equal(result.kind, 'violation')
  assert.equal(delegate.calls(), 1)
})

test('a brand-new test file with an unrelated extra class delegates', async () => {
  const content = `import kotlin.test.Test

class ProductionHelper

class NewTest {
  @Test
  fun added() {
    check(true)
  }
}
`
  const delegate = delegateSpy()
  const rule = withKotlinFastPath(delegate.rule)
  const result = await rule(
    {
      kind: 'write',
      path: '/project/src/commonTest/kotlin/NewTest.kt',
      content,
    },
    { readFile: async () => ({ kind: 'absent' as const }) },
  )

  assert.equal(result.kind, 'violation')
  assert.equal(delegate.calls(), 1)
})
