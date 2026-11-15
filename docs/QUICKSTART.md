# Quickstart

Use Windows x64, Node.js **24.22.1**, npm **12.2.2**, and a writable directory on a local NTFS volume outside synchronization folders. Choose one separate empty directory for each new board or restore. Replace the example paths with absolute paths you control.

## Prepare the source directory

In the source-package layout, the directory you enter contains `package.json`, `package-lock.json`, `src/`, `web/`, `test/`, `docs/`, `LICENSE` and `THIRD-PARTY-NOTICES.md`. Node, browsers and installed dependencies are external to that archive. Keep the app directory separate from the directory that holds the board.

Open an interactive terminal in your freshly unpacked source directory. Check that your terminal selects the tested Node and npm versions before installing dependencies.

~~~powershell
node --version
npm --version
~~~

Use the tools that report `v24.22.1` and `12.2.2`. For a clean install from the corrected source package, run this command in the fresh directory.

~~~powershell
npm ci --ignore-scripts --no-audit --no-fund --strict-ssl=true --engine-strict=true --registry=https://registry.npmjs.org --fetch-retries=0 --fetch-timeout=30000 --update-notifier=false
~~~

This command uses the package lockfile and can replace an existing `node_modules` directory. The corrected private package passed dependency installation in a fresh extracted directory with the tested tool pair, empty per-run npm configuration files and a fresh cache. See [Compatibility](COMPATIBILITY.md) and the [npm ci documentation](https://docs.npmjs.com/cli/v11/commands/npm-ci/).

The clean-install check invoked npm’s CLI with process-scoped `--use-system-ca` to use certificates trusted by Windows. When that trust is needed, use the `npm-cli.js` from your selected npm 12.2.2 installation. Replace the example executable paths with yours.

~~~powershell
& "C:/Tools/node/node.exe" --use-system-ca "C:/Tools/node/node_modules/npm/bin/npm-cli.js" ci --ignore-scripts --no-audit --no-fund --strict-ssl=true --engine-strict=true --registry=https://registry.npmjs.org --fetch-retries=0 --fetch-timeout=30000 --update-notifier=false
~~~

Keep strict certificate verification enabled. Leave global Node, npm and Windows trust settings alone. [Node CLI documentation](https://nodejs.org/docs/latest-v24.x/api/cli.html#--use-system-ca)

## Open a board

Developer-operated checks ran the foreground `npm start` workflow on a synthetic board with reused, verified dependencies. They covered saving and reopening, private backup, local public JSON export, restoring into a separate directory and exiting through **Quit**. Use the [first-use checklist](FIRST-USE-CHECKLIST.md) to record your own results. Independent first-user setup and a fresh public package download remain unverified.

1. In the app directory, start the foreground process with your absolute board path.

   ~~~powershell
   npm start -- --root "D:/Boards/MyProject"
   ~~~

2. Open the printed link manually within two minutes. The full link contains a one-use launch code. Keep it private and out of logs, chats and issue reports. Piped output gives only the origin, and Glance does not launch a browser for you.
3. Choose **Create sample board** to explore synthetic tasks or enter a project name and choose **Create blank board**. For an existing private backup, see [Backup and recovery](BACKUP-RECOVERY.md).
4. Add or edit a task and choose **Save changes**. Inspect the saved revision, task details, evidence and next actions on the dashboard. If another edit advanced the board, compare the draft and saved values, then reload or reapply deliberately. For an unknown save outcome, use **Compare with saved board** before sending another change.
5. Choose **Prepare export** and save the full private JSON backup. For a shareable copy, use **Public report**, inspect the preview and confirm the exact snapshot before downloading. See [Export and restore](BACKUP-RECOVERY.md#export-and-restore).
6. Choose **Quit** and confirm that the foreground process exits. Ctrl+C in that terminal also requests shutdown. Closing the tab alone does not establish that the host exited. To reopen, start against the same board directory and open its new launch link.

Reload the original tab to reuse its local session. If that tab or the initial exchange is lost, stop the host, confirm exit and start a new one. Glance stores its live board in `glance.sqlite` and manages the named SQLite sidecars in the selected board directory.

## Remove Glance

1. Choose **Quit** in each open board and confirm that the foreground process exits.
2. If a board was connected to GitHub, open it once more and choose **Disconnect locally**, then **Quit**. This removes that board's saved sign-in from Windows Credential Manager. To remove GitHub access entirely, revoke **KitFlint Glance** under **Authorized GitHub Apps** in your GitHub settings.
3. Delete the app directory, including `node_modules`. Glance installs no service, scheduled task or registry entry.
4. Your boards are separate directories. Keep them, back them up, or delete them yourself.

[Back to README](../README.md)
