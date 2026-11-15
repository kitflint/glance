import { createHash } from 'node:crypto';

const stages = ['Plan', 'Build', 'Verify', 'Release'] as const;
const priorities = ['P0', 'P1', 'P2'] as const;
const statuses = ['Planned', 'In progress', 'Needs review', 'Blocked'] as const;
const reviews = ['accepted', 'stale', 'changes-requested', 'unreviewed'] as const;
const responseLimit = 16 * 1024 * 1024;

type Group = { id: string; label: string; total: number; accepted: number };
type Task = {
  id: string;
  label: string;
  priority: typeof priorities[number];
  status: typeof statuses[number];
  review: typeof reviews[number];
  milestoneId: string | null;
  workstreamId: string | null;
  prerequisites: string[];
  criterionCount: number;
  evidenceCount: number;
  blockerCount: number;
};
type Counts = {
  tasks: number;
  open: number;
  accepted: number;
  inProgress: number;
  blocked: number;
  needsReview: number;
  stale: number;
  changesRequested: number;
};

export type PublicReport = {
  format: 'kitflint.glance.public.v1';
  project: { label: string; stage: typeof stages[number] };
  captured: { revision: number; updatedAt: string; preparedAt: string };
  counts: Counts;
  focusTaskId: string | null;
  milestones: Group[];
  workstreams: Group[];
  tasks: Task[];
};

export type PublicExportFiles = {
  report: PublicReport;
  html: string;
  markdown: string;
  publicJson: string;
  sha256: { html: string; markdown: string; publicJson: string };
};

function requireValue(condition: unknown): asserts condition {
  if (!condition) throw new TypeError('Invalid public report.');
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  requireValue(value !== null && typeof value === 'object');
  const prototype: unknown = Object.getPrototypeOf(value);
  requireValue(prototype === null || prototype === Object.prototype);
  requireValue(Reflect.ownKeys(value).length === keys.length);
  const entries = keys.map((key) => {
    const property = Object.getOwnPropertyDescriptor(value, key);
    requireValue(property && 'value' in property);
    return [key, property.value];
  });
  return Object.fromEntries(entries);
}

function array<T>(value: unknown, max: number, parse: (item: unknown, index: number) => T): T[] {
  requireValue(Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype && value.length <= max);
  requireValue(Reflect.ownKeys(value).length === value.length + 1);
  return Array.from({ length: value.length }, (_, index) => {
    const property = Object.getOwnPropertyDescriptor(value, index);
    requireValue(property && 'value' in property);
    return parse(property.value, index);
  });
}

function integer(value: unknown, min: number, max: number): number {
  requireValue(typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max);
  return value;
}

function label(value: unknown): string {
  requireValue(typeof value === 'string' && value.length >= 1 && value.length <= 200 && !/[\x00-\x1f\x7f-\x9f]/.test(value));
  return value;
}

function option<T extends string>(value: unknown, options: readonly T[]): T {
  const match = options.find((candidate) => candidate === value);
  requireValue(match !== undefined);
  return match;
}

function timestamp(value: unknown): string {
  requireValue(typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value));
  const date = new Date(value);
  requireValue(Number.isFinite(date.valueOf()) && date.toISOString() === value);
  return value;
}

function reference(value: unknown, ids: Set<string>): string {
  requireValue(typeof value === 'string' && ids.has(value));
  return value;
}

function optionalReference(value: unknown, ids: Set<string>): string | null {
  return value === null ? null : reference(value, ids);
}

function groups(value: unknown, prefix: string): Group[] {
  return array(value, 100, (entry, index) => {
    const fields = record(entry, ['id', 'label', 'total', 'accepted']);
    const id = prefix + (index + 1);
    requireValue(fields.id === id);
    const total = integer(fields.total, 0, 1000);
    return { id, label: label(fields.label), total, accepted: integer(fields.accepted, 0, total) };
  });
}

