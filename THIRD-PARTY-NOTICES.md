# Third-party notices

KitFlint Glance source and documentation use the [MIT License](LICENSE). Copyright (c) 2026 jopark81 and KitFlint Glance contributors. Third-party components retain their own terms.

The local board and offline report use first-party HTML, CSS and JavaScript with platform fonts. The source archive includes the npm lockfile and does not include installed dependencies, a Node runtime or browser binaries. An npm installation retains package license and notice files distributed by the packages. Preserve those files with any redistribution.

## Windows x64 dependency records

These 19 lockfile records describe the dependency set selected for Windows x64.

| Package | Version | Role | Declared license |
| --- | --- | --- | --- |
| @modelcontextprotocol/client | 2.4.0 | MCP library-client test | Apache-2.0 |
| @modelcontextprotocol/core | 2.4.0 | MCP runtime transitive | Apache-2.0 |
| @modelcontextprotocol/server | 2.4.0 | MCP runtime | Apache-2.0 |
| @napi-rs/keyring | 2.1.2 | GitHub credential wrapper | MIT |
| @napi-rs/keyring-win32-x64-msvc | 2.1.2 | Optional Windows x64 native credential binding | MIT with bundled third-party notices |
| @types/node | 24.10.1 | Development type definitions | MIT |
| cross-spawn | 7.0.6 | MCP test transitive | MIT |
| eventsource | 3.0.7 | MCP test transitive | MIT |
| eventsource-parser | 3.1.1 | MCP test transitive | MIT |
| isexe | 2.0.0 | MCP test transitive | ISC |
| jose | 6.2.17 | MCP test transitive | MIT |
| path-key | 3.1.1 | MCP test transitive | MIT |
| pkce-challenge | 5.0.1 | MCP test transitive | MIT |
| shebang-command | 2.0.0 | MCP test transitive | MIT |
| shebang-regex | 3.0.0 | MCP test transitive | MIT |
| typescript | 5.9.3 | Development compiler | Apache-2.0 |
| undici-types | 7.16.0 | Transitive dependency of @types/node | MIT |
| which | 2.0.2 | MCP test transitive | ISC |
| zod | 4.6.7 | MCP runtime | MIT |

Keep the keyring wrapper's `LICENSE` with any redistribution of the wrapper and the native Windows package's complete `LICENSE.third-party.md` with any redistribution of that package. Retain the TypeScript license and bundled third-party notices, Microsoft's copyright and license notices for @types/node, and the copyright and license for Matteo Collina and Undici contributors for undici-types. Preserve applicable upstream Apache-2.0 LICENSE and NOTICE files and MIT and ISC copyright and license texts.


## Additional optional platform records

The keyring wrapper also declares the following 11 optional packages. The lockfile records their metadata. This package supports Windows x64. These additional platform binaries were not installed or redistributed for this source package.

| Package | Version | Declared license |
| --- | --- | --- |
| @napi-rs/keyring-darwin-arm64 | 2.1.2 | MIT |
| @napi-rs/keyring-darwin-x64 | 2.1.2 | MIT |
| @napi-rs/keyring-freebsd-x64 | 2.1.2 | MIT |
| @napi-rs/keyring-linux-arm-gnueabihf | 2.1.2 | MIT |
| @napi-rs/keyring-linux-arm64-gnu | 2.1.2 | MIT |
| @napi-rs/keyring-linux-arm64-musl | 2.1.2 | MIT |
| @napi-rs/keyring-linux-riscv64-gnu | 2.1.2 | MIT |
| @napi-rs/keyring-linux-x64-gnu | 2.1.2 | MIT |
| @napi-rs/keyring-linux-x64-musl | 2.1.2 | MIT |
| @napi-rs/keyring-win32-arm64-msvc | 2.1.2 | MIT |
| @napi-rs/keyring-win32-ia32-msvc | 2.1.2 | MIT |

## External tools

| Component | Use and redistribution |
| --- | --- |
| Node.js 24.22.1 and bundled SQLite | External app runtime. Retain the full upstream license and bundled third-party notices, including SQLite notices, if redistributing Node. |
| Python 3.12 and its standard library | External project report tools. Retain the complete upstream license and bundled notices if redistributing Python. |
| Playwright and playwright-core 1.62.1 | Separately installed browser verification tools. Apache-2.0. Retain upstream licenses, NOTICE files and third-party notices if redistributed. The macOS-only optional fsevents dependency was outside the inspected Windows installation. |
| Google Chrome | Separately installed verification browser. Redistribution requires a separate review. |

Clean installation and inspection of the actual distributed license and notice files remain separate release checks.
