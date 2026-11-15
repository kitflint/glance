# Privacy

## Local board and sessions

Glance stores live board data in the directory you choose. It includes your project and task text, criteria, evidence references, review history and any cached GitHub data. Full private backups and private HTML or Markdown exports can contain confidential material. Keep board directories and exports away from shared or synchronized locations unless you intend that disclosure.

The visual board uses an authenticated loopback host. Keep the one-use launch link and the browser session private. A same-user process with direct disk or browser-session access can read or forge local data. Reviewer names and evidence references are user-entered data. Glance does not verify an identity or fetch external evidence automatically.

The local board has no ads, analytics, trackers, remote assets or KitFlint-hosted assistant calls. Following an external link is an explicit browser action.

## Assistant and GitHub access

An MCP client receives saved fields as entered. They may contain private paths, notes, SQL, identifiers or secrets. A connected assistant may transmit those fields to its own provider under that client's settings. Grant read or write access explicitly in the client and choose a board you are willing to disclose. A separate public report gives you a narrower sharing option. See [Local MCP tools](MCP.md).

With a configured GitHub App, explicit sign-in, selection, refresh, publication and inspection operations can contact GitHub. The publication preview shows the intended destination and selected fields. A title or description can disclose private material even when you exclude other board fields. Review repository visibility and the exact values before confirming. The optional connector uses Windows Credential Manager for credentials. Local disconnect and remote access revocation are separate actions. See [GitHub connection](GITHUB.md).

## Public report

The public formats contain the declared project stage, snapshot dates and revision, task priorities and states, review states, counts, focus, group membership and prerequisites. They use public ordinal IDs and generic labels by default. You can supply public labels or explicitly load current names for review. Check labels and relationships for details that reveal confidential work.

The public report excludes private notes and descriptions, evidence and criterion contents and paths, blocker contents, reviewer identities and review history, GitHub connection data, cached GitHub observations and publication history. Counts and relationships can still reveal information. The report represents recorded local acceptance and the declared project stage. It does not validate proof or announce a release. Preview and confirm the exact snapshot and check the files before sharing. Downloading does not upload anything.

[Back to README](../README.md)