function verifyRelationships(report: PublicReport) {
  const { counts, milestones, workstreams, tasks } = report;
  const accepted = tasks.filter((task) => task.review === 'accepted').length;
  const expected: Counts = {
    tasks: tasks.length,
    open: tasks.length - accepted,
    accepted,
    inProgress: tasks.filter((task) => task.status === 'In progress').length,
    blocked: tasks.filter((task) => task.status === 'Blocked').length,
    needsReview: tasks.filter((task) => task.status === 'Needs review').length,
    stale: tasks.filter((task) => task.review === 'stale').length,
    changesRequested: tasks.filter((task) => task.review === 'changes-requested').length,
  };
  for (const key of Object.keys(expected) as (keyof Counts)[]) requireValue(counts[key] === expected[key]);
  for (const [axis, key] of [[milestones, 'milestoneId'], [workstreams, 'workstreamId']] as const) {
    for (const group of axis) {
      const members = tasks.filter((task) => task[key] === group.id);
      requireValue(group.total === members.length && group.accepted === members.filter((task) => task.review === 'accepted').length);
    }
  }
  const pending = new Map(tasks.map((task) => [task.id, task.prerequisites.length]));
  const dependents = new Map<string, string[]>();
  let edges = 0;
  for (const task of tasks) {
    edges += task.prerequisites.length;
    requireValue(edges <= 10000);
    for (const id of task.prerequisites) {
      const next = dependents.get(id);
      if (next) next.push(task.id);
      else dependents.set(id, [task.id]);
    }
  }
  const ready = tasks.filter((task) => task.prerequisites.length === 0).map((task) => task.id);
  for (let index = 0; index < ready.length; index++) {
    for (const id of dependents.get(ready[index]) ?? []) {
      const remaining = pending.get(id)! - 1;
      pending.set(id, remaining);
      if (remaining === 0) ready.push(id);
    }
  }
  requireValue(ready.length === tasks.length);
}

function validate(value: unknown): PublicReport {
  const fields = record(value, ['format', 'project', 'captured', 'counts', 'focusTaskId', 'milestones', 'workstreams', 'tasks']);
  requireValue(fields.format === 'kitflint.glance.public.v1');
  const project = record(fields.project, ['label', 'stage']);
  const captured = record(fields.captured, ['revision', 'updatedAt', 'preparedAt']);
  const counts = record(fields.counts, ['tasks', 'open', 'accepted', 'inProgress', 'blocked', 'needsReview', 'stale', 'changesRequested']);
  const milestones = groups(fields.milestones, 'm');
  const workstreams = groups(fields.workstreams, 'w');
  const milestoneIds = new Set(milestones.map((group) => group.id));
  const workstreamIds = new Set(workstreams.map((group) => group.id));
  requireValue(Array.isArray(fields.tasks) && fields.tasks.length <= 1000);
  const taskIds = new Set(Array.from({ length: fields.tasks.length }, (_, index) => 't' + (index + 1)));
  const tasks = array(fields.tasks, 1000, (entry, index): Task => {
    const task = record(entry, ['id', 'label', 'priority', 'status', 'review', 'milestoneId', 'workstreamId',
      'prerequisites', 'criterionCount', 'evidenceCount', 'blockerCount']);
    const id = 't' + (index + 1);
    requireValue(task.id === id);
    const prerequisites = array(task.prerequisites, 1000, (key) => reference(key, taskIds));
    requireValue(!prerequisites.includes(id) && new Set(prerequisites).size === prerequisites.length);
    return {
      id, label: label(task.label), priority: option(task.priority, priorities), status: option(task.status, statuses),
      review: option(task.review, reviews), milestoneId: optionalReference(task.milestoneId, milestoneIds),
      workstreamId: optionalReference(task.workstreamId, workstreamIds), prerequisites,
      criterionCount: integer(task.criterionCount, 0, 20), evidenceCount: integer(task.evidenceCount, 0, 2000),
      blockerCount: integer(task.blockerCount, 0, 20),
    };
  });
  const report: PublicReport = {
    format: 'kitflint.glance.public.v1',
    project: { label: label(project.label), stage: option(project.stage, stages) },
    captured: { revision: integer(captured.revision, 1, 2147483647), updatedAt: timestamp(captured.updatedAt),
      preparedAt: timestamp(captured.preparedAt) },
    counts: { tasks: integer(counts.tasks, 0, 1000), open: integer(counts.open, 0, 1000),
      accepted: integer(counts.accepted, 0, 1000), inProgress: integer(counts.inProgress, 0, 1000),
      blocked: integer(counts.blocked, 0, 1000), needsReview: integer(counts.needsReview, 0, 1000),
      stale: integer(counts.stale, 0, 1000), changesRequested: integer(counts.changesRequested, 0, 1000) },
    focusTaskId: optionalReference(fields.focusTaskId, taskIds), milestones, workstreams, tasks,
  };
  verifyRelationships(report);
  return report;
}

