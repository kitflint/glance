
import { createHash } from 'node:crypto';
import type { Report, Snapshot } from './board.ts';

const responseLimit = 16 * 1024 * 1024;
const scope = 'Private local snapshot — review before sharing';

export type ExportPackage = {
  boardId: string;
  version: string;
  exportedAt: string;
  html: string;
  markdown: string;
  backupJson: string;
  sha256: { html: string; markdown: string; backupJson: string };
};

export type CurrentBackup = { boardId: string; version: string; backupJson: string; sha256: string; snapshotSha256: string };

export type Recovery =
  | Readonly<{ available: false }>
  | Readonly<{ available: true; backupJson: string; sha256: string; sourceVersion: string }>;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function htmlText(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}

function markdownText(value: string): string {
  // Encode Markdown delimiters and bare-link punctuation as text, including at line boundaries.
  return value.replace(/[&<>\r\n\t\\`*_[\]{}()!#+\-.|~:]/g, (character) => '&#' + character.charCodeAt(0) + ';');
}

function evidenceUrl(value: string): string | undefined {
  if (value.length > 2048 || !/^https?:\/\//i.test(value) || /[\s\\]/u.test(value)) return undefined;
  try {
    const url = new URL(value);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname || url.username || url.password) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

function htmlLocation(value: string): string {
  const url = evidenceUrl(value);
  return url
    ? '<a rel="noreferrer noopener" href="' + htmlText(url) + '">' + htmlText(value) + '</a>'
    : htmlText(value || 'No location recorded');
}

function markdownLocation(value: string): string {
  const url = evidenceUrl(value);
  if (!url) return markdownText(value || 'No location recorded');
  const destination = url.replace(/[()<>]/g, (character) =>
    '%' + character.charCodeAt(0).toString(16).toUpperCase());
  return '[' + markdownText(value) + '](' + destination + ')';
}

function backup(snapshot: Snapshot, exportedAt: string): string {
  return JSON.stringify({ format: 'kitflint.glance.backup', version: 1, exportedAt, snapshot });
}

export function createRecovery(snapshot: Snapshot): Recovery {
  const backupJson = backup(snapshot, new Date().toISOString());
  return Object.freeze({
    available: true,
    backupJson,
    sha256: sha256(backupJson),
    sourceVersion: snapshot.generation + ':' + snapshot.revision,
  });
}

export function createCurrentBackup(snapshot: Snapshot, version: string): CurrentBackup | undefined {
  const backupJson = backup(snapshot, new Date().toISOString());
  const payload = { boardId: snapshot.boardId, version, backupJson,
    sha256: sha256(backupJson), snapshotSha256: sha256(JSON.stringify(snapshot)) };
  return Buffer.byteLength(JSON.stringify({ ok: true, ...payload }), 'utf8') <= responseLimit ? payload : undefined;
}

function summary(report: Report): string[] {
  return [
    'Tasks: ' + report.counts.tasks,
    'Open: ' + report.counts.open,
    'Accepted for stated scope: ' + report.acceptance.accepted,
    'Stale reviews: ' + report.acceptance.stale,
    'Changes requested: ' + report.acceptance.changesRequested,
    'Workflow in progress: ' + report.counts.inProgress,
    'Workflow blocked: ' + report.counts.blocked,
    'Workflow needs review: ' + report.counts.needsReview,
  ];
}

const reviewLabels = {
  accepted: 'Accepted for stated scope', stale: 'Stale review', 'changes-requested': 'Changes requested', unreviewed: 'Unreviewed',
};

function reviewLines(snapshot: Snapshot, taskId: string): string[] {
  if (snapshot.schemaVersion === 1) return [];
  return snapshot.reviews.filter((record) => record.taskId === taskId).flatMap((record) => {
    const label = reviewLabels[record.decision] + (record.generation === snapshot.generation ? '' : ' · Prior generation');
    const lines = [
      label + ' · ' + record.recordedAt + ' · ' + (record.reviewer || 'System invalidation'),
      'Scope: ' + record.scope, 'Note: ' + record.note,
      'Review: ' + record.id + ' · Generation: ' + record.generation + ' · Basis SHA-256: ' + record.basisSha256,
    ];
    if (record.previousReviewId) lines.push('Previous review: ' + record.previousReviewId);
    if (record.basis) {
      lines.push('Original reviewed subject: ' + record.basis.task.id, JSON.stringify(record.basis, null, 2));
    }
    return lines;
  });
}

function archiveLine(snapshot: Snapshot): string | undefined {
  const archive = snapshot.schemaVersion === 1 ? null : snapshot.reviewArchive;
  if (archive) return 'Earlier reviews are in the retained private archive for ' + archive.boardId +
    ' · ' + archive.generation + ':' + archive.revision + ' · ' + archive.reviewCount +
    ' review records · Normalized snapshot SHA-256: ' + archive.snapshotSha256;
}

function view(snapshot: Snapshot, report: Report) {
  const groupLabels = (groups: Snapshot['milestones'], counts: Report['milestones']) =>
    groups.map((group, index) => group.title + ' · ' + counts[index].openTasks + ' open / ' + counts[index].totalTasks);
  const groups = [...snapshot.milestones, ...snapshot.workstreams];
  const groupNames = new Map(groups.map((group) => [group.id, group.title]));
  const taskNames = new Map(snapshot.tasks.map((task) => [task.id, task.title]));
  const reviews = new Map(report.taskReviews.map(({ taskId, state }) => [taskId, reviewLabels[state]]));
  return {
    milestones: groupLabels(snapshot.milestones, report.milestones),
    workstreams: groupLabels(snapshot.workstreams, report.workstreams),
    focus: report.focusTaskId ? taskNames.get(report.focusTaskId)! : 'No focus task selected',
    groupName: (id: string | null) => id ? groupNames.get(id)! : 'Unassigned',
    taskName: (id: string) => taskNames.get(id)!,
    reviewState: (id: string) => reviews.get(id)!,
  };
}

function htmlList(items: string[]): string {
  return items.length ? '<ul>' + items.map((item) => '<li>' + item + '</li>').join('') + '</ul>' : '<p>None recorded.</p>';
}

const styles = [
  ':root{color-scheme:light;font:16px/1.55 system-ui,sans-serif;color:#171717;background:#fafafa}',
  'body{margin:0}header{background:#171717;color:#fff;padding:24px}main{max-width:1050px;margin:auto;padding:24px}',
  'section,article,details{background:#fff;border:1px solid #d4d4d4;border-radius:12px;padding:16px;margin:14px 0}',
  'h1,h2,h3,p{margin:.3em 0}.scope{color:#e5e5e5}.text{white-space:pre-wrap;overflow-wrap:anywhere}',
  '.focus{background:#fff7db;border-left:4px solid #805400}.pill{padding:.15em .5em;border-radius:6px;background:#dedede}',
  '.planned{background:#edf2f5;color:#455b69}.in-progress{background:#e6eefc;color:#1d4b80}.blocked{background:#fce9e5;color:#8c3026}',
  'summary{cursor:pointer}a{color:#262626}a:focus-visible,summary:focus-visible{outline:3px solid #171717;outline-offset:3px}',
].join('');

function htmlReport(snapshot: Snapshot, report: Report, version: string, exportedAt: string): string {
  const v = view(snapshot, report);
  const h = htmlText;
  const taskLinks = (ids: string[]) => htmlList(ids.map((id) =>
    '<a href="#' + h(id) + '">' + h(v.taskName(id)) + '</a>'));
  const evidenceLinks = (ids: string[]) => htmlList(ids.map((id) => '<a href="#' + h(id) + '">' + h(id) + '</a>'));
  const tasks = snapshot.tasks.map((task) => {
    const status = task.status.toLowerCase().replaceAll(' ', '-');
    const history = reviewLines(snapshot, task.id);
    return '<details id="' + h(task.id) + '"><summary>' + h(task.title) + ' <span class="pill ' + status + '">' +
      h(task.status) + '</span> · ' + h(v.reviewState(task.id)) + '</summary><p class="text">' + h(task.description) + '</p><p>' +
      h(task.id + ' · ' + task.priority + ' · Owner: ' + (task.owner || 'Unassigned')) + '</p><p>' +
      h('Milestone: ' + v.groupName(task.milestoneId) + ' · Workstream: ' + v.groupName(task.workstreamId)) + '</p>' +
      '<h3>Criteria</h3>' + htmlList(task.criteria.map((check) =>
        '<span class="text">' + h(check.requirement) + '</span> <small>' + h(check.id) + '</small>' + evidenceLinks(check.evidenceIds))) +
      '<h3>Blockers</h3>' + htmlList(task.blockers.map(h)) +
      '<h3>Prerequisites</h3>' + taskLinks(task.prerequisites) +
      '<h3>Evidence references</h3>' + evidenceLinks(task.evidenceIds) +
      (history.length ? '<details><summary>Review history</summary>' +
        history.map((line) => '<p class="text">' + h(line) + '</p>').join('') + '</details>' : '') + '</details>';
  }).join('');
  const evidence = snapshot.evidence.map((entry) =>
    '<article id="' + h(entry.id) + '"><h3>' + h(entry.title) + '</h3><p>' +
    h(entry.id + ' · ' + entry.scope + ' · ' + entry.outcome + ' · ' + entry.recordedAt) +
    '</p><p class="text">' + htmlLocation(entry.location) + '</p>' +
    (entry.supersedesId ? '<p>Supersedes <a href="#' + h(entry.supersedesId) + '">' + h(entry.supersedesId) + '</a></p>' : '') +
    '</article>').join('');
  const archive = archiveLine(snapshot);
  const csp = "default-src 'none'; style-src 'unsafe-inline'; connect-src 'none'; base-uri 'none'; form-action 'none'";
  return '<!doctype html>\n<html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta http-equiv="Content-Security-Policy" content="' + h(csp) + '">' +
    '<meta name="referrer" content="no-referrer"><title>' + h(snapshot.project.name) + ' · Glance</title>' +
    '<style>' + styles + '</style></head><body><header><p>KitFlint Glance</p><h1>' + h(snapshot.project.name) +
    '</h1><p class="scope">' + h(scope) + '</p></header><main><p>' +
    h('Revision ' + snapshot.revision + ' · ' + version + ' · Exported ' + exportedAt) +
    '</p><p>' + h('Updated ' + snapshot.updatedAt + ' · Stage ' + snapshot.project.stage) + '</p><p class="text">' +
    h(snapshot.project.goal) + '</p><section><h2>Overview</h2>' + htmlList(summary(report).map(h)) +
    (archive ? '<p>' + h(archive) + '</p>' : '') +
    '</section><section class="focus"><h2>Current focus</h2><p>' + h(v.focus) + '</p><h3>Next actions</h3>' +
    htmlList(report.nextActions.map(h)) + '</section><section><h2>Milestones</h2>' + htmlList(v.milestones.map(h)) +
    '<h2>Workstreams</h2>' + htmlList(v.workstreams.map(h)) + '</section><section><h2>Tasks</h2>' +
    (tasks || '<p>No tasks recorded.</p>') + '</section><section><h2>Evidence</h2>' +
    (evidence || '<p>No evidence recorded.</p>') + '</section></main></body></html>\n';
}

function markdownReport(snapshot: Snapshot, report: Report, version: string, exportedAt: string): string {
  const v = view(snapshot, report);
  const m = markdownText;
  const items = (values: string[]) => values.length ? values.map((item) => '- ' + m(item)) : ['- None recorded.'];
  const lines = [
    '# ' + m(snapshot.project.name), '', scope, '',
    'Revision ' + snapshot.revision + ' · ' + m(version) + ' · Exported ' + m(exportedAt),
    'Updated ' + m(snapshot.updatedAt) + ' · Stage ' + m(snapshot.project.stage), '', m(snapshot.project.goal),
    '', '## Overview', '', ...items(summary(report)),
    ...[archiveLine(snapshot)].flatMap((archive) => archive ? ['', m(archive)] : []),
    '', '## Current focus', '', m(v.focus),
    '', '### Next actions', '', ...items(report.nextActions), '', '## Milestones', '', ...items(v.milestones),
    '', '## Workstreams', '', ...items(v.workstreams), '', '## Tasks',
  ];
  if (snapshot.tasks.length === 0) lines.push('', 'No tasks recorded.');
  for (const task of snapshot.tasks) {
    lines.push('', '### ' + m(task.title), '',
      m(task.id + ' · ' + task.status + ' · ' + task.priority + ' · Owner: ' + (task.owner || 'Unassigned')),
      m(v.reviewState(task.id)),
      m('Milestone: ' + v.groupName(task.milestoneId) + ' · Workstream: ' + v.groupName(task.workstreamId)),
      '', m(task.description), '', 'Criteria',
      ...items(task.criteria.map((check) => check.id + ' · ' + check.requirement +
        (check.evidenceIds.length ? ' · Evidence: ' + check.evidenceIds.join(', ') : ''))),
      '', 'Blockers', ...items(task.blockers), '', 'Prerequisites',
      ...items(task.prerequisites.map((id) => v.taskName(id) + ' · ' + id)), '', 'Evidence references', ...items(task.evidenceIds));
    const history = reviewLines(snapshot, task.id);
    if (history.length) lines.push('', '#### Review history', '', ...items(history));
  }
  lines.push('', '## Evidence');
  if (snapshot.evidence.length === 0) lines.push('', 'No evidence recorded.');
  for (const entry of snapshot.evidence) {
    lines.push('', '### ' + m(entry.title), '',
      m(entry.id + ' · ' + entry.scope + ' · ' + entry.outcome + ' · ' + entry.recordedAt),
      '', 'Location: ' + markdownLocation(entry.location));
    if (entry.supersedesId) lines.push('Supersedes ' + m(entry.supersedesId));
  }
  return lines.join('\n') + '\n';
}

export function createExport(snapshot: Snapshot, report: Report, version: string): ExportPackage | undefined {
  const exportedAt = new Date().toISOString();
  const html = htmlReport(snapshot, report, version, exportedAt);
  const markdown = markdownReport(snapshot, report, version, exportedAt);
  const backupJson = backup(snapshot, exportedAt);
  const payload = {
    boardId: snapshot.boardId, version, exportedAt, html, markdown, backupJson,
    sha256: { html: sha256(html), markdown: sha256(markdown), backupJson: sha256(backupJson) },
  };
  // The host sends this same compact success envelope.
  return Buffer.byteLength(JSON.stringify({ ok: true, ...payload }), 'utf8') <= responseLimit ? payload : undefined;
}
