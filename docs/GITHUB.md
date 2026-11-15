# GitHub connection

The visual board works without GitHub. GitHub is optional. This build connects through the public **KitFlint Glance** GitHub App (client ID `Iv23liuI4FeOYhylCCjd`). The client ID is a public identifier, and the app has no client secret. The App requests Issues read and write, plus read-only access to pull requests, Actions, contents and metadata, for the repositories you choose. See [Compatibility](COMPATIBILITY.md) for the live checks and their limits.

## Connect and import

On Windows x64, install or request access to the GitHub App for the intended account and repository. The board can open GitHub's repository creation page if you need a repository. Create it on GitHub, then include it in the App installation. From **GitHub**, choose **Sign in**, open the device authorization page and enter the displayed code on GitHub. If installation or organization approval is pending, use **Check again** once access is granted. Sign in again after authorization expires. Confirm the exact repository and its visibility in Glance.

Choose **Refresh selected scope** for the category and page range you need, up to three pages at a time. For issues, select up to ten from the preview and choose **Import selected issues** before it expires. The imported issues become editable local tasks. Glance keeps the issue identity, mapping, observation scope and fetch time. PR, review and workflow facts are observations and may be incomplete or stale. A refresh can bring in a remote value when the corresponding local field is unchanged. When both sides changed, compare the two values and choose which to keep. GitHub issue state, local task status and human acceptance remain independent.

Manage cached observations to clear selected categories. Clearing pull requests also clears their cached review observations. Save a full private backup first if you want to retain them. Schema 3 backups retain issue mappings, observations and human-review history. Schema 4 also retains publication history. Restore, copy and review-cycle continuation preserve historical GitHub data and require explicit reconnection. Public reports omit GitHub-specific connection data, observations and publication history. Review any labels you choose to share.

**Disconnect locally** keeps the cached observations and local work and reports the status of local credential cleanup. Linked issues are then shown as historical. To revoke access on GitHub, open your GitHub settings, choose **Applications**, then **Authorized GitHub Apps**, and revoke **KitFlint Glance**. After a revocation, the next refresh shows **GitHub did not renew this sign-in** and keeps your board unchanged. If the saved sign-in itself has expired, Glance shows **The sign-in expired. Sign in again.** instead. Choose **Sign in** again to reconnect. The connector uses Windows Credential Manager through the pinned 2.1.2 wrapper and Windows x64 binding, loaded on demand. See the [notices](../THIRD-PARTY-NOTICES.md).

## Publish selected issue fields

1. In **Review GitHub changes**, choose one to three saved tasks. A new task creates an open issue with its title. Description starts unchecked. For a linked task, select only the changed title, description or local issue state you intend to send.
2. Choose **Review selected GitHub changes**. Check the repository, visibility, issue identity and exact before/send values. Task titles and descriptions can contain private material. For a create, inspect GitHub for an existing issue and confirm that check. A separate copy or older backup cannot account for later attempts.
3. Confirm the displayed fields and choose **Publish confirmed changes**. This build requires App Issues write access and repository push permission. Glance rechecks the destination and existing issue values and sends one request at a time under a bounded operation budget. It can stop at a rate limit or uncertain result.
4. Read the result for each task. A confirmed result reflects readback of the selected values at that time. GitHub and the board do not share an atomic transaction, so a concurrent GitHub edit can still occur after preflight. A cancelled or interrupted send may already have reached GitHub. Later local edits remain pending.

## Resolve an uncertain result

When a create result is unknown, inspect the repository before taking any new action. Use **Inspect GitHub issue**, enter the issue number and confirm the observed issue to link it to the task. A confirmed inspection keeps the original result in history and does not send the earlier request again. It records the issue you chose and cannot establish whether the original request created it. For a linked issue, explicitly refresh after a confirmed update or matching inspection to reconcile the current values.

Use the publication archive controls only for eligible records. Download and keep the version-bound full private backup before confirming archival. Compact links preserve known created issue identities. See [Publication history and capacity](BACKUP-RECOVERY.md#publication-history-and-capacity).

GitHub operations require explicit actions in the visual board. Glance does not run unattended sync, publish from MCP, commit, merge or deploy. Live checks covered a private test repository owned by an organization. Other account types, organization approval policies and large repositories have not been tested.

[Back to README](../README.md)