function markdownLabel(value: string): string {
  return value.replace(/[\p{P}\p{S}\u2028\u2029]/gu, (character) => '&#' + character.codePointAt(0) + ';');
}

function markdownReport(report: PublicReport): string {
  const { project, captured, counts, milestones, workstreams, tasks } = report;
  const byTask = new Map(tasks.map((task) => [task.id, task]));
  const taskLabel = (id: string | null) => {
    const task = id === null ? undefined : byTask.get(id);
    return task ? task.id + ' ' + markdownLabel(task.label) : 'No focus selected';
  };
  const groupLabel = (id: string | null) => id === null ? 'Unassigned' : id;
  return [
    '# ' + markdownLabel(project.label), '',
    'Public report · Declared stage ' + project.stage + ' · Revision ' + captured.revision,
    'Updated ' + captured.updatedAt + ' · Prepared ' + captured.preparedAt,
    'Format ' + report.format, '',
    'Owner-recorded acceptance; proof is withheld from this public report. Counts measure tasks, not effort or completion percentage. ' +
      'The declared stage is not proof of public release. Private criteria, evidence, blocker contents and review history are withheld.',
    '', '## Summary', '',
    '- Tasks: ' + counts.tasks, '- Open: ' + counts.open, '- Owner-recorded acceptance: ' + counts.accepted,
    '- In progress: ' + counts.inProgress, '- Blocked: ' + counts.blocked, '- Needs review: ' + counts.needsReview,
    '- Stale reviews: ' + counts.stale, '- Changes requested: ' + counts.changesRequested,
    '- Current focus: ' + taskLabel(report.focusTaskId), '',
    ...([['Milestones', milestones], ['Workstreams', workstreams]] as const).flatMap(([heading, groups]) => [
      '## ' + heading, '',
      ...(groups.length ? groups.map((group) =>
        '- ' + group.id + ' ' + markdownLabel(group.label) + ' · ' + group.accepted + ' of ' + group.total + ' tasks accepted'
      ) : ['No ' + heading.toLowerCase() + ' recorded.']), '',
    ]),
    '## Tasks', '',
    ...(tasks.length ? tasks.flatMap((task) => [
      '### ' + task.id + ' ' + markdownLabel(task.label), '',
      '- Workflow: ' + task.status + ' · Human review: ' + task.review + ' · Priority: ' + task.priority,
      '- Milestone: ' + groupLabel(task.milestoneId) + ' · Workstream: ' + groupLabel(task.workstreamId),
      '- Prerequisites: ' + (task.prerequisites.join(', ') || 'None'),
      '- Criteria: ' + task.criterionCount + ' · Evidence references unique within this task: ' + task.evidenceCount +
        ' · Blockers: ' + task.blockerCount, '',
    ]) : ['No tasks recorded.', '']),
  ].join('\n');
}

