# Contributing

Keep each change scoped to a reproducible problem or a clearly described workflow. Use a disposable local board and synthetic data. Preserve failed results and report the command, runtime version and scope actually checked. When changing a dependency, update and review the package lock, license and bundled notices together.

## Local checks

Use Windows x64, Node.js 24.22.1 and a qualified local NTFS directory. Follow the candidate dependency setup in the [Quickstart](docs/QUICKSTART.md). The existing package typecheck command is:

~~~powershell
npm run typecheck
~~~

Run the full 15-file serial suite from the app directory:

~~~powershell
node --test --test-concurrency=1 test/board.test.ts test/store.test.ts test/host.test.ts test/readonly.test.ts test/mcp.test.ts test/mcp-write.test.ts test/review.test.ts test/security.test.ts test/public-export.test.ts test/github-board.test.ts test/github-connection.test.ts test/github-host.test.ts test/github-mcp.test.ts test/github-publication-board.test.ts test/github-publication.test.ts
~~~

The package's `npm test` script runs the smaller board, store and host subset. Use the explicit command above when reporting the full suite.

Optional browser journeys use a separately installed local Playwright package directory and Chrome executable. Point `KFG_PLAYWRIGHT_ROOT` and `KFG_CHROME_EXECUTABLE` at the installations you intend to use. These variables are for the process you run the journeys from. The scripts have no browser download or discovery fallback.

~~~powershell
$env:KFG_PLAYWRIGHT_ROOT = "D:/Tools/browser-check/node_modules/playwright"
$env:KFG_CHROME_EXECUTABLE = "C:/Tools/Chrome/chrome.exe"
node test/journey.mjs
~~~

The existing targeted scripts are `test/review-journey.mjs`, `test/security-journey.mjs`, `test/github-journey.mjs`, `test/github-publication-journey.mjs` and `test/public-journey.mjs`. Use only local synthetic fixtures. A fixture's success marker does not establish live provider behavior, named assistant-client compatibility or public release. Report any timeout, incomplete capture or unconfirmed shutdown alongside the observed results. See [Compatibility](docs/COMPATIBILITY.md) for the recorded scope.

## Board interface

Module callers can use [openBoard(root)](src/board.ts) with the selected absolute local directory. Supply the board ID and expected saved version for edits, and close the Board when finished. The shared Board handles validation, persistence, recovery and export. The HTTP host authenticates browser requests, and the local browser session provides dedicated review and backup-only export actions.

Use the issue forms for ordinary bugs and feature requests where they are available. Provide versions and reproduction using synthetic data. See [Security](SECURITY.md) before sharing anything sensitive.

[Back to README](README.md)
