# Tests

Each package keeps its unit tests next to it (`apps/web/tests`, `server/spacetime/tests`, `server/upload/tests`,
`pipeline/tests`). This folder holds the tests that span packages:

- `*.test.ts`: Vitest tests run by `npm test`. `adapter.test.ts` drives the viewer's network adapter against the real
  SpacetimeDB module in-process (`room-harness.ts`); `upload-account.test.ts` checks that the upload API and the web
  app agree on account keys.
- `integration/`: suites against services running locally (SpacetimeDB, the upload API, the native iOS checks), each
  started by an npm script such as `npm run test:integration` or `npm run test:upload-api`.
- `e2e/`: suites against deployed services (the hosted upload API, a real GPU worker). They write test data to the
  service they target.
- `fixtures/`: shared test media.

[docs/development.md](../docs/development.md) lists every suite with what it needs and how to run it.
