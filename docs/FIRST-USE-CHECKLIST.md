# First-use checklist

Use a disposable board with synthetic data. Record your own observations below. Developer-operated checks covered save, reopen, private backup, local public JSON export, restore, **Quit** and removal. To remove Glance afterwards, follow [Remove Glance](QUICKSTART.md#remove-glance). Use the [pilot feedback worksheet](PILOT-FEEDBACK.md) for three separate sessions with independent participants.

1. Record which private source package you used and the Windows, Node and npm versions. The tested setup used the corrected package on Windows x64 with Node.js 24.22.1 and npm 12.2.2. Follow the [Quickstart](QUICKSTART.md) in a freshly extracted directory.
2. Open the private launch link. Create a blank board or try the editable sample. Add or edit a synthetic task, choose a workflow status and select **Save changes**. Use **Quit**, confirm the foreground process exits, then reopen the same directory and check the saved edit.
3. In **Evidence**, choose **Add evidence** and record a synthetic failed observation, such as “Example check failed.” Leave its location blank. In the task editor, select it under **Evidence references**, save, and find it again in the task details. Check that the task’s workflow status is separate from human acceptance and that the failed observation remains visible.
4. Use **Prepare export** to save the full private JSON backup. Quit and confirm exit. Start Glance with a separate, empty local directory. Under **Import a JSON backup**, choose **Restore original board identity** and verify the saved task and failed evidence. Keep the original directory and backup.
5. Choose **Public report**, then **Prepare public preview**. Check the labels and relationships for information you would keep private. Check that private notes, evidence locations and review history are excluded. Confirm and download the snapshot only if you intend to keep a shareable copy. See [Privacy](PRIVACY.md).
6. Choose **Quit** and confirm the foreground process exits. If you choose to uninstall, stop any MCP processes you started, choose which board directories and backups to keep, and remove only your selected application directory. See [Backup and recovery](BACKUP-RECOVERY.md#uninstall-and-retain-your-data).

| Step | Observed result | Issue |
| --- | --- | --- |
| Setup and first launch | | |
| Save, reopen and find failed evidence | | |
| Private backup and restore | | |
| Public preview and Quit | | |
| Optional uninstall and data retention | | |

**Optional MCP.** Use [Local MCP tools](MCP.md) only if you choose to connect a client to your synthetic board. Claude Desktop and Claude Code have been tested. Other clients have not.

**Optional GitHub.** Use a test repository you own. Sign in through **GitHub** on the board, then follow [GitHub connection](GITHUB.md). Publishing sends only the fields you confirm.

[Back to README](../README.md)
