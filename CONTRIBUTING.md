# Contributing to memos

Thanks for helping. This page covers how the repository is organized, how to get set up, the checks a pull request has
to pass, and the conventions that keep the parts compatible with each other.

## How the repository is organized

memos is an npm workspaces monorepo with one Python package beside it. `apps/web` is the web app (the viewer, the
memory library and the capture test page), `apps/ios` the iPhone capture app, `server/spacetime` the SpacetimeDB module
(accounts, memories, parties, the shared clock, takes and grabbing), `server/upload` the upload API, `packages/shared`
the `memory.json` scene format, and `pipeline` the Python vision pipeline that turns a clip into a scene. Cross-package
and live test suites are in `tests`, and the guides in `docs`. The full layout is in the [README](README.md); how the
parts talk to each other is in [docs/architecture.md](docs/architecture.md).

## Setting up

Follow [docs/development.md](docs/development.md): Node.js 22.13 or newer, `npm install`, then
`LOCAL_HTTP=1 npm run dev` for the viewer alone, or the full local stack with the SpacetimeDB CLI 2.13.0 for
multiplayer and uploads. For the pipeline you need Python 3.10 or newer and `pip install -e "pipeline[dev]"`.

## Before you open a pull request

Run the same checks as CI:

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
```

For changes under `pipeline/`:

```bash
ruff check .
ruff format --check .
pytest pipeline
```

If you change the SpacetimeDB module, the network client (`apps/web/src/net/`) or the upload API, also run the live
suites against a local SpacetimeDB: `npm run test:integration`, `npm run test:party` and `npm run test:adapter`, plus
the self-contained `npm run test:connections` and `npm run test:upload-api`. Every suite and what it needs is listed in
[docs/development.md](docs/development.md#test-suites).

## Formatting

Prettier formats the JavaScript, TypeScript, JSON, YAML, CSS, HTML and Markdown (`npm run format`; settings in
`.prettierrc.json`), and Ruff formats and lints the Python (`ruff format .`; settings in `ruff.toml`). ESLint checks the
TypeScript and JavaScript (`eslint.config.js`); unused variables and arguments must start with `_`. Lines are up to 120
characters, and `.editorconfig` sets two-space indents, four for Python and Swift. The Swift sources in `apps/ios/` are
not formatted automatically.

The bulk reformat commit is listed in `.git-blame-ignore-revs`. GitHub skips it in blame views; to skip it locally too,
run:

```bash
git config blame.ignoreRevsFile .git-blame-ignore-revs
```

## Conventions that matter here

- **The scene format is defined twice.** `packages/shared/src/manifest.ts` (the types),
  `packages/shared/src/validate.ts` (`validateManifest`, `validateTrack`) and the Python mirror
  `pipeline/memreplay/manifest.py` change together, in the same pull request. `memory.json` is the only contract
  between the pipeline and the viewer ([docs/scene-format.md](docs/scene-format.md)), and the viewer never depends on a
  running pipeline: develop it against the demo and mock scenes in `apps/web/public/`.
- **Reducers and their bindings change together.** After changing `server/spacetime/`, run `npm run stdb:generate`
  (SpacetimeDB CLI 2.13.0) and commit the regenerated `apps/web/src/module_bindings/` with the change, along with the
  client code that uses it.
- **The upload API and the iPhone app change together.** The app calls the account and upload routes directly
  (`apps/ios/SceneCapture/SceneLibrary.swift`), as does the web app (`apps/web/src/account/`, `apps/web/src/upload/`).
  A change to a route or a payload ships with the matching client changes ([docs/upload-api.md](docs/upload-api.md)).
- **Generated files and lockfiles are regenerated, never edited by hand:** `apps/web/src/module_bindings/` with
  `npm run stdb:generate`, `package-lock.json` with `npm install`, the Xcode projects with `npm run ios:generate` (after
  adding or removing a Swift file in `apps/ios/SceneCapture/`), and `docs/architecture/arch.svg` with
  `python docs/architecture/make_arch.py`.
- **No large media in git.** `.ply`, `.spz`, `.splat`, `.glb`, `.mp4` and `.mov` files go to object storage or stay in
  git-ignored folders such as `data/` and `apps/web/public/memories/`. The only exceptions are the small test clip
  `tests/fixtures/plant.mp4` and `apps/web/public/mock/`.
- **SpacetimeDB module code is deterministic.** No `Math.random()` or `Date.now()` in `server/spacetime/`; use
  `ctx.random` and `ctx.timestamp`. Names are snake_case on the wire and in SQL, camelCase in TypeScript.
- **No secrets in the repository.** `.env` files are git-ignored, except the `.env.example` templates and
  `apps/web/.env.hosted`, which holds public values only. `VITE_*` variables are compiled into the page, so never put a
  credential or token in one.
- **Tests live next to their package:** `apps/web/tests/`, `server/spacetime/tests/`, `server/upload/tests/` and
  `pipeline/tests/`. Tests that span packages go in `tests/` (unit), `tests/integration/` (live, against local
  services) or `tests/e2e/` (against deployed services).
- **One feature per pull request, in small commits.** Write commit subjects in the imperative, such as "Move the tab
  identity lock out of the network client". Update the guides in `docs/` when behaviour changes.

## Reporting bugs and asking questions

Open an issue. For a bug, say what you did, what you expected and what happened, and include the device and browser
(desktop, phone or Quest) and any console output. Never paste tokens, passwords or worker environment files into an
issue.
