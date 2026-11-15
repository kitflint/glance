# Local MCP tools

A compatible local MCP client can start a stdio connection against a saved board. The connection exposes board data to the client you choose and may expose it to that client's assistant provider. Use a board you are willing to share and grant access explicitly in your client. Glance leaves client settings and permissions under your control. See [Privacy](PRIVACY.md) and [Compatibility](COMPATIBILITY.md) before connecting.

## Start a read-only connection

After the dependencies are available, use Node **24.22.1** directly. Put your own absolute executable, script and board paths in the client's command and arguments fields. This is an example command shape for a local stdio client. Each client supplies its own settings format.

~~~json
{
  "command": "C:/Tools/node/node.exe",
  "args": [
    "D:/Apps/kitflint-glance/src/mcp-main.ts",
    "--root",
    "D:/Boards/MyProject"
  ]
}
~~~

From the app directory a developer can also start it with `npm run mcp -- --root "D:/Boards/MyProject"`. The direct executable form keeps npm's script banner out of a client connection. The server uses `stdout` for MCP protocol messages and has no network listener. The default connection uses the restricted reader and performs no repair or file changes.

## Tested clients

These clients completed a read and a guarded title update on Windows x64 with a synthetic board. Use your own absolute paths.

| Client | Tested version | Where to add the server |
| --- | --- | --- |
| Claude Desktop | 5.11492.5.0 (x64) | **Settings** → **Developer** → **Edit Config**, add the server under `mcpServers`, then restart Claude Desktop. Approve each tool call when asked. |
| Claude Code | 2.1.325 | Run `claude mcp add glance -- "C:/Tools/node/node.exe" "D:/Apps/kitflint-glance/src/mcp-main.ts" --root "D:/Boards/MyProject"`, or pass a JSON file with `--mcp-config`. Allow the Glance tools when prompted, or list them with `--allowedTools`. |

Ask the assistant to call `glance_list_tasks` before reading or editing a task, so that it can find the task ID. Other MCP clients that support local stdio servers may work but have not been tested.

## Seven read tools

| Tool | Saved data returned |
| --- | --- |
| `glance_read_overview` | Project, progress, milestones and workstreams |
| `glance_list_tasks` | Task summaries and review states in saved order |
| `glance_read_task` | One full task with current review state and latest review metadata |
| `glance_list_evidence` | Evidence in saved order, including failed and superseded entries |
| `glance_github_overview` | Cached repository, collection scopes and times, counts and publication summary |
| `glance_github_list` | Paged cached issue mappings or GitHub facts |
| `glance_github_task` | Saved issue mapping, local values, pending fields and cached publication information for one task |

Start lists at offset zero. Use the returned version as `expectedVersion` for subsequent pages and task details. `glance_read_task` takes `id`, and `glance_github_task` takes `taskId`. The GitHub list takes `kind` (`mappings` or `facts`), `offset` and `limit`. A revision conflict means the saved board advanced. Start paging again at offset zero. If a writer is busy, wait for it to finish and make a new explicit read. If a result exceeds the MCP limit, request a smaller page or use the local board or an export.

GitHub reads use only saved data in either MCP mode. The tools do not sign in, select a repository, refresh, publish, disconnect, open evidence locations or verify them. The GitHub controls are in the local visual board.

## Opt in to an eighth tool

Only add the exact final argument `--allow-writes` when you intend to grant local write access. A direct PowerShell example is:

~~~powershell
& "C:/Tools/node/node.exe" "D:/Apps/kitflint-glance/src/mcp-main.ts" --root "D:/Boards/MyProject" --allow-writes
~~~

The equivalent developer command is `npm run mcp -- --root "D:/Boards/MyProject" --allow-writes`. Write mode opens the existing board in writable mode for both reads and updates. Even a read in that mode can apply SQLite rollback-journal recovery or writable configuration.

`glance_update_board` takes `boardId`, `expectedVersion` and one operation. It can edit the project, add or edit milestones, workstreams, tasks and criteria, and append evidence. It cannot initialize, import, recover, restore, export or delete a board, record human acceptance, verify evidence, execute commands or mutate GitHub. The response includes the saved board ID, version and timestamp, whether the change committed and any created IDs. A valid no-op retains the saved version.

On a version conflict, read the saved board and decide whether the change still applies. After a lost response, unknown outcome or disconnect, read and compare the saved board before issuing another update. The adapter never retries or replays a change. Cancelling a pending request closes the connection and cannot undo a committed change. Wait for the previous process to exit before starting another connection. The adapter does not reconnect automatically, and forced Windows termination can exit without application cleanup.

[Back to README](../README.md)