const dashboardStyle = `
:root{font:16px/1.5 system-ui,sans-serif;color:#232323;background:#f7f7f5;color-scheme:light}
*{box-sizing:border-box}
body{margin:0}
[hidden]{display:none!important}
header{background:#232323;color:#fff;padding:.85rem 0}
header .shell{display:flex;justify-content:space-between;gap:.75rem;flex-wrap:wrap}
header strong{font-size:1.1rem}
.shell{max-width:1200px;width:calc(100% - 2rem);margin-inline:auto}
main{padding:1rem 0 3rem}
h1,h2,h3,p{margin:0 0 .55rem;overflow-wrap:anywhere}
h1{font-size:clamp(1.6rem,4vw,2.6rem);line-height:1.15}
h2{font-size:1.28rem}
h3{font-size:1.05rem}
small,.muted{color:#525252}
button,input,select{font:inherit}
button,input,select{max-width:100%;min-height:2.5rem;border:1px solid #bcbcbc;border-radius:6px;background:#fff;color:inherit;padding:.4rem .65rem}
button{cursor:pointer;overflow-wrap:anywhere;text-align:left}
button[aria-pressed=true]{background:#222;color:#fff;border-color:#222}
:focus-visible{outline:3px solid #135f9d;outline-offset:3px}
.skip{position:absolute;left:1rem;top:.5rem;transform:translateY(-250%);background:#fff;color:#222;padding:.5rem}
.skip:focus{transform:none}
.controls,nav,.chips{display:flex;flex-wrap:wrap;gap:.5rem;align-items:end;margin:.75rem 0}
.controls label{display:grid;gap:.2rem;min-width:0}
.panel,.card,.summary div{background:#fff;border:1px solid #d8d8d5;border-radius:8px;padding:1rem;min-width:0}
.panel{margin-block:.8rem}
.summary,.cards,.groups{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,13rem),1fr));gap:.75rem}
.summary strong{display:block;font-size:1.6rem}
.focus{background:#fff4da;border-left:5px solid #a96b14}
.workspace{display:grid;grid-template-columns:14rem minmax(0,1fr);gap:1rem}
.sidebar button{display:block;width:100%;margin:.35rem 0}
.group button,.title{font-weight:700}
progress{display:block;width:100%;margin-top:.4rem;accent-color:#336642}
.card p{margin:.4rem 0}
.pill{display:inline-block;padding:.1rem .45rem;margin:.1rem .25rem .1rem 0;border-radius:5px;background:#ededed;color:#303030;font-size:.85rem;font-weight:650}
.pill.planned{background:#e6edf2;color:#34475a}
.pill.in-progress{background:#e1edff;color:#123b77}
.pill.blocked{background:#fee6e6;color:#8b2020}
.pill.accepted{background:#e7f2e9;color:#275336}
.pill.stale,.pill.changes-requested{background:#fff0d4;color:#684300}
.table-wrap{overflow:auto}
table{border-collapse:collapse;width:100%;background:#fff}
th,td{padding:.55rem;text-align:left;vertical-align:top;border-bottom:1px solid #ddd;overflow-wrap:anywhere}
ul,dl{margin-top:.4rem}
dd{margin:0 0 .55rem;overflow-wrap:anywhere}
dialog{width:min(680px,calc(100% - 1.25rem));max-height:85vh;border:1px solid #aaa;border-radius:9px;padding:1rem;color:inherit}
dialog::backdrop{background:#18181899}
.dialog-heading{display:flex;align-items:start;justify-content:space-between;gap:.5rem}
@media(max-width:700px){.workspace{display:block}.sidebar button{width:auto;display:inline-block;margin:.25rem .25rem .25rem 0}}
`;
const dashboardScript = `
'use strict';
const report = JSON.parse(document.getElementById('public-data').textContent);
const id = (name) => document.getElementById(name);
const byTask = new Map(report.tasks.map((task) => [task.id, task]));
const dependents = new Map();
for (const task of report.tasks) {
  for (const key of task.prerequisites) {
    const linked = dependents.get(key) ?? [];
    linked.push(task.id);
    dependents.set(key, linked);
  }
}
const reviewNames = {accepted:'Accepted',stale:'Stale','changes-requested':'Changes requested',unreviewed:'Unreviewed'};
const workflows = {'Planned':'planned','In progress':'in-progress','Blocked':'blocked','Needs review':'needs-review'};
const axes = [['Milestones','milestoneId',report.milestones],['Workstreams','workstreamId',report.workstreams]];
const scopes = {milestoneId:'',workstreamId:''};
const dialog = id('task-dialog');
let trigger;
let layout = 'cards';

function element(tag, className, ...children) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  item.append(...children);
  return item;
}
function control(text, action, className) {
  const item = element('button', className, text);
  item.type = 'button';
  item.addEventListener('click', action);
  return item;
}
function section(heading, ...children) {
  return element('section', 'panel', element('h2', '', heading), ...children);
}
function taskLink(task) {
  return control(task.id + ' · ' + task.label, (event) => openTask(task, event.currentTarget), 'title');
}
function taskLinks(keys) {
  return keys.length ? element('ul', '', ...keys.map((key) => element('li', '', taskLink(byTask.get(key))))) : element('p', 'muted', 'None');
}
function groupName(groups, key) {
  const item = groups.find((group) => group.id === key);
  return item ? item.id + ' · ' + item.label : 'Unassigned';
}
function badge(text, name) {
  return element('span', 'pill ' + name, text);
}
function countsText(task) {
  return task.criterionCount + ' criteria · ' + task.evidenceCount + ' evidence references within this task · ' + task.blockerCount + ' blockers';
}
function metadata(task) {
  return element('dl', '', ...[
    ['Workflow', badge(task.status, workflows[task.status])],
    ['Human review', badge(reviewNames[task.review], task.review)],
    ['Priority', task.priority],
    ['Milestone', groupName(report.milestones, task.milestoneId)],
    ['Workstream', groupName(report.workstreams, task.workstreamId)],
    ['Counts', countsText(task)],
  ].flatMap(([label, value]) => [element('dt', '', label), element('dd', '', value)]));
}
function openTask(task, source) {
  if (!dialog.open) trigger = source;
  id('detail-title').textContent = task.id + ' · ' + task.label;
  id('detail-body').replaceChildren(metadata(task), element('p', 'muted', 'Private criteria, evidence and blocker contents are withheld.'),
    element('h3', '', 'Prerequisites'), taskLinks(task.prerequisites),
    element('h3', '', 'Depends on this task'), taskLinks(dependents.get(task.id) ?? []));
  if (!dialog.open) dialog.showModal();
  id('detail-title').focus();
}
id('close-detail').addEventListener('click', () => dialog.close());
dialog.addEventListener('close', () => {
  if (trigger?.isConnected && !trigger.closest('[hidden]')) trigger.focus();
  else id('tasks-view').focus();
  trigger = undefined;
});

function show(view) {
  for (const control of id('views').querySelectorAll('button')) control.setAttribute('aria-pressed', String(control.dataset.view === view));
  for (const page of document.querySelectorAll('[data-page]')) page.hidden = page.dataset.page !== view;
}
function groupCards(groups, key, filter) {
  if (!groups.length) return element('p', 'muted', 'No groups recorded.');
  return element('div', 'groups', ...groups.map((group) => {
    const title = group.id + ' · ' + group.label;
    const card = element('article', 'card group', filter ? control(title, () => {
      scopes[key] = scopes[key] === group.id ? '' : group.id;
      show('overview');
      renderTasks();
      id('active-scope').focus();
    }) : element('h3', '', title), element('p', 'muted', group.accepted + ' of ' + group.total + ' tasks accepted'));
    if (group.total > 0) {
      const progress = element('progress', '');
      progress.value = group.accepted;
      progress.max = group.total;
      progress.setAttribute('aria-label', title + ' accepted tasks');
      card.append(progress);
    }
    return card;
  }));
}
function workstreams() {
  const sidebar = id('workstream-links');
  sidebar.replaceChildren(element('h2', '', 'Workstreams'));
  for (const [key, label] of [['','All workstreams'],['unassigned','Unassigned'],...report.workstreams.map((g) => [g.id,g.id + ' · ' + g.label])]) {
    const select = control(label, () => {
      scopes.workstreamId = key;
      renderTasks();
      id('active-scope').focus();
    });
    select.setAttribute('aria-pressed', String(scopes.workstreamId === key));
    sidebar.append(select);
  }
}
function matchesScope(task, key) {
  return !scopes[key] || (scopes[key] === 'unassigned' ? task[key] === null : task[key] === scopes[key]);
}
function table(tasks, complete = false) {
  const columns = ['Task','Workflow','Human review','Priority','Counts'];
  if (complete) columns.push('Milestone','Workstream','Prerequisites','Depends on this task');
  const head = element('tr', '', ...columns.map((text) => {
    const column = element('th', '', text);
    column.scope = 'col';
    return column;
  }));
  const rows = tasks.map((task) => {
    const row = element('tr', '', element('td', '', taskLink(task)), element('td', '', badge(task.status, workflows[task.status])),
      element('td', '', badge(reviewNames[task.review], task.review)), element('td', '', task.priority), element('td', '', countsText(task)),
      ...(complete ? [element('td', '', groupName(report.milestones, task.milestoneId)),
        element('td', '', groupName(report.workstreams, task.workstreamId)),
        element('td', '', taskLinks(task.prerequisites)), element('td', '', taskLinks(dependents.get(task.id) ?? []))] : []));
    return row;
  });
  return element('div', 'table-wrap', element('table', '', element('thead', '', head), element('tbody', '', ...rows)));
}
function renderTasks() {
  const query = id('search').value.trim().toLocaleLowerCase();
  const status = id('status-filter').value;
  const review = id('review-filter').value;
  const tasks = report.tasks.filter((task) => matchesScope(task, 'milestoneId') && matchesScope(task, 'workstreamId') &&
    (!status || task.status === status) && (!review || task.review === review) &&
    (!query || (task.id + ' ' + task.label).toLocaleLowerCase().includes(query)));
  const scope = [
    scopes.milestoneId && 'Milestone: ' + groupName(report.milestones, scopes.milestoneId),
    scopes.workstreamId && 'Workstream: ' + (scopes.workstreamId === 'unassigned' ? 'Unassigned' : groupName(report.workstreams, scopes.workstreamId)),
  ].filter(Boolean);
  id('active-scope').textContent = tasks.length + ' of ' + report.tasks.length + ' tasks' + (scope.length ? ' · ' + scope.join(' · ') : '');
  workstreams();
  id('task-results').replaceChildren(!tasks.length ? element('p', 'muted', report.tasks.length ? 'No tasks match these filters.' : 'No tasks recorded.') :
    layout === 'table' ? table(tasks) : element('div', 'cards', ...tasks.map((task) => element('article', 'card', taskLink(task),
      element('p', '', badge(task.status, workflows[task.status]), badge(reviewNames[task.review], task.review)),
      element('p', 'muted', task.priority + ' · ' + countsText(task)),
      element('p', 'muted', task.prerequisites.length + ' prerequisites · ' + (dependents.get(task.id)?.length ?? 0) + ' dependents')))));
}
function filterOptions(select, options) {
  for (const [value, text] of options) {
    const option = element('option', '', text);
    option.value = value;
    select.append(option);
  }
}

id('project-label').textContent = report.project.label;
id('captured').textContent = 'Declared stage ' + report.project.stage + ' · Revision ' + report.captured.revision + ' · Updated ' + report.captured.updatedAt;
id('prepared').textContent = 'Prepared ' + report.captured.preparedAt + ' · ' + report.format;
for (const [key, text] of [['tasks','Tasks'],['open','Open'],['accepted','Owner-recorded acceptance'],['inProgress','In progress']]) {
  id('summary').append(element('div', '', element('strong', '', String(report.counts[key])), text));
}
const focus = report.focusTaskId === null ? null : byTask.get(report.focusTaskId);
id('focus-task').append(focus ? taskLink(focus) : element('p', '', 'No focus selected.'));
id('milestones').append(groupCards(report.milestones, 'milestoneId', true));
const journey = id('journey');
journey.append(section('Current position', element('p', '', 'Declared stage ' + report.project.stage),
  focus ? taskLink(focus) : element('p', '', 'No focus selected.')),
  section('Milestones', groupCards(report.milestones, 'milestoneId', false)));
const membership = section('Workstream membership');
for (const workstream of [...report.workstreams, {id:null,label:'Unassigned'}]) {
  membership.append(element('h3', '', workstream.id ? workstream.id + ' · ' + workstream.label : workstream.label),
    taskLinks(report.tasks.filter((task) => task.workstreamId === workstream.id).map((task) => task.id)));
}
journey.append(membership, section('Prerequisites', ...(report.tasks.length ? report.tasks.map((task) => element('article', 'card', taskLink(task),
  taskLinks(task.prerequisites))) : [element('p', 'muted', 'No tasks recorded.')])));
const review = id('review');
for (const [state, text] of Object.entries(reviewNames)) {
  const matches = report.tasks.filter((task) => task.review === state);
  review.append(section(text + ' · ' + matches.length, control('Filter tasks by ' + text, () => {
    id('clear-filters').click();
    id('review-filter').value = state;
    show('overview');
    renderTasks();
    id('review-filter').focus();
  }), taskLinks(matches.map((task) => task.id))));
}
id('evidence').append(...(report.tasks.length ? report.tasks.map((task) => element('article', 'panel', taskLink(task),
  element('p', '', countsText(task)))) : [element('p', '', 'No tasks or evidence references recorded.')]));
const full = id('full');
full.append(section('Summary', element('p', '', 'Tasks: ' + report.counts.tasks + ' · Open: ' + report.counts.open +
  ' · Owner-recorded acceptance: ' + report.counts.accepted + ' · In progress: ' + report.counts.inProgress +
  ' · Blocked: ' + report.counts.blocked + ' · Needs review: ' + report.counts.needsReview +
  ' · Stale: ' + report.counts.stale + ' · Changes requested: ' + report.counts.changesRequested),
  element('p', '', 'Current focus'), focus ? taskLink(focus) : element('p', '', 'No focus selected.')),
  ...axes.map(([heading, key, groups]) => section(heading, groupCards(groups, key, false))),
  section('Tasks', report.tasks.length ? table(report.tasks, true) : element('p', '', 'No tasks recorded.')));
filterOptions(id('status-filter'), Object.keys(workflows).map((value) => [value,value]));
filterOptions(id('review-filter'), Object.entries(reviewNames));
id('views').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-view]');
  if (button) show(button.dataset.view);
});
id('search').addEventListener('input', renderTasks);
id('status-filter').addEventListener('change', renderTasks);
id('review-filter').addEventListener('change', renderTasks);
id('clear-filters').addEventListener('click', () => {
  id('search').value = id('status-filter').value = id('review-filter').value = '';
  scopes.milestoneId = scopes.workstreamId = '';
  renderTasks();
});
for (const mode of ['cards','table']) {
  id(mode + '-mode').addEventListener('click', () => {
    layout = mode;
    for (const choice of ['cards','table']) id(choice + '-mode').setAttribute('aria-pressed', String(choice === mode));
    renderTasks();
  });
}
renderTasks();
`;

