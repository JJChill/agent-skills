/**
 * Issue #115: in-progress acceptance tests are committed expected-to-fail,
 * so the build stays green while the feature is driven. Shared by the
 * Kotlin, Swift and JS TDD addenda.
 */
export const IN_PROGRESS_TDD_RULE =
  '- An in-progress acceptance test is expected to fail. A test carrying an expected-to-fail marker ' +
  '(`inProgress { }`, `test.failing`, `test.fails`, `withKnownIssue`, `XCTExpectFailure`) passes only while ' +
  'the behavior it describes is missing, so its passing run is not evidence that the behavior works, and it ' +
  'is not a red for production code to answer. Adding a new test that carries the marker is allowed, like ' +
  'adding a failing test. Removing the marker is promotion: the test is then an ordinary test, its failing ' +
  'run is an ordinary red, and production code may answer it until it passes. Adding the marker to a test ' +
  'that did not carry it disables that test, and is a violation like deleting it.'
