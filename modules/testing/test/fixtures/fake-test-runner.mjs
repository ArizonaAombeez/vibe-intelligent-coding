#!/usr/bin/env node
// Stand-in for a real test command (npm test/pytest/etc.), driven by env
// vars so runExecution.test.ts doesn't depend on any real test framework
// being installed. Modes:
//   all-pass     -> exit 0, prints a PASS line per FAKE_TEST_TITLES entry
//   all-fail     -> exit 1, prints a FAIL line per FAKE_TEST_TITLES entry
//   some-fail    -> exit 1, prints PASS for the first title, FAIL for the rest
//   nonzero-exit -> exit 1, no parseable per-test lines (aggregate fallback path)
const mode = process.env.FAKE_TEST_MODE ?? 'all-pass'
const titles = (process.env.FAKE_TEST_TITLES ?? '').split('|||').filter(Boolean)

if (mode === 'all-pass') {
  for (const title of titles) {
    console.log(`PASS ${title}`)
  }
  process.exit(0)
} else if (mode === 'all-fail') {
  for (const title of titles) {
    console.log(`FAIL ${title}`)
  }
  process.exit(1)
} else if (mode === 'some-fail') {
  titles.forEach((title, i) => {
    console.log(i === 0 ? `PASS ${title}` : `FAIL ${title}`)
  })
  process.exit(1)
} else if (mode === 'nonzero-exit') {
  console.log('unparseable output, something went wrong')
  process.exit(1)
}
