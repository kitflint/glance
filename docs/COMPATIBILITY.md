# Compatibility

| Area | Current evidence and limits |
| --- | --- |
| Platform | **v0.1.0 pre-release · Windows x64 only.** macOS and Linux aren't supported yet; Glance won't start there. Local qualification used Windows x64, writable local NTFS board directories and Node.js 24.22.1. Other filesystems and synchronized board directories are outside the verified scope. |
| Local visual board | Synthetic checks covered create, edit, reopen, review and local security. On 15 November 2026 all six browser journeys (core, public report, review, security, GitHub connection and GitHub publication) passed in one run at desktop and narrow widths. |
| Automated checks | TypeScript typecheck and all 159 cases in the 15-file serial suite passed in one run on 15 November 2026 with Node.js 24.22.1 on Windows x64. |
| Local MCP | Two actual assistant products completed a read and a guarded title update on a synthetic board on Windows: **Claude Desktop** 5.11492.5.0 (x64) and **Claude Code** 2.1.325. Each update committed exactly one revision, and the task stayed unreviewed. Earlier bundled Codex CLI attempts produced no verifiable Glance calls. Other clients have not been tested. See [Local MCP tools](MCP.md#tested-clients). |
| Public report export | The corrected package passed the local public-report browser journey, including desktop and narrow layout, keyboard navigation and exact HTML, Markdown and JSON downloads. |
| GitHub import | Live checks against a private test repository used the KitFlint Glance GitHub App, device sign-in and Windows Credential Manager. Issues imported with identity and freshness. Pull requests, a pull-request review, workflow runs and an empty releases scope were observed with commit identity. A pull request was not counted as an issue. A saved sign-in kept working about 12 and 20 hours after it was saved, beyond the access-token lifetime, which indicates automatic renewal. The renewal exchange itself was not observed; automated tests cover the renewal path. |
| GitHub issue publication | Live checks created one issue with its title only and later updated that issue's title through the reviewed preview. Each result was confirmed by readback, and a refresh reconciled the saved board. After the app authorization was revoked on GitHub, a refresh failed safely, asked for a new sign-in, did not retry and kept all board data. **Disconnect locally** confirmed credential cleanup and kept cached observations. |
| Source-package installation and release | The private source package passed a clean dependency install with Node.js 24.22.1 and npm 12.2.2. The public v0.1.0 release package, downloaded fresh, passed the same clean install, the full test suite and the browser journeys. Independent first-user setup remains unverified. See the [Quickstart](QUICKSTART.md). |

The development compiler is TypeScript 5.9.3 with Node types 24.10.1. Browser verification used Chrome 157.0.8103.51 and Playwright and playwright-core 1.62.1. See [Contributing](../CONTRIBUTING.md) for the existing commands and [Third-party notices](../THIRD-PARTY-NOTICES.md) for the dependency versions. The source archive does not bundle Node, Chrome or Playwright.

## Developer-operated first-use checks

The foreground `npm start` walkthrough used a disposable synthetic board. After an interrupted launch, a later run verified that a task edit and linked failed observation survived reopening, with the task still unreviewed. Its private download failed.

The follow-up used the private source package with reused, verified dependencies. The private JSON backup matched the saved board at revision 3. The downloaded local public JSON matched the preview’s SHA-256 and excluded private notes, evidence details and paths, and review history. A restore through the UI kept the board, task and evidence IDs in a fresh generation at revision 1. HTML and Markdown downloads were covered by the earlier browser journey.

Both follow-up hosts exited with code `0` after **Quit**. The identified hosts, listeners and nine observed Chrome processes were absent afterward. Process snapshots can miss short-lived descendants. A later removal check on 15 November 2026 followed [Remove Glance](QUICKSTART.md#remove-glance) on a disposable package copy. The app directory was removed, and no Glance process, service, scheduled task or current-user registry key remained. The [independent pilot](PILOT-FEEDBACK.md) remains pending.

## Local resource baseline

Measured on 14 November 2026 on one Windows x64 machine with 32 GiB RAM, using a synthetic 36-task board.

| Measurement | HTTP host | Local MCP process |
| --- | ---: | ---: |
| Startup | 1.654 s to HTTP 200 | 1.747 s to first overview |
| Maximum sampled working set | 73.8 MiB | 86.5 MiB |
| Maximum sampled private memory | 80.9 MiB | 96.8 MiB |
| CPU time over about 30 seconds idle | 31.25 ms | 15.625 ms |
| Normal exit | 29.4 ms after Quit | 35.5 ms after EOF |
| Listener refused a new connection | 32.8 ms after Quit | Stdio only |

Each app process had 31 samples. All six observed processes exited. Browser memory and OS-wide network activity were not measured. In the live checks, GitHub traffic happened only after an explicit refresh or publish action, and each host exited with code `0` after **Quit**. This baseline covers the tested workload and machine. Performance on low-memory PCs and at maximum board size remains unverified.

[Back to README](../README.md)