function scriptJson(value: PublicReport): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (character) =>
    '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'));
}

function htmlReport(report: PublicReport): string {
  const script = createHash('sha256').update(dashboardScript).digest('base64');
  const style = createHash('sha256').update(dashboardStyle).digest('base64');
  const policy = "default-src 'none'; connect-src 'none'; img-src 'none'; font-src 'none'; object-src 'none'; " +
    "base-uri 'none'; form-action 'none'; script-src 'sha256-" + script + "'; style-src 'sha256-" + style + "'";
  return '<!doctype html>\n<html lang="en"><head><meta charset="utf-8">\n' +
    '<meta http-equiv="Content-Security-Policy" content="' + policy + '">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1"><title>Glance public report</title>\n' +
    '<style>' + dashboardStyle + '</style></head><body>\n' +
    '<a class="skip" href="#main">Skip to report</a><header><div class="shell"><strong id="project-label"></strong><span id="captured"></span></div></header>\n' +
    '<main class="shell" id="main" tabindex="-1"><h1>Made for human eyes. Built for clear decisions.</h1>\n' +
    '<p id="prepared" class="muted"></p><p>Owner-recorded acceptance; proof is withheld from this public report. ' +
    'Counts measure tasks, not effort or a project completion percentage. The declared stage is not proof of public release.</p>\n' +
    '<nav id="views" aria-label="Report views"><button type="button" data-view="overview" aria-pressed="true">Overview</button>' +
    '<button type="button" data-view="journey" aria-pressed="false">Journey</button><button type="button" data-view="review" aria-pressed="false">Review</button>' +
    '<button type="button" data-view="evidence" aria-pressed="false">Evidence</button><button type="button" data-view="full" aria-pressed="false">Full report</button></nav>\n' +
    '<div data-page="overview"><section id="summary" class="summary" aria-label="Summary"></section><section class="panel focus">' +
    '<h2>Current focus</h2><div id="focus-task"></div></section><section class="panel" id="milestones"><h2>Milestones</h2></section>' +
    '<div class="workspace"><aside class="panel sidebar" id="workstream-links"></aside><section class="panel" aria-labelledby="tasks-view">' +
    '<h2 id="tasks-view" tabindex="-1">Tasks</h2><div class="controls"><label>Search tasks<input id="search" type="search"></label>' +
    '<label>Workflow<select id="status-filter"><option value="">All workflows</option></select></label>' +
    '<label>Human review<select id="review-filter"><option value="">All review states</option></select></label>' +
    '<button type="button" id="clear-filters">Clear filters</button></div><div class="chips">' +
    '<button type="button" id="cards-mode" aria-pressed="true">Cards</button><button type="button" id="table-mode" aria-pressed="false">Table</button></div>' +
    '<p id="active-scope" tabindex="-1" role="status"></p><div id="task-results"></div></section></div></div>\n' +
    '<section data-page="journey" id="journey" hidden><h2>Journey</h2><p>Current structure and prerequisites. Activity history is withheld.</p></section>\n' +
    '<section data-page="review" id="review" hidden><h2>Review</h2><p>Current human review by task. Reviewer identities, private notes and review history are withheld.</p></section>\n' +
    '<section data-page="evidence" id="evidence" hidden><h2>Evidence</h2><p>Evidence references are unique within each task. Evidence contents, locations, outcomes and proof are withheld and cannot be verified here.</p></section>\n' +
    '<section data-page="full" id="full" hidden><h2>Full report</h2><p>All public task, group and review facts. Private contents are withheld.</p></section>\n' +
    '<dialog id="task-dialog" aria-labelledby="detail-title"><div class="dialog-heading"><h2 id="detail-title" tabindex="-1"></h2>' +
    '<button type="button" id="close-detail">Close detail</button></div><div id="detail-body"></div></dialog></main>\n' +
    '<script type="application/json" id="public-data">' + scriptJson(report) + '</script>\n' +
    '<script>' + dashboardScript + '</script></body></html>\n';
}

export function createPublicExport(value: unknown): PublicExportFiles | undefined {
  try {
    const report = validate(value);
    const html = htmlReport(report);
    const markdown = markdownReport(report);
    const publicJson = JSON.stringify(report, null, 2) + '\n';
    const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
    const files: PublicExportFiles = { report, html, markdown, publicJson,
      sha256: { html: hash(html), markdown: hash(markdown), publicJson: hash(publicJson) } };
    return Buffer.byteLength(JSON.stringify(files), 'utf8') <= responseLimit ? files : undefined;
  } catch {
    return undefined;
  }
}
