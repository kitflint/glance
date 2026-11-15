# Backup and recovery

## Record human review

Open a task and choose **Review task**. Check the displayed saved revision, criteria, linked evidence, blockers and prerequisites. Enter a reviewer name, scope and note. Choose **Accept this scope** or **Request changes**, and confirm that you reviewed the displayed criteria and evidence.

Acceptance requires at least one criterion, no blockers, accepted prerequisites and current passed evidence linked explicitly to each criterion. Task-level evidence alone is insufficient. Glance shows evidence locations without opening or verifying them. The reviewer name and scope are local assertions. Glance cannot verify the reviewer's identity or that the reviewer read an external file. Only the local review form records human acceptance. A recorded review grants no public release, deployment, spending or execution authority.

Relevant changes to a task, its criteria or evidence, the project goal, group titles or prerequisite acceptance can make earlier acceptance stale. History retains the original reviewed subject. Workflow status is counted separately. If the review response is lost, read the saved history and compare it with your draft. A matching saved record does not establish who submitted it. Close the form and reopen it at the fresh revision before confirming again.

## Export and restore

Use **Prepare export** for a private package from the displayed saved revision. HTML, Markdown and the full private JSON backup share one revision and export time. Each download uses that package even if the live board advances. Keep the full JSON in a private backup location.

Use **Public report** for a shareable snapshot. Choose **Prepare public preview**, inspect the contents and file hashes, then confirm the exact snapshot. Confirmation and each download check the saved revision again. A label or revision change clears the prepared package. Public HTML is a standalone dashboard, Markdown is a text report, and public JSON is a data export. Downloads stay local. Use the full private JSON for restoration. See [Privacy](PRIVACY.md) for the public fields and exclusions.

If recovery mode offers **Download recovery backup**, save the validated previous revision. It may omit later changes. If no predecessor is available, use a previously saved full backup. Preserve the original directory, including `glance.sqlite` and any journal sidecars. Quit and confirm exit before starting Glance against a new empty directory. Do not repair a damaged board by deleting, swapping or editing its SQLite files in place.

| Import as | Identity and history |
| --- | --- |
| **Restore original board identity** | Keeps board and record IDs, historical evidence and reviews. Creates a new generation starting at revision 1. |
| **New board** | Creates a new board ID and remaps local record IDs and references. Carried reviews keep their original reviewed subject. |
| **Continue review cycle** | Keeps board and record IDs, starts a new generation with zero reviews and links to the retained predecessor backup. Requires a full backup with review history and explicit confirmation that you kept it and the original directory. |

Restored and copied reviews are historical and require fresh confirmation. GitHub observations are retained as historical data, and a prior connection does not carry forward as active. Reconnect explicitly when the live connection is available. Schema 4 publication records remain historical context about earlier attempts. An older backup or independent copy cannot account for activity after its snapshot.

If an initialization, save, review or publication response is lost, inspect saved state before sending another command. Keep the original files and follow the relevant recovery or inspection flow when the latest state cannot be confirmed.

## Continue a review cycle

A cycle can hold up to 2,000 review records within the 2 MiB normalized snapshot limit. Writes that exceed either limit are refused without pruning review history.

1. Stop the assistant and MCP writers connected to the old board.
2. In **Review**, choose **Download review archive** at the displayed revision and keep the full private JSON. This download works independently of the combined HTML and Markdown export. Quit, confirm exit and retain the old directory.
3. Start Glance in a new empty directory. Import the full backup with **Continue review cycle** and confirm retention.
4. Before directing assistants to the new directory, verify task and evidence IDs, zero current review records and the linked archive descriptor. Keep every predecessor backup in the chain. Glance leaves old directories and client settings under your control.

The descriptor names the preceding board, generation, revision and review count. Its normalized snapshot digest differs from the raw JSON backup-file digest. The review archive download displays both. The normalized digest is SHA-256 over the UTF-8 compact JSON of the normalized snapshot, beginning with `schemaVersion`, `boardId`, `generation`, `revision`, `updatedAt`, `project`, `milestones`, `workstreams`, `tasks` and `evidence`. Schema 2 and later add `reviews` and `reviewArchive`. Schema 3 adds `github`, and schema 4 adds `publication`. Use the normalized key order and saved array order in the full backup, including reference sets sorted by ID. Compare the descriptor to the normalized snapshot digest from the predecessor's full backup. The digest identifies the data and does not authenticate an external archive or prove it was kept. If existing work and one review still exceed the byte cap in a fresh cycle, split the board into smaller project scopes.

## Schema and size compatibility

A snapshot schema and the outer private backup format are distinct. Full private JSON uses `kitflint.glance.backup` version 1 and can contain a valid schema 1, 2, 3 or 4 snapshot. New blank boards start with human-review support in schema 2.

| Snapshot schema | Read and import behavior |
| --- | --- |
| 1 | Existing valid boards keep their shape in reads and backups. A no-op edit leaves schema 1 in place. The first actual edit or review and ordinary New board or Restore imports add the schema 2 review fields. Continue review cycle needs a backup with review history. |
| 2 | Preserves review records and the predecessor descriptor where applicable. Import applies the identity and review rules above. |
| 3 | Adds saved GitHub mappings, observations and collection metadata. Import retains them and resets the active connection. |
| 4 | Adds publication records, compact creation links and the latest publication archive marker. Import preserves those records and resets the active connection. |

Glance refuses an oversized write without removing existing history. If an import or schema upgrade exceeds the snapshot limit, retain the original backup and reduce editable content in the original board before exporting again. A valid schema 1 board remains readable and exportable when an upgrade is refused. The browser import chooser has a separate 3 MiB file limit.

## Publication history and capacity

Schema 4 limits active publication records to 20 and compact creation links to 100, subject to a 512 KiB cap for the GitHub and publication data together and the shared 2 MiB snapshot cap. The limits include reserved space for publication outcomes. An unresolved attempt or merge dependency can prevent archival. Inspect or refresh the affected issue as required before archiving. A create with a known issue identity retains a compact link after archival. The link uses capacity and supports later reconciliation. It does not replace the full record.

From **Archive selected publication records**, download the full backup using **Download publication backup** and save it privately. The preview is tied to the saved version. Confirm that you saved the backup and confirm the selected records. The board keeps the latest archive marker with the board, generation, revision, record IDs and backup digest. Keep each archive backup yourself for earlier history. Archiving cannot make an unknown send safe to repeat. See [GitHub connection](GITHUB.md#resolve-an-uncertain-result).

## Uninstall and retain your data

If optional GitHub access was configured, use **Disconnect locally** while the app is available and check its credential cleanup result. Revoke the remote grant or review the App installation separately on GitHub. Quit the host, confirm exit and stop the MCP processes you launched through your clients. Choose which board directories and private backups to retain. Remove only the application directory you selected for installation. Client configuration and retained board directories are under your control.

[Back to README](../README.md)
