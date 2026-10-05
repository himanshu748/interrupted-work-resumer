# Interrupted Work Resumer

Return to interrupted work with the context you saved and the file changes that happened while you were away. Compare selected files, review changed or deleted evidence, and download a continuation before deciding what to do next.

This repository contains this product and its required shared modules only. It runs independently of the original four-project suite.

## Run

Requires Node.js 22 or newer. Install the pinned dependencies, then start the loopback-only server:

```sh
npm ci
npm start
```

Open `http://127.0.0.1:4190/` for the landing. The same landing is available at `/products/resumer`; the working UI is at `/resumer`. `DESK_PORT` changes the port. `DESK_WORKSPACE` selects the parent directory of local projects where applicable. Managed records are stored beneath `work/desk` in that workspace; keep this directory private and outside version control.

## Verify

```sh
npx playwright install chromium
npm test
```

The browser installation is required for browser tests. An already installed browser can instead be selected with `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`. `npm run test:smoke` checks the standalone landing, working UI, evidence assets, session protections, denied sibling routes and unconfigured inference. Tests use local fixtures; no live provider credentials are required. Avoid supplying credentials while testing.

See [selected validation](VALIDATION.md) for the current check scope and results.

## Scope and boundaries

Save selected file evidence and context, then compare changed/deleted files when resuming interrupted work. The selected project must sit within the configured workspace; credential paths and symlinks are excluded. Watch-generated continuations record local observations, never execute the next action or validate claimed blockers. Optional NVIDIA Nemotron planning requires explicit selected-data consent and review.

Live sponsor inference and remote execution proof remain unverified. `.env.example` lists only this product's optional settings. Never commit `.env`, tokens, runtime records or user-selected project files. The server checks exact local Host/Origin, requires a session token for APIs, bounds request size, and serves only explicit static assets. Sibling product pages and APIs are absent.

## Product capture

![Actual local continuation with synthetic selected files; no saved action was executed](src/desk/public/product-evidence/resumer-local-continuation-desktop.png)

Actual local continuation with synthetic selected files; no saved action was executed.

## Evidence and tests retained

The landing screenshots are actual controlled local UI captures with textual alternatives and image failure fallbacks. JSON evidence is synthetic/controlled and carries its observation limits.

Product unit/service/browser suites and shared inference-runtime tests are retained.  Cited interpretation/planning unit cases were split from the shared workflow suite. Cross-product hub, marketing, motion, and shared multi-product browser suites are omitted; their route assumptions do not apply to a standalone repository. The standalone smoke suite covers the new server boundary. Historical private audit/output directories and old Git history are intentionally absent.

MIT licensed; the bundled self-hosted Manrope font license is in `src/desk/public/fonts/LICENSE.txt`.
