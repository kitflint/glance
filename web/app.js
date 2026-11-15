const id = (name) => document.getElementById(name);
const sessionKey = 'kitflint.glance.session';
const statuses = ['Planned', 'In progress', 'Needs review', 'Blocked'];
const stages = ['Plan', 'Build', 'Verify', 'Release'];
const statusStyle = {
  Planned: 'planned', 'In progress': 'in-progress', 'Needs review': 'review', Blocked: 'blocked',
  passed: 'passed', failed: 'failed', unknown: 'unknown', 'not-run': 'not-run',
};
const formats = [
  { key: 'html', label: 'HTML', name: 'glance.html', mediaType: 'text/html' },
  { key: 'markdown', label: 'Markdown', name: 'glance.md', mediaType: 'text/markdown' },
  { key: 'backupJson', label: 'JSON backup', name: 'glance.json', mediaType: 'application/json' },
];

let token = null;
let confirmed = null;
let screen;
let view = 'overview';
let layout = 'cards';
let milestone = '';
let workstream = '';
let detail = null;
let editor = null;
let reviewForm = null;
let backupPending = false;
let preparing = false;
let checking = false;
let initializing = false;
let initUnknown = false;
let writeHold = false;
let quitting = false;
let recoverySource = null;
let exportPackage = null;
let initiated = new Set();

class RequestFailure extends Error {
  constructor(payload, status) {
    super(payload?.error?.message ?? 'The local host did not return a usable response.');
    this.code = payload?.error?.code ?? 'INVALID_RESPONSE';
    this.fields = payload?.error?.fields ?? [];
    this.current = payload?.current;
    this.recoveryAvailable = payload?.recoveryAvailable === true;
    this.status = status;
  }
}

async function api(route, body) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(route, {
    method: body === undefined ? 'GET' : 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
    headers, cache: 'no-store', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(9000),
  });
  const payload = await response.json();
  if (!response.ok || payload?.ok !== true) throw new RequestFailure(payload, response.status);
  return payload;
}

function node(tag, className, ...children) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  for (const child of children) {
    if (child !== undefined && child !== null) element.append(child);
  }
  return element;
}

function button(label, action, className, focusKey) {
  const element = node('button', className, label);
  element.type = 'button';
  if (focusKey) element.dataset.focusKey = focusKey;
  element.addEventListener('click', action);
  return element;
}

function pressed(element, on) {
  element.setAttribute('aria-pressed', String(on));
  return element;
}

function notice(text, error = false) {
  id('notice').textContent = text;
  id('notice').dataset.tone = error ? 'error' : 'normal';
}

function screenTo(target) {
  screen = target;
  if (target !== 'board') {
    publicDraft = genericPublicDraft();
    setPublicPanel(false);
    setGithubPanel(false);
  }
  for (const name of ['access-panel', 'initialization', 'board', 'recovery', 'shutdown']) {
    id(name).hidden = name !== target;
  }
  id('quit').hidden = !token || target === 'shutdown' || target === 'access-panel';
}

function forgetToken() {
  token = null;
  try { sessionStorage.removeItem(sessionKey); } catch { /* Session storage is unavailable. */ }
}

function clearBoardView() {
  confirmed = null;
  publicDraft = genericPublicDraft();
  setPublicPanel(false);
  exportPackage = null;
  id('export-links').replaceChildren();
  id('export-panel').hidden = true;
  id('review-backup-status').textContent = '';
  id('header-project').textContent = 'Local board';
  id('freshness').textContent = '';
  if (id('detail-dialog').open) closeDetail(false);
}

function accessPanel(message) {
  forgetToken();
  if (!editor && !reviewForm) clearBoardView();
  if (message) id('access-message').textContent = message;
  screenTo('access-panel');
  notice('');
}

function stateFrom(payload) {
  return { snapshot: payload.snapshot, version: payload.version, report: payload.report };
}

function accept(payload, { fromGithubRead = false, refreshGithub = false } = {}) {
  const boardChanged = confirmed?.snapshot.boardId !== payload.snapshot.boardId;
  const changed = boardChanged || confirmed?.version !== payload.version;
  confirmed = stateFrom(payload);
  screenTo('board');
  const githubRefresh = acceptGithubBoard({ changed, boardChanged, fromGithubRead, refreshGithub });
  if (changed) {
    const hadPreview = publicPackage || publicBusy;
    invalidatePublic(hadPreview ? 'The saved revision changed. Prepare a new public preview.' : '');
    for (const [key] of publicGroups) {
      const valid = new Set(confirmed.snapshot[key].map(({ id }) => id));
      publicDraft[key] = publicDraft[key].filter((entry) => valid.has(entry.id));
    }
    if (!id('public-report').hidden) renderPublicLabels();
  }
  updatePublicControls();
  renderBoard();
  return githubRefresh;
}

function enterRecovery(error) {
  if (!editor && !reviewForm) clearBoardView();
  recoverySource = null;
  id('recover-download').hidden = !error.recoveryAvailable;
  id('recovery-detail').textContent = error.recoveryAvailable
    ? 'A validated previous revision is available.'
    : 'No validated previous revision is available. Use an earlier portable backup if you have one.';
  screenTo('recovery');
  notice('');
}

function handleReadFailure(error) {
  if (error instanceof RequestFailure && error.code === 'RECOVERY_REQUIRED') {
    enterRecovery(error);
  } else if (error instanceof RequestFailure && error.status === 401) {
    accessPanel();
  } else {
    notice(error instanceof RequestFailure ? error.message : 'Host unavailable', true);
  }
}

async function refreshBoard() {
  if (checking || editor || reviewForm || initializing || quitting) return;
  checking = true;
  if (publicBusy) invalidatePublic('The board is being refreshed. Prepare a new public preview.');
  updatePublicControls();
  id('refresh').disabled = true;
  id('check-initialization').disabled = true;
  try {
    const payload = await api('/api/board');
    if (quitting || screen === 'shutdown') return;
    const held = writeHold;
    writeHold = false;
    initUnknown = false;
    setInitControls();
    if (payload.initialized) {
      accept(payload, { refreshGithub: true });
      id('blank-form').reset();
      id('import-form').reset();
      setInitControls();
      notice(held ? 'Review the refreshed board before opening another edit.' : '');
    } else {
      clearBoardView();
      screenTo('initialization');
      notice('');
    }
  } catch (error) {
    if (publicPackage) invalidatePublic('The saved revision could not be checked. Prepare a new public preview.', true);
    if (!quitting && screen !== 'shutdown') handleReadFailure(error);
  } finally {
    checking = false;
    updatePublicControls();
    id('refresh').disabled = false;
    id('check-initialization').disabled = false;
  }
}

function listText(items, empty) {
  return items.length ? node('ul', '', ...items.map((item) => node('li', '', item))) : node('p', 'muted', empty);
}

function groupTitle(items, key) {
  return items.find((item) => item.id === key)?.title ?? 'Unassigned';
}

function pill(value) {
  return node('span', 'pill ' + (statusStyle[value] ?? ''), value);
}

const reviewLabels = {
  unreviewed: 'Unreviewed', accepted: 'Accepted for stated scope',
  'changes-requested': 'Changes requested', stale: 'Stale review',
};

function reviewState(taskId, state = confirmed) {
  return state.report.taskReviews.find((item) => item.taskId === taskId)?.state ?? 'unreviewed';
}

function reviewPill(taskId) {
  const state = reviewState(taskId);
  return node('span', 'pill review-' + state, reviewLabels[state]);
}

function when(value) {
  // F8: GitHub times use the same local format as the board header; the ISO value stays in a tooltip.
  if (typeof value !== 'string' || !value) return value;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function stamped(element, value) {
  if (typeof value === 'string' && value) element.title = value;
  return element;
}

function githubChip(task) {
  // F2: show whether a task is linked to a GitHub issue or stays local, once the board has a repository.
  const github = confirmed?.snapshot.github;
  if (!github) return null;
  const mapping = github.issues?.find((item) => item.localTaskId === task.id);
  if (mapping) return node('span', 'pill github-chip linked', 'GitHub issue #' + mapping.number);
  return github.repository ? node('span', 'pill github-chip', 'Local only') : null;
}

function taskLink(task, prefix = 'task') {
  const link = button(task.title, (event) => openDetail(task.id, event.currentTarget), 'task-title', prefix + '-' + task.id);
  return link;
}

function taskCards(tasks) {
  return node('div', 'cards', ...tasks.map((task) => node('article', 'ticket',
    taskLink(task),
    node('div', 'ticket-meta', pill(task.status), reviewPill(task.id), githubChip(task), node('span', '', task.priority), node('span', '', task.owner || 'Unassigned')),
    task.description ? node('p', 'excerpt', task.description) : null,
    node('p', 'ticket-meta', task.criteria.length + ' criteria · ' + task.prerequisites.length + ' prerequisites'),
  )));
}

function taskTable(tasks) {
  const heading = node('tr', '', ...['Task', 'Status', 'Review state', 'Owner', 'Priority', 'Criteria'].map((label) => {
    const th = node('th', '', label);
    th.scope = 'col';
    return th;
  }));
  const body = node('tbody', '', ...tasks.map((task) => node('tr', '',
    node('td', '', taskLink(task), githubChip(task)),
    node('td', '', pill(task.status)), node('td', '', reviewPill(task.id)), node('td', '', task.owner || 'Unassigned'),
    node('td', '', task.priority), node('td', '', String(task.criteria.length)),
  )));
  const table = node('div', 'table-wrap', node('table', 'task-table', node('thead', '', heading), body));
  table.tabIndex = 0;
  table.setAttribute('aria-label', 'Task table');
  table.setAttribute('role', 'region');
  return table;
}

function showView(name) {
  view = name;
  for (const control of id('view-navigation').querySelectorAll('[data-view]')) {
    if (control.dataset.view === name) control.setAttribute('aria-current', 'page');
    else control.removeAttribute('aria-current');
  }
  for (const section of document.querySelectorAll('.board-view')) section.hidden = section.id !== name;
}

function applyScope(key, value, focusKey) {
  if (key === 'milestone') milestone = value;
  else workstream = value;
  showView('overview');
  renderGroups();
  renderTasks();
  restoreFocus({ key: focusKey });
}

function scopeButton(label, key, value, selected, focusKey) {
  return pressed(button(label, () => applyScope(key, value, focusKey), '', focusKey), selected);
}

function renderGroups() {
  const { snapshot, report } = confirmed;
  const milestoneCards = (prefix) => snapshot.milestones.map((item, index) => {
    const count = report.milestones[index];
    const key = 'milestone-' + item.id;
    const select = scopeButton(item.title, 'milestone', milestone === item.id ? '' : item.id, milestone === item.id, key);
    if (prefix !== 'overview') select.removeAttribute('data-focus-key');
    const edit = button('Edit', (event) => openEditor('milestone.edit', item.id, event.currentTarget), '', prefix + '-edit-' + item.id);
    edit.setAttribute('aria-label', 'Edit milestone ' + item.title);
    return node('article', 'milestone',
      node('div', 'actions', select, edit),
      node('p', 'muted', count.openTasks + ' open · ' + count.totalTasks + ' total'),
    );
  });
  const cards = milestoneCards('overview');
  id('milestones').replaceChildren(...(cards.length ? cards : [node('p', 'muted', 'No milestones yet.')]));
  const journeyCards = milestoneCards('journey');
  id('journey-list').replaceChildren(...(journeyCards.length ? journeyCards : [node('p', 'muted', 'Add milestones in Overview to map the journey.')]));
  id('workstreams').replaceChildren(scopeButton('All workstreams', 'workstream', '', workstream === '', 'workstream-all'),
    ...snapshot.workstreams.map((item, index) => {
      const count = report.workstreams[index];
      const edit = button('Edit', (event) => openEditor('workstream.edit', item.id, event.currentTarget), '', 'edit-' + item.id);
      edit.setAttribute('aria-label', 'Edit workstream ' + item.title);
      return node('div', 'workstream',
        scopeButton(item.title + ' · ' + count.openTasks, 'workstream', workstream === item.id ? '' : item.id, workstream === item.id, 'workstream-' + item.id),
        edit,
      );
    }),
  );
}

function renderTasks() {
  if (!confirmed) return;
  const { snapshot } = confirmed;
  const query = id('task-search').value.trim().toLocaleLowerCase();
  const status = id('task-status').value;
  const tasks = snapshot.tasks.filter((task) => (!milestone || task.milestoneId === milestone) &&
    (!workstream || task.workstreamId === workstream) && (!status || task.status === status) &&
    (!query || [task.title, task.description, task.owner, task.id].some((text) => text.toLocaleLowerCase().includes(query))));
  const chips = [];
  if (milestone) {
    chips.push(button('Clear milestone ' + groupTitle(snapshot.milestones, milestone),
      () => applyScope('milestone', '', 'milestone-' + milestone)));
  }
  if (workstream) {
    chips.push(button('Clear workstream ' + groupTitle(snapshot.workstreams, workstream),
      () => applyScope('workstream', '', 'workstream-all')));
  }
  id('scope-chips').replaceChildren(...chips);
  id('matches').textContent = tasks.length + ' of ' + snapshot.tasks.length + ' tasks';
  id('task-list').replaceChildren(tasks.length
    ? (layout === 'table' ? taskTable(tasks) : taskCards(tasks))
    : node('div', 'panel muted', snapshot.tasks.length ? 'No tasks match these filters.' : 'Add a task to start the board.'));
}

function evidenceLocation(value) {
  if (/^https?:\/\//i.test(value) && value.length <= 2048 && !/[\s\\]/u.test(value)) {
    try {
      const parsed = new URL(value);
      if (['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password) {
        const link = node('a', '', value);
        link.href = parsed.href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        return link;
      }
    } catch { /* Display the reference as plain text. */ }
  }
  return node('span', 'preserve', value || 'No reference');
}

function evidenceCard(record, all) {
  const previous = all.find((item) => item.id === record.supersedesId);
  return node('article', 'panel',
    node('h4', '', record.title), node('div', 'ticket-meta', pill(record.outcome),
      node('span', '', record.scope), node('time', '', record.recordedAt)),
    node('p', '', evidenceLocation(record.location)),
    previous ? node('p', 'muted', 'Corrects ' + previous.title) : null,
  );
}

function renderBoard() {
  const { snapshot, report } = confirmed;
  id('header-project').textContent = snapshot.project.name;
  id('freshness').textContent = 'Revision ' + snapshot.revision + ' · ' + new Date(snapshot.updatedAt).toLocaleString();
  id('project-name').textContent = snapshot.project.name;
  id('project-stage').textContent = 'Stage: ' + snapshot.project.stage;
  id('project-goal').textContent = snapshot.project.goal;
  const counts = [
    ['Open', report.counts.open], ['Accepted for stated scope', report.acceptance.accepted],
    ['Stale reviews', report.acceptance.stale], ['Changes requested', report.acceptance.changesRequested],
    ['In progress', report.counts.inProgress], ['Blocked', report.counts.blocked], ['Needs review', report.counts.needsReview],
  ];
  id('summary').replaceChildren(...counts.map(([label, value]) => node('article', 'stat',
    node('b', '', String(value)), node('span', '', label),
  )));
  const focused = snapshot.tasks.find((task) => task.id === report.focusTaskId);
  id('focus-content').replaceChildren(focused ? taskLink(focused, 'focus') : node('p', 'muted', 'No focus task selected.'),
    node('h4', '', 'Owner-recorded next actions'), listText(report.nextActions, 'No next actions recorded.'));
  renderGroups();
  renderTasks();
  id('review-list').replaceChildren(snapshot.tasks.length ? taskCards(snapshot.tasks) : node('p', 'muted', 'No tasks to review.'));
  const reviewCount = snapshot.reviews?.length ?? 0;
  id('review-capacity').textContent = reviewCount + ' / 2000 review records in this cycle. The 2 MiB snapshot limit also applies.';
  const archive = snapshot.reviewArchive;
  id('review-archive-notice').textContent = archive
    ? 'Earlier reviews remain in your retained private backup. ' + archive.boardId + ' · ' + archive.generation + ':' +
      archive.revision + ' · ' + archive.reviewCount + ' review records · Normalized snapshot SHA-256 ' + archive.snapshotSha256
    : 'No previous review cycle is linked.';
  if (reviewCount === 2000) id('review-capacity').append(' Download a full current backup before continuing in a new directory.');
  id('evidence-list').replaceChildren(...(snapshot.evidence.length
    ? snapshot.evidence.map((item) => evidenceCard(item, snapshot.evidence))
    : [node('p', 'muted', 'No evidence references yet.')]));
  showView(view);
  if (detail) renderDetail();
}

function focusReference(element) {
  return { element, key: element?.dataset.focusKey };
}

function restoreFocus(reference) {
  const visible = (element) => element?.isConnected && !element.closest('[hidden], dialog:not([open])');
  if (visible(reference?.element)) {
    reference.element.focus();
    return;
  }
  const match = reference?.key
    ? [...document.querySelectorAll('[data-focus-key]')].find((element) => element.dataset.focusKey === reference.key && visible(element))
    : null;
  if (match) match.focus();
  else if (id('detail-dialog').open) id('detail-title').focus();
  else (screen === 'board' ? id('project-name') : id('main')).focus();
}

function openDetail(taskId, trigger) {
  if (detail) detail.id = taskId;
  else detail = { id: taskId, trigger: focusReference(trigger) };
  renderDetail();
  if (!id('detail-dialog').open) id('detail-dialog').showModal();
  id('detail-title').focus();
}

function closeDetail(restore = true) {
  const trigger = detail?.trigger;
  detail = null;
  id('detail-dialog').close();
  if (restore) restoreFocus(trigger);
}

function renderDetail() {
  const { snapshot } = confirmed;
  const task = snapshot.tasks.find((item) => item.id === detail.id);
  if (!task) {
    closeDetail();
    return;
  }
  id('detail-id').textContent = task.id;
  id('detail-title').textContent = task.title;
  const metadata = [['Owner', task.owner || 'Unassigned'], ['Priority', task.priority],
    ['Milestone', groupTitle(snapshot.milestones, task.milestoneId)],
    ['Workstream', groupTitle(snapshot.workstreams, task.workstreamId)]];
  const criterionList = node('ul', 'detail-list', ...task.criteria.map((criterion) => node('li', '',
    node('p', 'preserve', criterion.requirement),
    node('p', 'muted', criterion.evidenceIds.length + ' evidence references'),
    button('Edit criterion', (event) => openEditor('criterion.edit', { taskId: task.id, id: criterion.id }, event.currentTarget),
      '', 'edit-' + criterion.id),
  )));
  const connectedTasks = (keys, empty) => keys.length
    ? node('div', 'actions', ...keys.map((key) => snapshot.tasks.find((item) => item.id === key)).filter(Boolean).map((item) => taskLink(item, 'linked')))
    : node('p', 'muted', empty);
  const blockedBy = snapshot.tasks.filter((item) => item.prerequisites.includes(task.id)).map((item) => item.id);
  const relatedEvidence = new Set([...task.evidenceIds, ...task.criteria.flatMap((item) => item.evidenceIds)]);
  id('detail-body').replaceChildren(
    node('div', 'actions', pill(task.status), reviewPill(task.id), githubChip(task),
      button('Review task', (event) => openReview(task.id, event.currentTarget), '', 'review-' + task.id),
      button('Edit task', (event) => openEditor('task.edit', task.id, event.currentTarget), '', 'edit-' + task.id)),
    task.description ? node('p', 'preserve', task.description) : node('p', 'muted', 'No description recorded.'),
    node('dl', 'detail-grid', ...metadata.map(([label, value]) => node('div', '', node('dt', '', label), node('dd', '', value)))),
    node('section', '', node('h3', '', 'Criteria'), task.criteria.length ? criterionList : node('p', 'muted', 'No criteria recorded.'),
      node('div', 'actions', button('Add criterion', (event) => openEditor('criterion.add', task.id, event.currentTarget), '', 'criterion-' + task.id))),
    node('section', '', node('h3', '', 'Blockers'), listText(task.blockers, 'No blockers recorded.')),
    node('section', '', node('h3', '', 'Prerequisites'), connectedTasks(task.prerequisites, 'No prerequisites.')),
    node('section', '', node('h3', '', 'Depends on this task'), connectedTasks(blockedBy, 'No tasks depend directly on this task.')),
    node('section', '', node('h3', '', 'Evidence'),
      node('div', 'actions', button('Add evidence to this task', (event) => openEditor('evidence.add', task.id, event.currentTarget),
        '', 'evidence-' + task.id)),
      ...(relatedEvidence.size ? snapshot.evidence.filter((item) => relatedEvidence.has(item.id)).map((item) => evidenceCard(item, snapshot.evidence))
        : [node('p', 'muted', 'No linked evidence.')])),
    reviewHistory(confirmed, task.id),
  );
}
function reviewHistory(state, taskId) {
  const records = state.snapshot.reviews?.filter((record) => record.taskId === taskId) ?? [];
  return node('details', 'review-history', node('summary', '', 'Review history (' + records.length + ')'),
    ...(records.length ? records.toReversed().map((record) => {
      const historical = record.generation !== state.snapshot.generation;
      const subject = record.basis;
      return node('article', 'panel',
        node('h4', '', reviewLabels[record.decision] + (historical ? ' · Prior generation' : '')),
        node('p', 'muted', (record.reviewer || 'System invalidation') + ' · ' + record.recordedAt),
        node('p', 'preserve', 'Scope: ' + record.scope), node('p', 'preserve', record.note),
        node('p', 'record-id', record.id), node('p', 'record-id', 'Basis SHA-256 ' + record.basisSha256),
        record.previousReviewId ? node('p', 'record-id', 'Previous review ' + record.previousReviewId) : null,
        subject ? node('details', '', node('summary', '', 'Original reviewed subject'),
          node('p', 'preserve', subject.task.title + ' · ' + subject.task.id),
          node('pre', 'preserve', JSON.stringify(subject, null, 2))) : null,
      );
    }) : [node('p', 'muted', 'No review records in this cycle.')]));
}

function renderReviewSubject(record) {
  const { snapshot } = record.base;
  const task = snapshot.tasks.find((item) => item.id === record.taskId);
  const linked = new Set([...task.evidenceIds, ...task.criteria.flatMap((item) => item.evidenceIds)]);
  for (const item of snapshot.evidence.toReversed()) {
    if (item.supersedesId && linked.has(item.id)) linked.add(item.supersedesId);
  }
  for (const item of snapshot.evidence) {
    if (item.supersedesId && linked.has(item.supersedesId)) linked.add(item.id);
  }
  const evidence = snapshot.evidence.filter((item) => linked.has(item.id));
  const byId = new Map(evidence.map((item) => [item.id, item]));
  const superseded = new Set(evidence.map((item) => item.supersedesId));
  const prerequisites = task.prerequisites.map((key) => snapshot.tasks.find((item) => item.id === key));
  const issues = [];
  if (!task.criteria.length) issues.push('Add at least one criterion.');
  if (task.blockers.length) issues.push('Resolve the task blockers.');
  if (prerequisites.some((item) => reviewState(item.id, record.base) !== 'accepted')) issues.push('Accept every prerequisite task.');
  for (const criterion of task.criteria) {
    const current = criterion.evidenceIds.filter((key) => !superseded.has(key));
    if (!current.length || current.some((key) => byId.get(key)?.outcome !== 'passed')) {
      issues.push('Link current passed evidence and resolve current nonpassing records for: ' + criterion.requirement);
    }
  }
  id('review-decision').querySelector('[value="accepted"]').disabled = issues.length > 0;
  id('review-subject').replaceChildren(
    node('h3', '', task.title),
    node('h4', '', 'Criteria'),
    listText(task.criteria.map((item) => item.requirement + ' · Evidence: ' +
      (item.evidenceIds.map((key) => byId.get(key)?.title ?? key).join(', ') || 'None')), 'No criteria.'),
    node('h4', '', 'Blockers'), listText(task.blockers, 'No blockers.'),
    node('h4', '', 'Prerequisites'), listText(prerequisites.map((item) =>
      item.title + ' · ' + reviewLabels[reviewState(item.id, record.base)]), 'No prerequisites.'),
    node('h4', '', 'Linked evidence and corrections'),
    ...(evidence.length ? evidence.map((item) => evidenceCard(item, evidence)) : [node('p', 'muted', 'No linked evidence.')]),
    ...(issues.length ? [node('h4', '', 'Acceptance unavailable'), listText(issues, '')] : []),
  );
}

function reviewMessage(message) {
  id('review-message').textContent = message;
  if (message) id('review-message').focus();
}

function setReviewControls() {
  if (!reviewForm) return;
  const { busy, mode } = reviewForm;
  const enabled = !busy && mode === 'edit';
  for (const key of ['reviewer', 'review-scope', 'review-note']) id(key).readOnly = !enabled;
  for (const key of ['review-decision', 'review-confirm', 'submit-review']) id(key).disabled = !enabled;
  id('close-review').disabled = busy;
  id('refresh-review').hidden = mode !== 'unknown';
  id('refresh-review').disabled = busy;
}

function openReview(taskId, trigger) {
  if (!confirmed || reviewForm || editor || checking || quitting || writeHold || screen !== 'board') {
    if (writeHold) notice('Refresh the saved board before opening another review.', true);
    return;
  }
  reviewForm = { taskId, base: confirmed, trigger: focusReference(trigger), mode: 'edit', busy: false };
  invalidatePublic('Prepare a new public preview after closing the review.');
  id('review-form').reset();
  id('review-message').textContent = '';
  id('review-saved-history').hidden = true;
  id('review-saved-history').replaceChildren();
  id('review-version').textContent = 'Board revision ' + confirmed.snapshot.revision + ' · ' + confirmed.version;
  renderReviewSubject(reviewForm);
  setReviewControls();
  id('review-dialog').showModal();
  id('review-dialog-title').focus();
}

function closeReview() {
  if (!reviewForm || reviewForm.busy) return;
  const trigger = reviewForm.trigger;
  reviewForm = null;
  updatePublicControls();
  id('review-dialog').close();
  if (screen !== 'board') clearBoardView();
  restoreFocus(trigger);
}

function reviewSavedHistory(record, fresh) {
  const panel = id('review-saved-history');
  panel.replaceChildren(node('h3', '', 'Saved review history'), reviewHistory(fresh, record.taskId));
  panel.querySelector('details').open = true;
  panel.hidden = false;
}

async function saveReview(event) {
  event.preventDefault();
  const record = reviewForm;
  if (!record || record.busy || record.mode !== 'edit' || !id('review-confirm').checked) return;
  const input = {
    boardId: record.base.snapshot.boardId, expectedVersion: record.base.version, taskId: record.taskId,
    reviewer: id('reviewer').value, scope: id('review-scope').value, note: id('review-note').value,
    decision: id('review-decision').value, confirmed: true,
  };
  record.busy = true;
  setReviewControls();
  let saved;
  try {
    saved = await api('/api/review', input);
    const createdReviewId = saved.createdIds?.reviewId;
    const confirmedRecord = typeof createdReviewId === 'string' && saved.snapshot?.reviews?.find(({ id }) => id === createdReviewId);
    if (!saved.report || saved.committed !== true || !confirmedRecord ||
        saved.snapshot.boardId !== input.boardId || saved.snapshot.generation !== record.base.snapshot.generation ||
        saved.snapshot.revision !== record.base.snapshot.revision + 1 ||
        saved.version !== saved.snapshot.generation + ':' + saved.snapshot.revision ||
        confirmedRecord.taskId !== input.taskId || confirmedRecord.decision !== input.decision ||
        confirmedRecord.generation !== saved.snapshot.generation) {
      throw new Error('The review response was incomplete.');
    }
  } catch (error) {
    saved = undefined;
    id('review-confirm').checked = false;
    if (error instanceof RequestFailure && error.code === 'REVISION_CONFLICT' && error.current) {
      record.mode = 'blocked';
      accept(error.current);
      reviewSavedHistory(record, confirmed);
      reviewMessage('The board changed. Close this review and reopen it to confirm against the latest revision.');
    } else if (error instanceof RequestFailure && (error.code === 'RECOVERY_REQUIRED' || error.status === 401)) {
      record.mode = 'blocked';
      handleReadFailure(error);
      reviewMessage(error.message + ' Copy your review text before closing.');
    } else if (!(error instanceof RequestFailure) || error.code === 'IO_OUTCOME_UNKNOWN' ||
        error.code === 'INVALID_RESPONSE' || error.status === 408) {
      writeHold = true;
      invalidatePublic('Refresh the saved board before preparing another public preview.', true);
      record.mode = 'unknown';
      reviewMessage('The response was lost. Check the saved review history; this submission cannot be confirmed.');
    } else {
      reviewMessage(error.message + (error.code === 'LIMIT_REACHED'
        ? ' Download the full current backup and see the review cycle instructions. If one review still cannot fit, split the board.' : ''));
    }
  } finally {
    record.busy = false;
    setReviewControls();
  }
  if (saved) {
    accept(saved);
    closeReview();
    notice('Saved review at revision ' + saved.snapshot.revision + '.');
  }
}

async function refreshReviewHistory() {
  const record = reviewForm;
  if (!record || record.busy || record.mode !== 'unknown') return;
  record.busy = true;
  setReviewControls();
  try {
    const fresh = await api('/api/board');
    if (!fresh.initialized || fresh.snapshot.boardId !== record.base.snapshot.boardId) {
      reviewMessage('The original board could not be confirmed. Keep your draft and check the host.');
      return;
    }
    accept(fresh);
    reviewSavedHistory(record, confirmed);
    record.mode = 'blocked';
    writeHold = false;
    reviewMessage('The response was lost. Check the saved review history; this submission cannot be confirmed.' +
      (fresh.version === record.base.version ? ' No change is visible at this read.' : '') +
      ' Close this review and reopen it before submitting another decision.');
  } catch (error) {
    if (error instanceof RequestFailure && (error.code === 'RECOVERY_REQUIRED' || error.status === 401)) {
      record.mode = 'blocked';
      handleReadFailure(error);
    }
    reviewMessage('Saved review history could not be read. ' + (error instanceof RequestFailure ? error.message : 'Host unavailable.'));
  } finally {
    record.busy = false;
    setReviewControls();
  }
}

function textField(key, label, max, options = {}) {
  return { key, label, max, ...options };
}

function choice(key, label, values, options = {}) {
  return { key, label, values: values.map((value) => typeof value === 'string' ? [value, value] : value), ...options };
}

function references(key, label, records, emptyLabel) {
  return choice(key, label, [['', emptyLabel], ...records.map((item) => [item.id, item.title])], { nullable: true });
}

function many(key, label, records) {
  return choice(key, label, records.map((item) => [item.id, item.title]), { multiple: true });
}

function specification(kind, target, state) {
  const { snapshot } = state;
  const evidenceRefs = many('evidenceIds', 'Evidence references', snapshot.evidence);
  const task = snapshot.tasks.find((item) => item.id === (typeof target === 'object' && target !== null ? target.taskId : target));
  switch (kind) {
    case 'project.edit':
      return {
        title: 'Edit project', saved: snapshot.project, fields: [
          textField('name', 'Project name', 200, { required: true }),
          textField('goal', 'Goal', 16000, { area: true }),
          choice('stage', 'Stage', stages),
          references('focusTaskId', 'Focus task', snapshot.tasks, 'None selected'),
          textField('nextActions', 'Next actions', 500, { listLimit: 3, item: 'Next action' }),
        ],
      };
    case 'milestone.add':
    case 'milestone.edit':
    case 'workstream.add':
    case 'workstream.edit': {
      const [group, action] = kind.split('.');
      const adding = action === 'add';
      const entries = group === 'milestone' ? snapshot.milestones : snapshot.workstreams;
      const saved = adding ? { title: '' } : entries.find((item) => item.id === target);
      if (!saved) return null;
      return { title: (adding ? 'Add ' : 'Edit ') + group, saved, fields: [textField('title', 'Title', 200, { required: true })] };
    }
    case 'task.add':
    case 'task.edit': {
      const adding = kind === 'task.add';
      const saved = adding ? {
        title: '', description: '', owner: '', priority: 'P1', status: 'Planned',
        milestoneId: milestone || null, workstreamId: workstream || null, prerequisites: [], blockers: [], evidenceIds: [],
      } : task;
      if (!saved) return null;
      return { title: adding ? 'Add task' : 'Edit task', saved, fields: [
        textField('title', 'Task title', 200, { required: true }),
        textField('description', 'Description', 16000, { area: true }),
        textField('owner', 'Owner', 200),
        choice('status', 'Status', statuses),
        choice('priority', 'Priority', ['P0', 'P1', 'P2']),
        references('milestoneId', 'Milestone', snapshot.milestones, 'Unassigned'),
        references('workstreamId', 'Workstream', snapshot.workstreams, 'Unassigned'),
        many('prerequisites', 'Prerequisites', snapshot.tasks.filter((item) => item.id !== target)),
        textField('blockers', 'Blockers', 1000, { listLimit: 20, item: 'Blocker' }),
        evidenceRefs,
      ] };
    }
    case 'criterion.add':
    case 'criterion.edit': {
      const adding = kind === 'criterion.add';
      if (!task) return null;
      const saved = adding ? { requirement: '', evidenceIds: [] } : task.criteria.find((item) => item.id === target.id);
      if (!saved) return null;
      return { title: adding ? 'Add criterion' : 'Edit criterion', saved, fields: [
        textField('requirement', 'Requirement', 2000, { area: true, required: true }), evidenceRefs,
      ] };
    }
    case 'evidence.add':
      if (target && !task) return null;
      return {
        title: 'Add evidence', note: task ? 'Links to task: ' + task.title : '', saved: { title: '', scope: 'local', outcome: 'not-run', location: '', supersedesId: null },
        fields: [
          textField('title', 'Title', 200, { required: true }),
          choice('scope', 'Scope', ['source', 'unit', 'local', 'assistant', 'remote', 'public']),
          choice('outcome', 'Outcome', ['passed', 'failed', 'unknown', 'not-run']),
          textField('location', 'Reference', 2048),
          references('supersedesId', 'Corrects', snapshot.evidence, 'No earlier record'),
        ],
      };
  }
  return null;
}

function listControl(field) {
  const label = node('legend', '', field.label);
  const rows = node('div', 'list-rows');
  const add = button('Add ' + field.item.toLowerCase(), () => addRow('').focus());
  const container = node('fieldset', 'list-field', label, rows, add);
  container.id = 'field-' + field.key;

  let locked = false;

  function renumber() {
    [...rows.children].forEach((row, index) => {
      const area = row.querySelector('textarea');
      const rowLabel = row.querySelector('label');
      rowLabel.htmlFor = area.id = 'field-' + field.key + '-' + index;
      rowLabel.firstChild.textContent = field.item + ' ' + (index + 1);
      area.readOnly = locked;
      const remove = row.querySelector('button');
      remove.disabled = locked;
      remove.setAttribute('aria-label', 'Remove ' + field.item.toLowerCase() + ' ' + (index + 1));
    });
    add.disabled = locked || rows.children.length >= field.listLimit;
  }

  function addRow(value) {
    const area = node('textarea', '');
    area.rows = 2;
    area.maxLength = field.max;
    area.value = value;
    const rowLabel = node('label', '', field.item, area);
    const remove = button('Remove', () => {
      const neighbor = row.nextElementSibling ?? row.previousElementSibling;
      row.remove();
      renumber();
      (neighbor?.querySelector('textarea') ?? add).focus();
    });
    const row = node('div', 'list-row', rowLabel, remove);
    rows.append(row);
    renumber();
    return area;
  }

  return {
    element: container,
    first: () => rows.querySelector('textarea') ?? add,
    disable: (disabled) => { locked = disabled; renumber(); },
    read: () => [...rows.querySelectorAll('textarea')].map((area) => area.value),
    set: (values) => {
      rows.replaceChildren();
      for (const value of values) addRow(value);
      renumber();
    },
  };
}

function fieldControl(field) {
  if (field.listLimit) return listControl(field);
  const input = node(field.values ? 'select' : field.area ? 'textarea' : 'input', '');
  input.id = 'field-' + field.key;
  if (field.max) input.maxLength = field.max;
  if (field.required) input.required = true;
  if (field.area) input.rows = 4;
  if (field.values) {
    for (const [value, label] of field.values) {
      const option = node('option', '', label);
      option.value = value;
      input.append(option);
    }
    if (field.multiple) {
      input.multiple = true;
      input.size = Math.min(6, Math.max(2, field.values.length));
    }
  }
  const label = node('label', '', field.label);
  label.htmlFor = input.id;
  const help = field.multiple ? node('small', '', 'Use Ctrl or Shift to select more than one reference.') : null;
  if (help) {
    help.id = input.id + '-help';
    input.setAttribute('aria-describedby', help.id);
  }
  return {
    element: node('div', 'field', label, input, help),
    first: () => input,
    disable: (disabled) => {
      if (field.values) input.disabled = disabled;
      else input.readOnly = disabled;
    },
    read: () => field.multiple ? [...input.selectedOptions].map((option) => option.value).sort()
      : field.nullable && input.value === '' ? null : input.value,
    set: (value) => {
      if (field.multiple) {
        const selected = new Set(value);
        for (const option of input.options) option.selected = selected.has(option.value);
      } else {
        input.value = value ?? '';
      }
    },
  };
}

function editorValues(record) {
  return Object.fromEntries([...record.controls].map(([key, control]) => [key, control.read()]));
}

function changedFields(record, values) {
  return Object.fromEntries(Object.entries(values).filter(([key, value]) =>
    JSON.stringify(value) !== JSON.stringify(record.baseline[key])));
}

function editorDirty() {
  return !!editor && Object.keys(changedFields(editor, editorValues(editor))).length > 0;
}

function clearErrors() {
  id('form-errors').hidden = true;
  for (const control of editor?.controls.values() ?? []) control.first().removeAttribute('aria-invalid');
}

function formErrors(messages, paths = [], title = 'Check your entries') {
  id('errors-title').textContent = title;
  id('error-list').replaceChildren(...messages.map((message) => node('li', '', message)));
  for (const [key, control] of editor.controls) {
    if (paths.some((path) => path.split(/[.\[]/).includes(key))) control.first().setAttribute('aria-invalid', 'true');
  }
  id('form-errors').hidden = false;
  id('errors-title').focus();
}

function setEditorControls() {
  const locked = editor.busy || editor.mode !== 'edit';
  for (const control of editor.controls.values()) control.disable(locked);
  id('save').disabled = locked;
  id('close-editor').disabled = editor.busy;
  id('check-outcome').hidden = editor.mode !== 'unknown';
  id('check-outcome').disabled = editor.busy;
}

function buildEditor(record, carried = {}) {
  id('edit-title').textContent = record.spec.title;
  id('edit-version').textContent = 'Opened at revision ' + record.base.snapshot.revision + (record.spec.note ? ' · ' + record.spec.note : '');
  record.controls = new Map(record.spec.fields.map((field) => [field.key, fieldControl(field)]));
  for (const [key, control] of record.controls) control.set(record.spec.saved[key]);
  record.baseline = editorValues(record);
  for (const [key, value] of Object.entries(carried)) record.controls.get(key)?.set(value);
  id('fields').replaceChildren(...[...record.controls.values()].map((control) => control.element));
  id('comparison').hidden = true;
  clearErrors();
  setEditorControls();
}

function openEditor(kind, target, trigger) {
  if (editor || reviewForm || checking || preparing || quitting || !confirmed || screen !== 'board') return;
  if (writeHold) {
    notice('Refresh the saved board and compare it before opening another edit.', true);
    return;
  }
  const spec = specification(kind, target, confirmed);
  if (!spec) return;
  editor = { kind, target, base: confirmed, spec, trigger: focusReference(trigger), mode: 'edit', busy: false };
  invalidatePublic('Prepare a new public preview after closing the editor.');
  buildEditor(editor);
  id('edit-dialog').showModal();
  editor.controls.values().next().value.first().focus();
}

function closeEditor({ restore = true, ask = true } = {}) {
  if (!editor || editor.busy) return;
  if (ask && editorDirty() && !confirm('Discard your unsaved draft?')) return;
  const trigger = editor.trigger;
  editor = null;
  updatePublicControls();
  id('edit-dialog').close();
  if (screen !== 'board') clearBoardView();
  if (restore) restoreFocus(trigger);
}

function operation(record, values) {
  const { kind, target } = record;
  const fields = kind.endsWith('.add') ? values : changedFields(record, values);
  switch (kind) {
    case 'project.edit': return { type: kind, fields };
    case 'task.add': return { type: kind, fields };
    case 'evidence.add': return target ? { type: kind, fields, taskId: target } : { type: kind, fields };
    case 'task.edit': return { type: kind, id: target, fields };
    case 'milestone.add':
    case 'workstream.add': return { type: kind, title: values.title };
    case 'milestone.edit':
    case 'workstream.edit': return { type: kind, id: target, title: values.title };
    case 'criterion.add': return { type: kind, taskId: target, requirement: values.requirement, evidenceIds: values.evidenceIds };
    case 'criterion.edit': return { type: kind, taskId: target.taskId, id: target.id, fields };
  }
  throw new Error('Unexpected edit operation');
}

function checkFields(record, values) {
  const invalid = [];
  for (const field of record.spec.fields) {
    const value = values[field.key];
    const tooLong = typeof value === 'string' && field.max && value.length > field.max;
    if ((field.required && !value) || tooLong ||
        (field.listLimit && value.some((item) => item.length === 0 || item.length > field.max))) {
      invalid.push(field);
    }
  }
  return invalid;
}

function valueText(value, field) {
  if (value === undefined || value === null || value === '') return '—';
  const resolve = (item) => field.values?.find(([key]) => key === item)?.[1] ?? item;
  return Array.isArray(value) ? value.map(resolve).join('\n') || '—' : resolve(value);
}

function sameBoard(left, right) {
  return left.snapshot.boardId === right.snapshot.boardId && left.snapshot.generation === right.snapshot.generation;
}

function matchingAdditions(record, fresh, draft) {
  const { snapshot } = fresh;
  switch (record.kind) {
    case 'task.add': return snapshot.tasks.filter((item) => item.title === draft.title);
    case 'milestone.add': return snapshot.milestones.filter((item) => item.title === draft.title);
    case 'workstream.add': return snapshot.workstreams.filter((item) => item.title === draft.title);
    case 'evidence.add': return snapshot.evidence.filter((item) => item.title === draft.title);
    case 'criterion.add': return snapshot.tasks.find((item) => item.id === record.target)?.criteria
      .filter((item) => item.requirement === draft.requirement) ?? [];
    default: return [];
  }
}

function compareWith(record, fresh) {
  const values = editorValues(record);
  const adding = record.kind.endsWith('.add');
  const carried = adding ? values : changedFields(record, values);
  const replacement = sameBoard(record.base, fresh) ? specification(record.kind, record.target, fresh) : null;
  record.mode = 'compare';
  record.comparison = { fresh, replacement, carried };
  clearErrors();
  const header = node('tr', '', ...['Field', 'Current values', 'Your draft'].map((label) => {
    const th = node('th', '', label);
    th.scope = 'col';
    return th;
  }));
  const rows = record.spec.fields.filter((field) => Object.hasOwn(carried, field.key)).map((field) => node('tr', '',
    node('td', '', field.label), node('td', 'preserve', adding ? 'New record' : valueText(replacement?.saved[field.key], field)),
    node('td', 'preserve', valueText(carried[field.key], field)),
  ));
  const matches = adding ? matchingAdditions(record, fresh, values) : [];
  id('compare-values').replaceChildren(
    node('p', '', 'Saved revision ' + fresh.snapshot.revision + '. Review both values before reapplying.'),
    matches.length ? node('div', '', node('p', '', 'Matching records are already on the saved board.'),
      listText(matches.map((item) => (item.title ?? item.requirement) + ' · ' + item.id), '')) : null,
    node('table', '', node('thead', '', header), node('tbody', '', ...rows)),
    replacement ? null : node('p', '', 'This edit cannot be reapplied to the saved board.'),
  );
  id('reapply-draft').disabled = !replacement;
  id('comparison').hidden = false;
  setEditorControls();
  id('comparison-title').focus();
}

function applyComparison(reapply) {
  if (!editor || editor.mode !== 'compare' || editor.busy) return;
  const { fresh, replacement, carried } = editor.comparison;
  if (!reapply && !confirm('Discard your draft and reload the saved board?')) return;
  if (reapply && !replacement) return;
  accept(fresh);
  writeHold = false;
  if (reapply) {
    editor.base = fresh;
    editor.spec = replacement;
    editor.mode = 'edit';
    editor.comparison = undefined;
    buildEditor(editor, carried);
    editor.controls.values().next().value.first().focus();
  } else {
    closeEditor({ ask: false });
  }
}

async function saveEditor(event) {
  event.preventDefault();
  if (!editor || editor.busy || editor.mode !== 'edit') return;
  const record = editor;
  clearErrors();
  const values = editorValues(record);
  const invalid = checkFields(record, values);
  if (invalid.length) {
    formErrors(invalid.map((field) => 'Check ' + field.label.toLowerCase() + '.'), invalid.map((field) => field.key));
    return;
  }
  if (record.kind.endsWith('.edit') && !Object.keys(changedFields(record, values)).length) {
    formErrors(['Change a field before saving.']);
    return;
  }
  record.busy = true;
  setEditorControls();
  let saved;
  try {
    saved = await api('/api/change', {
      boardId: record.base.snapshot.boardId, expectedVersion: record.base.version, operation: operation(record, values),
    });
  } catch (error) {
    if (error instanceof RequestFailure && error.code === 'REVISION_CONFLICT' && error.current) {
      compareWith(record, error.current);
    } else if (error instanceof RequestFailure && error.code === 'RECOVERY_REQUIRED') {
      enterRecovery(error);
      record.mode = 'blocked';
      formErrors([error.message, 'Copy any unsaved text you need before closing this edit.'], [], 'Recovery required');
    } else if (error instanceof RequestFailure && error.status === 401) {
      accessPanel();
      record.mode = 'blocked';
      formErrors(['The session is unavailable. Copy any unsaved text before closing this edit.'], [], 'Session unavailable');
    } else if (!(error instanceof RequestFailure) || error.code === 'IO_OUTCOME_UNKNOWN' || error.code === 'INVALID_RESPONSE') {
      writeHold = true;
      invalidatePublic('Refresh the saved board before preparing another public preview.', true);
      record.mode = 'unknown';
      formErrors(['The save outcome is unknown. Compare the saved board before making another change.'], [], 'Check the saved board');
    } else {
      const title = error.code === 'IO_NOT_COMMITTED' ? 'Save refused' : 'Check your entries';
      formErrors([error.message, ...error.fields], error.fields, title);
    }
  } finally {
    record.busy = false;
    setEditorControls();
  }
  if (saved) {
    accept(saved);
    closeEditor({ ask: false });
    notice(saved.committed ? 'Saved revision ' + saved.snapshot.revision + '.' : 'The saved board already matches this edit.');
  }
}

async function checkOutcome() {
  if (!editor || editor.busy || editor.mode !== 'unknown') return;
  const record = editor;
  record.busy = true;
  setEditorControls();
  try {
    const fresh = await api('/api/board');
    if (!fresh.initialized) {
      formErrors(['The saved board could not be validated. Confirm shutdown and restart before making another change.'], [], 'Restart required');
      return;
    }
    compareWith(record, stateFrom(fresh));
  } catch (error) {
    if (error instanceof RequestFailure && error.code === 'RECOVERY_REQUIRED') {
      enterRecovery(error);
      record.mode = 'blocked';
      formErrors([error.message], [], 'Recovery required');
    } else if (error instanceof RequestFailure && error.status === 401) {
      accessPanel();
      record.mode = 'blocked';
      formErrors(['Open the existing tab or restart the host.'], [], 'Session unavailable');
    } else {
      formErrors([error instanceof RequestFailure ? error.message : 'Host unavailable'], [], 'Saved board could not be checked');
    }
  } finally {
    record.busy = false;
    setEditorControls();
  }
}

function setInitControls() {
  for (const control of id('initialization').querySelectorAll('form input, form select, form button, #create-sample')) {
    control.disabled = initializing || initUnknown;
  }
  id('check-initialization').hidden = !initUnknown;
  const continuing = id('import-identity').value === 'continue';
  id('continue-confirm-label').hidden = !continuing;
  id('continue-confirm').disabled = !continuing || initializing || initUnknown;
  id('continue-confirm').required = continuing;
  if (!continuing) id('continue-confirm').checked = false;
}

async function initialize(buildInput) {
  if (initializing || initUnknown || checking) return;
  initializing = true;
  setInitControls();
  try {
    const input = await buildInput();
    try {
      const saved = await api('/api/initialize', input);
      accept(saved);
      id('blank-form').reset();
      id('import-form').reset();
      id('project-name').focus();
      notice('Saved revision ' + saved.snapshot.revision + '.');
    } catch (error) {
      if (error instanceof RequestFailure && error.code === 'ALREADY_EXISTS') {
        initUnknown = true;
        notice('A board already exists. Check the saved board before trying to initialize again.', true);
      } else if (!(error instanceof RequestFailure) || error.code === 'IO_OUTCOME_UNKNOWN' || error.code === 'INVALID_RESPONSE') {
        initUnknown = true;
        notice('The initialization outcome is unknown. Check the saved board before continuing.', true);
      } else if (input.kind === 'import' && error.code === 'LIMIT_REACHED') {
        notice(error.message + ' Keep the original backup. Reduce editable content in the retained original board and export again before retrying the import.', true);
      } else {
        handleReadFailure(error);
      }
    }
  } catch (error) {
    notice(error instanceof Error ? error.message : 'The backup could not be read.', true);
  } finally {
    initializing = false;
    setInitControls();
  }
}

function initiateDownload(text, name, mediaType) {
  const url = URL.createObjectURL(new Blob([text], { type: mediaType + ';charset=utf-8' }));
  const link = node('a', '');
  link.href = url;
  link.download = name;
  document.body.append(link);
  try { link.click(); } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}


const publicFormats = [
  { key: 'html', label: 'HTML', name: 'glance-public.html', mediaType: 'text/html' },
  { key: 'markdown', label: 'Markdown', name: 'glance-public.md', mediaType: 'text/markdown' },
  { key: 'publicJson', label: 'JSON', name: 'glance-public.json', mediaType: 'application/json' },
];
const publicGroups = [
  ['tasks', 'Tasks', 'Task'], ['milestones', 'Milestones', 'Milestone'], ['workstreams', 'Workstreams', 'Workstream'],
];
const publicCountLabels = [
  ['tasks', 'Tasks'], ['open', 'Open'], ['accepted', 'Owner-recorded acceptance'], ['inProgress', 'In progress'],
  ['blocked', 'Blocked'], ['needsReview', 'Needs review'], ['stale', 'Stale reviews'], ['changesRequested', 'Changes requested'],
];
const publicReviewNames = { accepted: 'Accepted', stale: 'Stale', 'changes-requested': 'Changes requested', unreviewed: 'Unreviewed' };
const publicFormat = 'kitflint.glance.public.v1';
const publicEncoder = new TextEncoder();
const publicRequestLimit = 128 * 1024;
let publicDraft = genericPublicDraft();
let publicPackage = null;
let publicConfirmed = null;
let publicGeneration = 0;
let publicBusy = false;

function genericPublicDraft() {
  return { project: null, tasks: [], milestones: [], workstreams: [] };
}

function publicMessage(text = '', error = false) {
  id('public-status').textContent = text;
  id('public-status').dataset.tone = error ? 'error' : 'normal';
}

function publicAvailable() {
  return screen === 'board' && token !== null && confirmed !== null && !id('public-report').hidden &&
    !editor && !reviewForm && !writeHold && !quitting && !checking;
}

function updatePublicControls() {
  const enabled = publicAvailable() && !publicBusy;
  id('prepare-public-report').disabled = !enabled;
  const confirm = id('confirm-public-report');
  confirm.disabled = !enabled || publicPackage === null;
  confirm.checked = publicPackage !== null && publicConfirmed === publicPackage;
  for (const control of id('public-downloads').querySelectorAll('button')) control.disabled = !enabled || !confirm.checked;
}

function invalidatePublic(message = '', error = false) {
  publicGeneration++;
  publicBusy = false;
  publicPackage = publicConfirmed = null;
  id('public-preview').hidden = true;
  id('public-preview-content').replaceChildren();
  id('public-downloads').replaceChildren();
  publicMessage(message, error);
  updatePublicControls();
}

function publicDraftChanged() {
  const needsPreview = publicPackage || publicBusy;
  invalidatePublic(needsPreview ? 'Labels changed. Prepare a new public preview.' : '');
}

function renderPublicLabels() {
  const inputFor = (name, value, change) => {
    const input = node('textarea', '');
    input.rows = 1;
    input.maxLength = 200;
    input.placeholder = name;
    input.value = value ?? '';
    const feedback = node('small', '', 'Use a label without line breaks or control characters.');
    const validate = (draft) => {
      const invalid = draft !== '' && !isPublicLabel(draft);
      feedback.hidden = !invalid;
      if (invalid) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
    };
    validate(value ?? '');
    input.addEventListener('input', () => {
      change(input.value);
      validate(input.value);
      publicDraftChanged();
    });
    return node('div', '', node('label', '', name, input), feedback);
  };
  const fields = id('public-labels');
  const open = new Set([...fields.querySelectorAll('details[open]')].map((detail) => detail.dataset.group));
  fields.replaceChildren(inputFor('Project readiness', publicDraft.project, (value) => { publicDraft.project = value || null; }));
  for (const [key, title, generic] of publicGroups) {
    const existing = new Map(publicDraft[key].map((entry) => [entry.id, entry.label]));
    const rows = confirmed.snapshot[key];
    const details = node('details', '', node('summary', '', title + ' (' + rows.length + ')'));
    details.dataset.group = key;
    details.open = open.has(key);
    if (!rows.length) details.append(node('p', 'muted', 'No ' + title.toLowerCase() + ' recorded.'));
    for (const [index, entry] of rows.entries()) {
      const label = generic + ' ' + (index + 1);
      details.append(inputFor(label, existing.get(entry.id), (value) => {
        if (value) existing.set(entry.id, value);
        else existing.delete(entry.id);
        publicDraft[key] = [...existing].map(([key, label]) => ({ id: key, label }));
      }));
    }
    fields.append(details);
  }
}

function setPublicPanel(open, restoreFocus = false) {
  id('public-report').hidden = !open;
  id('open-public-report').setAttribute('aria-expanded', String(open));
  if (open) {
    renderPublicLabels();
    updatePublicControls();
    id('public-report-title').focus();
  } else {
    invalidatePublic();
    id('public-labels').replaceChildren();
    if (restoreFocus) id('open-public-report').focus();
  }
}

function useCurrentPublicNames() {
  if (!publicAvailable()) return;
  const { snapshot, version } = confirmed;
  const candidate = { project: snapshot.project.name, tasks: [], milestones: [], workstreams: [] };
  for (const [key] of publicGroups) candidate[key] = snapshot[key].map((row) => ({ id: row.id, label: row.title }));
  if (publicEncoder.encode(JSON.stringify({ expectedVersion: version, labels: candidate })).byteLength > publicRequestLimit) {
    publicMessage('Current names exceed the public preview request limit. Keep generic labels or enter fewer names.', true);
    return;
  }
  publicDraft = candidate;
  publicDraftChanged();
  renderPublicLabels();
  publicMessage('Current names loaded for review. Check each label and remove any private information.');
}

function exactPublicKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isPublicLabel(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 200 && !/[\x00-\x1f\x7f-\x9f]/.test(value);
}

function publicInteger(value, max) {
  return Number.isInteger(value) && value >= 0 && value <= max;
}

function publicDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) && date.toISOString() === value;
}

function publicReportShape(report, capture) {
  if (!exactPublicKeys(report, ['format', 'project', 'captured', 'counts', 'focusTaskId', 'milestones', 'workstreams', 'tasks']) ||
      report.format !== publicFormat || !exactPublicKeys(report.project, ['label', 'stage']) ||
      !isPublicLabel(report.project.label) || !stages.includes(report.project.stage) ||
      !exactPublicKeys(report.captured, ['revision', 'updatedAt', 'preparedAt']) ||
      report.captured.revision !== capture.revision || !publicDate(report.captured.updatedAt) || !publicDate(report.captured.preparedAt) ||
      report.captured.updatedAt !== new Date(capture.updatedAt).toISOString() ||
      !exactPublicKeys(report.counts, publicCountLabels.map(([key]) => key)) ||
      !Object.values(report.counts).every((value) => publicInteger(value, 1000))) return false;
  const groups = (items, prefix) => Array.isArray(items) && items.length <= 100 && items.every((group, index) =>
    exactPublicKeys(group, ['id', 'label', 'total', 'accepted']) && group.id === prefix + (index + 1) &&
    isPublicLabel(group.label) && publicInteger(group.total, 1000) && publicInteger(group.accepted, group.total));
  if (!groups(report.milestones, 'm') || !groups(report.workstreams, 'w') ||
      !Array.isArray(report.tasks) || report.tasks.length > 1000 || report.tasks.length !== report.counts.tasks) return false;
  const tasks = new Set(report.tasks.map((_, index) => 't' + (index + 1)));
  const milestones = new Set(report.milestones.map(({ id }) => id));
  const workstreams = new Set(report.workstreams.map(({ id }) => id));
  return (report.focusTaskId === null || tasks.has(report.focusTaskId)) && report.tasks.every((task, index) =>
    exactPublicKeys(task, ['id', 'label', 'priority', 'status', 'review', 'milestoneId', 'workstreamId', 'prerequisites',
      'criterionCount', 'evidenceCount', 'blockerCount']) &&
    task.id === 't' + (index + 1) && isPublicLabel(task.label) && ['P0', 'P1', 'P2'].includes(task.priority) &&
    statuses.includes(task.status) && Object.hasOwn(publicReviewNames, task.review) &&
    (task.milestoneId === null || milestones.has(task.milestoneId)) && (task.workstreamId === null || workstreams.has(task.workstreamId)) &&
    Array.isArray(task.prerequisites) && task.prerequisites.length < tasks.size &&
    task.prerequisites.every((key) => key !== task.id && tasks.has(key)) &&
    new Set(task.prerequisites).size === task.prerequisites.length &&
    publicInteger(task.criterionCount, 20) && publicInteger(task.evidenceCount, 2000) && publicInteger(task.blockerCount, 20));
}

async function validatePublicPackage(result, state) {
  const keys = publicFormats.map(({ key }) => key);
  if (!exactPublicKeys(result, ['ok', 'version', 'report', 'sha256', ...keys]) || result.version !== state.version ||
      !publicReportShape(result.report, state.snapshot) || !exactPublicKeys(result.sha256, keys) ||
      keys.some((key) => typeof result[key] !== 'string' || result[key].length === 0 ||
        typeof result.sha256[key] !== 'string' || !/^[0-9a-f]{64}$/.test(result.sha256[key])) ||
      !result.publicJson.endsWith('\n') || JSON.stringify(JSON.parse(result.publicJson)) !== JSON.stringify(result.report)) {
    throw new Error('The public preview response could not be verified.');
  }
  for (const key of keys) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', publicEncoder.encode(result[key])));
    const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
    if (hex !== result.sha256[key]) throw new Error('The public preview file hashes did not match.');
  }
}

function renderPublicPreview(pack) {
  const report = pack.files.report;
  const disclosure = (title, ...items) => node('details', '', node('summary', '', title), ...items);
  const values = (pairs) => node('dl', '', ...pairs.flatMap(([label, value]) =>
    [node('dt', '', label), node('dd', '', String(value))]));
  const groups = (title, entries) => disclosure(title + ' (' + entries.length + ')',
    ...(entries.length ? entries.map((entry) => node('p', '', entry.id + ' · ' + entry.label + ' · ' +
      entry.accepted + ' of ' + entry.total + ' tasks accepted')) : [node('p', 'muted', 'No groups recorded.')]));
  const group = (items, key) => {
    const match = items.find((item) => item.id === key);
    return match ? match.id + ' · ' + match.label : 'Unassigned';
  };
  const tasks = report.tasks.map((task) => disclosure(task.id + ' · ' + task.label, values([
    ['Workflow', task.status], ['Human review', publicReviewNames[task.review]], ['Priority', task.priority],
    ['Milestone', group(report.milestones, task.milestoneId)], ['Workstream', group(report.workstreams, task.workstreamId)],
    ['Prerequisites', task.prerequisites.join(', ') || 'None'], ['Criteria', task.criterionCount],
    ['Evidence references unique within this task', task.evidenceCount], ['Blockers', task.blockerCount],
  ])));
  const focus = report.tasks.find((task) => task.id === report.focusTaskId);
  id('public-preview-content').replaceChildren(
    values([['Project', report.project.label], ['Declared stage', report.project.stage], ['Saved revision', report.captured.revision],
      ['Updated', report.captured.updatedAt], ['Prepared', report.captured.preparedAt],
      ['Current focus', focus ? focus.id + ' · ' + focus.label : 'No focus selected']]),
    node('p', 'muted', 'Owner-recorded acceptance; proof is withheld from this public report. Counts measure tasks, not effort or project completion percentage. The declared stage is not proof of public release.'),
    node('p', 'muted', 'Criteria, evidence and blocker contents are withheld. The report includes counts and task relationships.'),
    values(publicCountLabels.map(([key, label]) => [label, report.counts[key]])),
    groups('Milestones', report.milestones), groups('Workstreams', report.workstreams),
    disclosure('Tasks (' + tasks.length + ')', ...(tasks.length ? tasks : [node('p', 'muted', 'No tasks recorded.')])),
    disclosure('Public data', node('pre', '', pack.files.publicJson)),
    values(publicFormats.map(({ key, name }) => [name + ' · SHA-256', pack.files.sha256[key]])),
  );
  id('public-downloads').replaceChildren(...publicFormats.map((format) =>
    button('Download public ' + format.label, () => { void verifyPublicFreshness(format); })));
  id('public-preview').hidden = false;
}

function publicIdentity(pack) {
  return publicAvailable() && publicGeneration === pack.generation && token === pack.token &&
    confirmed.version === pack.version && JSON.stringify(publicDraft) === pack.draft;
}


const githubKinds = [
  ['issues', 'Issues'], ['pull-requests', 'Pull requests'], ['workflow-runs', 'Workflow runs'],
  ['releases', 'Releases'], ['pull-request-reviews', 'Pull request reviews'],
];
const githubFactKinds = [
  ['pull-request', 'Pull requests'], ['workflow-run', 'Workflow runs'], ['release', 'Releases'],
  ['pull-request-review', 'Pull request reviews'],
];
const githubFinished = new Set(['succeeded', 'cancelled', 'failed']);
let githubView = null;
let githubOperation = null;
let githubTimer;
let githubPanelEpoch = 0;
let githubOverviewRequest = 0;
let githubLoading = false;
let githubBusy = false;
let githubRetire = null;
let githubPublicationFocus = '';
let githubPendingPreviewId = null;

async function invalidateGithubPreview(operationId) {
  if (!operationId || !token) return;
  try { await api('/api/github/preview-invalidate', { operationId }); }
  catch { /* A later preview still requires a current saved version and operation ID. */ }
}

function githubLink(label, url) {
  if (typeof url !== 'string' || !/^https:\/\/github\.com\/(?:login\/device|settings\/installations|new|apps\/[A-Za-z0-9-]{1,100}\/installations\/new)$/.test(url)) return null;
  const link = node('a', '', label);
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  return link;
}

function githubMessage(message = '') { id('github-message').textContent = message; }

function setGithubPanel(open, focus = false) {
  const panel = id('github-panel');
  panel.hidden = !open;
  id('open-github').setAttribute('aria-expanded', String(open));
  if (open) {
    if (focus) id('github-title').focus();
    void loadGithub();
    return;
  }
  if (githubOperation?.publication) void invalidateGithubPreview(githubOperation.operationId);
  else if (githubPendingPreviewId) void invalidateGithubPreview(githubPendingPreviewId);
  if (githubRetire) void invalidateGithubPreview(githubRetire.operationId);
  githubRetire = null;
  githubPendingPreviewId = null;
  githubPublicationFocus = '';
  githubPanelEpoch++;
  githubOverviewRequest++;
  githubLoading = false;
  clearTimeout(githubTimer);
  githubView = null;
  githubOperation = null;
  githubBusy = false;
  githubMessage();
  id('github-content').replaceChildren();
  if (focus) id('open-github').focus();
}

function githubVisible(epoch) { return epoch === githubPanelEpoch && !id('github-panel').hidden && !quitting; }

function githubError(error) {
  githubMessage(error instanceof RequestFailure ? error.message : 'The GitHub panel could not reach the local host.');
  if (error instanceof RequestFailure && (error.status === 401 || error.code === 'RECOVERY_REQUIRED')) handleReadFailure(error);
}

function overviewMatchesBoard(overview, board = confirmed) {
  return Boolean(overview && board && overview.boardId === board.snapshot.boardId && overview.version === board.version);
}

function olderGithubBoard(board) {
  const saved = confirmed.snapshot, incoming = board.snapshot;
  return incoming.boardId === saved.boardId && incoming.generation === saved.generation &&
    incoming.revision < saved.revision;
}

function acceptGithubBoard({ changed, boardChanged, fromGithubRead, refreshGithub }) {
  if (changed) {
    const preview = githubOperation?.publication;
    if (preview && preview.kind !== 'publishing' && (boardChanged || preview.version !== confirmed.version)) {
      const { operationId } = githubOperation;
      void invalidateGithubPreview(operationId);
      if (githubPendingPreviewId === operationId) githubPendingPreviewId = null;
      githubOperation = null;
    }
    if (githubRetire && (boardChanged || githubRetire.version !== confirmed.version)) {
      void invalidateGithubPreview(githubRetire.operationId);
      githubRetire = null;
    }
  }
  if (!fromGithubRead && (changed || refreshGithub) && githubVisible(githubPanelEpoch)) return loadGithub();
}

async function loadGithub(keepMessage = false) {
  const epoch = githubPanelEpoch;
  if (!confirmed || !githubVisible(epoch)) return;
  const request = ++githubOverviewRequest;
  let expectedBoard = { boardId: confirmed.snapshot.boardId, version: confirmed.version };
  const current = () => githubVisible(epoch) && request === githubOverviewRequest && overviewMatchesBoard(expectedBoard);
  githubLoading = true;
  githubView = null;
  clearTimeout(githubTimer);
  if (!keepMessage) githubMessage('Reading the saved GitHub state…');
  renderGithub();
  try {
    const view = await api('/api/github/overview', {});
    if (!current()) return;
    if (view.boardState !== 'READY') {
      githubMessage('Open an initialized board to use GitHub.');
      return;
    }
    if (!overviewMatchesBoard(view)) {
      const board = await api('/api/board');
      if (!current()) return;
      if (board.initialized && !olderGithubBoard(board)) {
        accept(board, { fromGithubRead: true });
        expectedBoard = { boardId: board.snapshot.boardId, version: board.version };
      }
    }
    if (!current()) return;
    if (!overviewMatchesBoard(view)) {
      githubMessage('The saved Board changed during this read. Refresh the saved GitHub state.');
      return;
    }
    githubView = view;
    githubOperation = view.operation;
    if (!keepMessage) githubMessage();
  } catch (error) {
    if (current()) githubError(error);
  } finally {
    if (current()) {
      githubLoading = false;
      renderGithub();
      scheduleGithub();
    }
  }
}

function scheduleGithub() {
  clearTimeout(githubTimer);
  if (githubLoading || githubBusy || !githubOperation || githubFinished.has(githubOperation.state)) return;
  const epoch = githubPanelEpoch, request = githubOverviewRequest;
  const operationId = githubOperation.operationId;
  const current = () => githubVisible(epoch) && request === githubOverviewRequest &&
    !githubBusy && githubOperation?.operationId === operationId;
  githubTimer = setTimeout(async () => {
    if (!current()) return;
    try {
      const operation = await api('/api/github/status', { operationId });
      if (!current()) return;
      const { ok, ...status } = operation;
      const changed = JSON.stringify(status) !== JSON.stringify(githubOperation);
      githubOperation = status;
      if (githubFinished.has(status.state) && githubView) await loadGithub();
      else if (changed) renderGithub();
      scheduleGithub();
    } catch (error) {
      if (!current()) return;
      if (error instanceof RequestFailure && error.code === 'PREVIEW_EXPIRED') {
        if (githubView) await loadGithub();
        else {
          githubOperation = null;
          renderGithub();
        }
      } else { githubError(error); scheduleGithub(); }
    }
  }, 1100);
}

function githubVersion({ view }) {
  return { boardId: view.boardId, expectedVersion: view.version };
}

function githubActionCurrent({ view, epoch }) {
  return githubVisible(epoch) && !githubLoading && view === githubView && overviewMatchesBoard(view);
}

function githubOperationCommand(epoch, operationId, route, payload = {}) {
  if (githubVisible(epoch) && githubOperation?.operationId === operationId) {
    return githubCommand(route, { operationId, ...payload });
  }
}

async function githubCommand(route, payload, { changesBoard = false, origin } = {}) {
  const epoch = githubPanelEpoch;
  if (githubBusy || !githubVisible(epoch) || editor || reviewForm || writeHold) return;
  if (Object.hasOwn(payload, 'expectedVersion') && (!origin || !githubActionCurrent(origin))) {
    if (!githubView && githubLoading) githubMessage('Reading the saved GitHub state…');
    return;
  }
  githubBusy = true;
  clearTimeout(githubTimer);
  githubMessage('Sending request…');
  try {
    const result = await api('/api/github/' + route, payload);
    if (!githubVisible(epoch)) {
      if (route === 'publish-preview' || route === 'publish-confirm' || route === 'reconcile-preview') {
        void invalidateGithubPreview(result.operationId);
      }
      return;
    }
    if (route === 'publish-preview' || route === 'reconcile-preview') {
      if (overviewMatchesBoard(origin.view)) githubPendingPreviewId = result.operationId;
      else void invalidateGithubPreview(result.operationId);
    }
    if (changesBoard && result.snapshot && result.snapshot.boardId === confirmed.snapshot.boardId &&
        result.snapshot.generation === confirmed.snapshot.generation && !olderGithubBoard(result)) {
      await accept(result, { refreshGithub: true });
    } else await loadGithub();
  } catch (error) {
    if (!githubVisible(epoch)) return;
    if (error instanceof RequestFailure && error.code === 'IO_OUTCOME_UNKNOWN') {
      writeHold = true;
      notice('The saved outcome is unknown. Refresh the board to check it before another change.', true);
    }
    githubError(error);
    if (error instanceof RequestFailure && error.code === 'REVISION_CONFLICT') await loadGithub(true);
    if (route === 'publish-preview' && githubVisible(epoch)) {
      id('github-content').querySelector('.github-publication input:not(:disabled)')?.focus();
    }
  } finally {
    if (githubVisible(epoch)) { githubBusy = false; scheduleGithub(); }
  }
}

function githubButton(label, key, action, className) {
  return button(label, action, className, 'github-' + key);
}

function githubCheckbox(label, value, onChange) {
  const input = node('input');
  input.type = 'checkbox';
  input.value = value;
  if (onChange) input.addEventListener('change', onChange);
  return node('label', 'check-row', input, ' ' + label);
}

function githubChooser(origin, operation) {
  const { view } = origin;
  const choices = node('section', '', node('h4', '', 'Select a repository'));
  const discover = (scope) => githubOperationCommand(origin.epoch, operation.operationId, 'discover', { scope });
  const page = operation.discovery;
  choices.append(node('div', 'actions',
    githubButton('Check again', 'check-installations', () => discover({ kind: 'installations', page: 1 })),
    githubLink('Install or request access', view.installationUrl),
    githubLink('Create a repository', view.createRepositoryUrl)));
  if (!operation.installations?.length && page?.kind !== 'repositories') {
    choices.append(node('p', 'muted', 'If access is pending, ask the organization administrator to approve the App on GitHub. Then choose Check again.'));
  }
  for (const installation of operation.installations ?? []) {
    choices.append(node('p', '', githubButton(installation.accountLogin + ' · ' + installation.accountType,
      'installation-' + installation.id, () => discover({ kind: 'repositories', installationId: installation.id, page: 1 }))));
  }
  if (page?.kind === 'repositories') {
    if (!operation.repositories?.length) {
      choices.append(node('p', 'muted', 'No accessible repositories on this page. Include the repository in the App installation, then check again.'));
    }
    for (const repo of operation.repositories ?? []) {
      const confirm = githubCheckbox('Use ' + repo.owner + '/' + repo.name + ' · ' + repo.visibility + ' · ID ' + repo.id, repo.id);
      const select = githubButton('Confirm repository', 'repository-' + repo.id, () => githubCommand('select',
        { ...githubVersion(origin), operationId: operation.operationId, repositoryId: repo.id }, { origin }), 'primary');
      select.disabled = true;
      confirm.firstElementChild.addEventListener('change', (event) => { select.disabled = !event.currentTarget.checked; });
      choices.append(node('div', 'github-choices', confirm, select));
    }
  }
  if (page?.moreAvailable && page.page < 1000) {
    const next = { kind: page.kind, page: page.page + 1 };
    if (page.kind === 'repositories') next.installationId = page.installationId;
    choices.append(githubButton('Next page', 'discovery-next', () => discover(next)));
  }
  return choices;
}

function githubScope(origin) {
  const { view } = origin;
  const form = node('form', '', node('h4', '', 'Refresh observations'));
  const kind = node('select');
  const pull = node('select');
  const pullLabel = node('label', '', 'Pull request', pull);
  const links = node('fieldset', '', node('legend', '', 'Linked issues to refresh (up to 8)'));
  const page = node('input');
  const pages = node('input');
  const submit = node('button', 'primary', 'Refresh selected scope');
  for (const [value, label] of githubKinds) kind.append(new Option(label, value));
  for (const fact of view.facts.filter((fact) => fact.kind === 'pull-request')) {
    pull.append(new Option('#' + fact.number + ' · ' + fact.state + (fact.baseRef ? ' · into ' + fact.baseRef : ''), fact.id));
  }
  for (const [field, max] of [[page, 1000], [pages, 3]]) {
    field.type = 'number';
    field.min = '1';
    field.max = String(max);
    field.value = '1';
    field.required = true;
  }
  for (const mapping of view.issues) links.append(githubCheckbox('#' + mapping.number + ' ' + mapping.local.title, mapping.localTaskId));
  function showScopeFields() {
    pullLabel.hidden = kind.value !== 'pull-request-reviews';
    links.hidden = kind.value !== 'issues' || !view.issues.length;
    submit.disabled = kind.value === 'pull-request-reviews' && !pull.options.length;
  }
  kind.addEventListener('change', showScopeFields);
  showScopeFields();
  form.append(node('div', 'github-fields', node('label', '', 'Category', kind), node('label', '', 'First page', page),
    node('label', '', 'Number of pages', pages), pullLabel), links, submit);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const linkedTaskIds = kind.value === 'issues' ? [...links.querySelectorAll('input:checked')].map((control) => control.value) : [];
    if (linkedTaskIds.length > 8) { githubMessage('Choose up to eight linked issues.'); return; }
    if (+page.value + +pages.value - 1 > 1000) { githubMessage('The selected pages must end by page 1000.'); return; }
    void githubCommand('refresh', { ...githubVersion(origin),
      scope: { kind: kind.value, page: +page.value, pages: +pages.value, linkedTaskIds,
        pullRequestId: kind.value === 'pull-request-reviews' ? pull.value : null } }, { origin });
  });
  return form;
}

function githubPreview(origin, operation) {
  const preview = operation.preview;
  if (!preview || !preview.issues.length) return null;
  const list = node('fieldset', 'github-choices', node('legend', '', 'Import issues'),
    node('p', 'muted', 'Choose up to ten issues before ' + new Date(preview.expiresAt).toLocaleTimeString() + '.'));
  if (preview.version !== confirmed?.version || Date.parse(preview.expiresAt) <= Date.now()) {
    list.append(node('p', '', 'This preview expired. Refresh issues to obtain a new preview.'));
    return list;
  }
  const linked = new Set(origin.view.issues.map(({ issueId }) => issueId));
  const submit = githubButton('Import selected issues', 'import', () => {
    const issueIds = [...list.querySelectorAll('input:checked')].map((control) => control.value);
    if (issueIds.length > 10) { githubMessage('Choose up to ten issues.'); return; }
    void githubCommand('import', { ...githubVersion(origin), operationId: operation.operationId, issueIds }, { changesBoard: true, origin });
  }, 'primary');
  submit.disabled = true;
  for (const issue of preview.issues) {
    if (!issue.values || linked.has(issue.issueId)) {
      list.append(node('p', 'muted', '#' + issue.number + (linked.has(issue.issueId) ? ' · Already linked' : ' · Field exceeds the import limit')));
      continue;
    }
    list.append(githubCheckbox('#' + issue.number + ' ' + issue.values.title, issue.issueId,
      () => { submit.disabled = !list.querySelector('input:checked'); }));
  }
  list.append(submit);
  return list;
}

function factText(fact) {
  // F3: say what each cached observation means; merged and check results stay separate from local acceptance.
  switch (fact.kind) {
    case 'pull-request': return 'Pull request #' + fact.number + ' · ' + fact.state + ' · ' +
      (fact.merged === true ? 'merged' : fact.merged === false ? 'not merged' : 'merge unknown');
    case 'workflow-run': return 'Workflow run · ' + (fact.status ?? 'status unknown') + ' · ' + (fact.conclusion ?? 'no conclusion yet');
    case 'release': return 'Release ' + fact.tagName + ' · ' + (fact.draft ? 'draft' : fact.prerelease ? 'prerelease' : 'published');
    case 'pull-request-review': return 'Review of #' + fact.number + ' · ' + fact.state;
  }
  return fact.title ?? fact.tagName ?? fact.state ?? fact.id;
}

const availabilityText = {
  observed: 'Observed', historical: 'Cached from an earlier connection; refresh to update', unknown: 'Not currently observed',
};

function githubMappedIssue(origin, mapping) {
  const article = node('article', 'panel', node('h5', 'github-value', '#' + mapping.number + ' ' + mapping.local.title),
    stamped(node('p', 'muted', (availabilityText[mapping.availability] ?? mapping.availability) + ' · ' +
      (mapping.fetchedAt ? when(mapping.fetchedAt) : 'No current observation')), mapping.fetchedAt));
  if (mapping.pendingFields.length) article.append(node('p', '', 'Local edits pending for ' + mapping.pendingFields.join(', ') + '.'));
  const state = node('select');
  state.append(new Option('Open', 'open'), new Option('Closed', 'closed'));
  state.value = mapping.local.state;
  const taskId = mapping.localTaskId;
  article.append(node('div', 'github-fields', node('label', '', 'Local issue state', state),
    githubButton('Save issue state', 'state-' + taskId,
      () => githubCommand('issue-state', { ...githubVersion(origin), taskId, state: state.value }, { changesBoard: true, origin })),
    githubButton('Unlink issue', 'unlink-' + taskId, () => {
      if (githubActionCurrent(origin) && window.confirm('Remove this GitHub link and keep the local task?')) {
        void githubCommand('unlink', { ...githubVersion(origin), taskId }, { changesBoard: true, origin });
      }
    })));
  for (const field of mapping.conflictFields) {
    const resolve = (choice) => githubCommand('resolve', {
      ...githubVersion(origin), taskId, field, choice, remoteUpdatedAt: mapping.remoteUpdatedAt, observedValue: mapping.remote[field],
    }, { changesBoard: true, origin });
    article.append(node('section', '', node('h6', '', 'Conflict in ' + field), node('p', 'github-value', 'Local · ' + mapping.local[field]),
      node('p', 'github-value', 'GitHub · ' + mapping.remote[field]), node('div', 'actions',
        githubButton('Keep local', taskId + '-' + field + '-local', () => resolve('local')),
        githubButton('Adopt GitHub', taskId + '-' + field + '-remote', () => resolve('remote')))));
  }
  return article;
}

function githubCache(origin) {
  const { view } = origin;
  const reviewed = githubVersion(origin);
  const cache = node('details', '', node('summary', '', 'Manage cached observations'));
  const kinds = node('fieldset', 'github-choices', node('legend', '', 'Kinds to clear'));
  const confirmedClear = githubCheckbox('Clear the selected kinds from this board.', '');
  const count = new Map(githubFactKinds.map(([kind]) => [kind, view.facts.filter((fact) => fact.kind === kind).length]));
  for (const [kind, label] of githubFactKinds) kinds.append(githubCheckbox(label + ' (' + count.get(kind) + ')', kind));
  const clear = githubButton('Clear selected observations', 'clear', async () => {
    const values = [...kinds.querySelectorAll('input:checked')].map((control) => control.value);
    if (!confirmedClear.firstElementChild.checked || !values.length || !githubActionCurrent(origin)) return;
    try {
      const fresh = await api('/api/github/overview', {});
      if (!githubActionCurrent(origin)) return;
      if (fresh.boardId !== reviewed.boardId || fresh.version !== reviewed.expectedVersion) {
        githubMessage('The board changed. Review the current counts and confirm again.');
        await loadGithub(true);
        return;
      }
      await githubCommand('clear-facts', { ...reviewed, kinds: values, confirmed: true }, { changesBoard: true, origin });
    } catch (error) { if (githubActionCurrent(origin)) githubError(error); }
  });
  clear.disabled = true;
  cache.addEventListener('change', () => { clear.disabled = !confirmedClear.firstElementChild.checked || !kinds.querySelector('input:checked'); });
  cache.append(node('p', 'muted', 'Clearing pull requests also clears their cached review observations. Linked issues and board reviews are kept.'),
    githubButton('Download full private backup', 'cache-backup', async () => {
      if (!githubActionCurrent(origin)) return;
      try {
        const backup = await api('/api/backup', { expectedVersion: view.version });
        if (!githubActionCurrent(origin) || backup.version !== view.version || typeof backup.backupJson !== 'string') return;
        initiateDownload(backup.backupJson, 'glance-private.json', 'application/json');
        githubMessage('Private backup download initiated.');
      } catch (error) { if (githubActionCurrent(origin)) githubError(error); }
    }), kinds, confirmedClear, clear);
  return cache;
}


const publishFieldLabels = { title: 'Title', body: 'Description', state: 'Issue state' };
const publishStateLabels = { prepared: 'Prepared', 'not-sent': 'Not sent', rejected: 'Rejected',
  unknown: 'Outcome unknown', conflict: 'Conflict', confirmed: 'Confirmed' };

function publicationSelector(origin, tasks) {
  const { view } = origin;
  const details = node('details', 'github-publication', node('summary', '', 'Review GitHub changes'));
  const form = node('form', '');
  const groups = [];
  const mappings = new Map(view.issues.map((row) => [row.localTaskId, row]));
  for (const task of tasks) {
    const mapping = mappings.get(task.id);
    const select = githubCheckbox(task.title, task.id);
    const toggle = select.firstElementChild;
    const group = node('fieldset', '', node('legend', 'github-value', mapping ? 'Issue #' + mapping.number : 'New open issue'), select);
    const fields = [];
    if (!mapping) group.append(node('p', 'muted', 'Title is included. Description is optional.'));
    for (const key of mapping ? ['title', 'body', 'state'] : ['body']) {
      const label = githubCheckbox(mapping ? publishFieldLabels[key] : 'Include description', key);
      const input = label.firstElementChild;
      input.disabled = true;
      toggle.addEventListener('change', () => { input.disabled = !toggle.checked; input.checked = false; });
      fields.push(input);
      group.append(label);
    }
    groups.push({ toggle, fields, mapping });
    form.append(group);
  }
  const submit = node('button', 'primary', 'Review selected GitHub changes');
  submit.type = 'submit';
  form.append(submit);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!githubActionCurrent(origin)) return;
    const chosen = groups.filter(({ toggle }) => toggle.checked);
    if (!chosen.length || chosen.length > 3) {
      githubMessage('Choose one to three tasks.');
      (chosen[3]?.toggle ?? groups[0]?.toggle)?.focus();
      return;
    }
    const items = chosen.map(({ toggle, fields, mapping }) => ({
      taskId: toggle.value, fields: [...(mapping ? [] : ['title']), ...fields.filter((input) => input.checked).map((input) => input.value)],
    }));
    const empty = items.findIndex((item) => !item.fields.length);
    if (empty >= 0) { githubMessage('Choose at least one changed field for this issue.'); chosen[empty].fields[0].focus(); return; }
    void githubCommand('publish-preview', { expectedVersion: view.version, items }, { origin });
  });
  details.append(form);
  return details;
}

function publicationIssueLink(repo) {
  if (!/^[A-Za-z0-9-]{1,100}$/.test(repo.owner) || !/^[A-Za-z0-9_.-]{1,100}$/.test(repo.name) ||
      repo.name === '.' || repo.name === '..') return null;
  const link = node('a', '', 'Review repository issues on GitHub');
  link.href = 'https://github.com/' + encodeURIComponent(repo.owner) + '/' + encodeURIComponent(repo.name) + '/issues';
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  return link;
}

function publicationConfirmation(origin, operation, preview) {
  if (preview.version !== origin.view.version || Date.parse(preview.expiresAt) <= Date.now()) {
    return node('p', '', 'The reviewed Board version or preview changed. Prepare a new preview.');
  }
  const publishing = preview.kind === 'publish-preview';
  const heading = node('h4', '', publishing ? 'Confirm GitHub publication' : 'Confirm GitHub inspection');
  heading.tabIndex = -1;
  heading.id = 'github-publication-preview-heading';
  const area = node('section', 'github-publication', heading);
  const create = publishing && preview.actions.some(({ intent }) => intent.action === 'create');
  const repo = publishing ? preview.actions[0].intent.repository : preview.repository;
  area.append(node('p', 'github-value', repo.owner + '/' + repo.name + ' · ' + repo.visibility + ' · ID ' + repo.id));
  if (publishing) {
    area.append(node('p', '', 'These exact fields will be sent to the displayed repository. Check them for private information.'));
    for (const { intent } of preview.actions) {
      const item = node('article', '', node('h5', '', intent.issue ? 'Issue #' + intent.issue.number : 'New open issue'));
      for (const field of intent.fields) {
        item.append(node('h6', '', publishFieldLabels[field]));
        if (intent.before) item.append(node('p', 'github-value', 'Before · ' + intent.before[field]));
        item.append(node('p', 'github-value', 'Send · ' + intent.proposed[field]));
      }
      if (intent.action === 'create' && !intent.fields.includes('body')) item.append(node('p', '', 'Description omitted.'));
      area.append(item);
    }
  } else {
    const { issue } = preview;
    area.append(node('p', '', 'Issue #' + issue.number + ' · ID ' + issue.issueId),
      node('p', '', preview.action === 'create'
        ? 'You are choosing this issue. The earlier request’s origin cannot be proven.'
        : 'This inspection records current GitHub values. It preserves local task fields, human acceptance and the original outcome.'));
    if (preview.taskId === null) area.append(node('p', '', 'Issue identified. The local task no longer exists.'));
    for (const [key, label] of Object.entries(publishFieldLabels)) {
      area.append(node('h5', '', label), node('p', 'github-value', issue.values[key]));
      if (preview.proposed && Object.hasOwn(preview.proposed, key)) area.append(node('p', 'github-value', 'Intended · ' + preview.proposed[key]));
    }
  }
  const confirmation = githubCheckbox(publishing ? 'I confirm sending the displayed fields.' : 'I confirm this GitHub observation.', '');
  const checkedIssues = create ? githubCheckbox('I checked the repository for an existing issue.', '') : null;
  if (create) area.append(publicationIssueLink(repo), checkedIssues);
  const send = githubButton(publishing ? 'Publish confirmed changes' : 'Save confirmed inspection', 'publication-confirm', () => {
    if (!confirmation.firstElementChild.checked || (create && !checkedIssues.firstElementChild.checked)) return;
    void githubCommand(publishing ? 'publish-confirm' : 'reconcile-confirm', {
      expectedVersion: preview.version, operationId: operation.operationId, confirmed: true,
      ...(create ? { existingIssuesChecked: true } : {}),
    }, { changesBoard: !publishing, origin });
  }, 'primary');
  send.disabled = true;
  area.addEventListener('change', () => {
    send.disabled = !confirmation.firstElementChild.checked || (create && !checkedIssues.firstElementChild.checked);
  });
  area.append(confirmation, node('div', 'actions', send,
    githubButton('Discard preview', 'publication-discard',
      () => githubOperationCommand(origin.epoch, operation.operationId, 'preview-invalidate'))));
  return area;
}

function publicationResults(operation) {
  const heading = node('h4', '', 'GitHub publication results');
  heading.id = 'github-publication-results-heading';
  heading.tabIndex = -1;
  const area = node('section', 'github-publication', heading);
  if (!githubFinished.has(operation.state)) area.append(node('p', '', 'Sending reviewed changes. Closing stops future requests. A request already sent may still complete.'));
  for (const row of operation.publication.results) {
    const task = confirmed.snapshot.tasks.find(({ id }) => id === row.taskId);
    const line = node('p', 'github-value', (task?.title ?? row.taskId) + ' · ' + publishStateLabels[row.outcome.kind] +
      ' · ' + row.outcome.at + (row.outcome.issue ? ' · Issue #' + row.outcome.issue.number : '') +
      (!row.recorded ? ' · Local recording unconfirmed' : row.attached === false ? ' · Inspect and link the issue' : ''));
    line.dataset.publicationState = row.outcome.kind;
    area.append(line);
  }
  return area;
}

function publicationHistory(origin) {
  const { view } = origin;
  const state = view.publication;
  if (!state) return null;
  const area = node('section', 'github-publication', node('h4', '', 'GitHub publication history'));
  const candidates = [];
  const currentTasks = new Map(confirmed.snapshot.tasks.map((task) => [task.id, task]));
  const canInspect = view.configured && view.selection === 'selected';
  const inspect = (row, issue) => {
    const number = node('input');
    number.type = 'number';
    number.min = '1';
    number.step = '1';
    number.value = issue ? String(issue.number) : '';
    number.readOnly = Boolean(issue);
    return node('div', 'github-fields', node('label', '', 'Issue number', number),
      githubButton('Inspect GitHub issue', 'inspect-' + row, () => {
        const issueNumber = Number(number.value);
        if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) { githubMessage('Enter a valid issue number.'); number.focus(); return; }
        void githubCommand('reconcile-preview', { expectedVersion: view.version, intentId: row, issueNumber }, { origin });
      }));
  };
  for (const row of state.records) {
    const { intent, outcome, reconciliation, mergePendingFields, associationTaskId } = row;
    const known = reconciliation?.issue ?? outcome?.issue ?? intent.issue;
    const mapped = view.issues.find((m) => m.localTaskId === associationTaskId && m.issueId === known?.id);
    const task = currentTasks.get(associationTaskId);
    const card = node('article', 'panel', node('h5', 'github-value', task?.title ?? 'Historical task'),
      node('p', '', intent.repository.owner + '/' + intent.repository.name + ' · ' + publishStateLabels[row.state] +
        ' · ' + (outcome?.at ?? row.attemptedAt ?? intent.preparedAt)));
    if (reconciliation) card.append(node('p', '', 'Later inspection · ' + reconciliation.kind + ' · #' + reconciliation.issue.number));
    if (mergePendingFields.length && mapped) {
      const changed = mergePendingFields.some((key) => mapped.local[key] !== intent.proposed[key]);
      const text = outcome?.kind === 'confirmed'
        ? (changed ? 'Pending local change after publication.' : 'Published; refresh to reconcile.')
        : (changed ? 'Pending local change after inspection.' : 'Current GitHub values match; original send outcome remains ' + row.state + '. Refresh to reconcile.');
      card.append(node('p', '', text));
    }
    const unresolved = row.attemptedAt && ['unknown', 'conflict'].includes(row.state) && !reconciliation;
    if (unresolved) card.append(node('p', '', 'Inspect the earlier send before publishing or refreshing this linked issue.'));
    if (canInspect && intent.repository.id === view.repository?.id && (unresolved ||
        (known && !mapped && row.attemptedAt && row.state !== 'rejected' &&
          (intent.action === 'create' || associationTaskId)))) {
      card.append(inspect(intent.id, known));
    }
    if (row.retirable) {
      const choose = githubCheckbox('Archive this publication record', intent.id);
      candidates.push(choose.firstElementChild);
      card.append(choose);
    }
    area.append(card);
  }
  for (const link of state.creationLinks) {
    if (!canInspect || link.repositoryId !== view.repository?.id ||
        view.issues.some((m) => m.localTaskId === link.associationTaskId && m.issueId === link.issue.id)) continue;
    area.append(node('article', '', node('p', '', 'Previously archived issue #' + link.issue.number),
      inspect(link.intentId, link.issue)));
  }
  if (state.retired) area.append(node('p', 'muted', 'Last archive · ' + state.retired.at + ' · ' + state.retired.recordIds.length + ' records'));
  if (candidates.length) area.append(githubButton('Prepare private archive backup', 'retire-preview', async () => {
    const intentIds = candidates.filter((box) => box.checked).map((box) => box.value);
    if (!intentIds.length) { githubMessage('Select a publication record to archive.'); candidates[0].focus(); return; }
    if (!githubActionCurrent(origin)) return;
    try {
      const receipt = await api('/api/github/publication-retire-preview', { expectedVersion: view.version, intentIds });
      if (!githubActionCurrent(origin)) {
        void invalidateGithubPreview(receipt.operationId);
        return;
      }
      githubRetire = receipt;
      renderGithub();
      id('github-publication-archive-heading')?.focus();
    } catch (error) { if (githubActionCurrent(origin)) githubError(error); }
  }));
  return area;
}

function publicationArchivePreview(origin, receipt) {
  if (origin.view.version !== receipt.version || Date.parse(receipt.expiresAt) <= Date.now()) return null;
  const heading = node('h4', '', 'Archive selected publication records');
  heading.id = 'github-publication-archive-heading';
  heading.tabIndex = -1;
  const saved = githubCheckbox('I saved this full private backup.', '');
  const confirmedArchive = githubCheckbox('I confirm archiving the selected records.', '');
  const commit = githubButton('Archive confirmed records', 'retire-confirm', () => {
    if (!saved.firstElementChild.checked || !confirmedArchive.firstElementChild.checked ||
        githubRetire !== receipt || !githubActionCurrent(origin)) return;
    githubRetire = null;
    void githubCommand('publication-retire-confirm', { expectedVersion: receipt.version, operationId: receipt.operationId,
      backupSha256: receipt.backupSha256, backupSavedConfirmed: true, confirmed: true }, { changesBoard: true, origin });
  });
  commit.disabled = true;
  const area = node('section', 'github-publication', heading,
    node('p', '', receipt.records.length + ' selected records. The full private backup can contain issue text. Keep it before archiving.'),
    githubButton('Download publication backup', 'retire-download', () => initiateDownload(receipt.backupJson, 'glance-publication-backup.json', 'application/json')),
    saved, confirmedArchive, commit);
  for (const record of receipt.records) {
    const task = confirmed.snapshot.tasks.find(({ id }) => id === record.taskId);
    area.append(node('p', 'github-value', (task?.title ?? 'Historical task') + ' · ' + record.action + ' · ' + publishStateLabels[record.state]));
  }
  area.addEventListener('change', () => { commit.disabled = !saved.firstElementChild.checked || !confirmedArchive.firstElementChild.checked; });
  return area;
}

function renderGithub() {
  const target = id('github-content');
  const key = target.contains(document.activeElement) ? document.activeElement.dataset.focusKey : null;
  const epoch = githubPanelEpoch, operation = githubOperation;
  const view = !githubLoading && overviewMatchesBoard(githubView) ? githubView : null;
  const origin = { view, epoch };
  const content = [];
  let publicationFocus = '';
  if (view) {
    if (!view.configured) content.push(node('p', '', 'GitHub connection is not configured in this build.'));
    if (view.repository) content.push(node('p', '', view.repository.owner + '/' + view.repository.name + ' · ' + view.repository.visibility));
    if (view.selection === 'disconnected' && (!operation || githubFinished.has(operation.state))) content.push(node('p', '', 'Disconnected locally. Cached observations are still available.'));
    if (view.selection === 'selected') content.push(node('p', '', view.credentialState === 'active-for-this-process'
      ? 'Credential verified in this session.' : 'Saved repository. Verify the credential with an explicit refresh or sign in again.'));
    if (view.configured && (!operation || githubFinished.has(operation.state))) {
      // F4: once the credential is verified, drop the setup guidance and demote Sign in again.
      const verified = view.selection === 'selected' && view.credentialState === 'active-for-this-process';
      if (!verified) content.push(node('p', 'muted', 'Install or allow the GitHub App, sign in, then confirm a repository in Glance.'));
      content.push(node('div', 'actions', githubLink('Install or request access', view.installationUrl),
          githubLink('Create a repository', view.createRepositoryUrl),
          githubButton(view.repository || operation?.code === 'AUTH_EXPIRED' ? 'Sign in again' : 'Sign in', 'sign-in',
            () => githubCommand('start', githubVersion(origin), { origin }), verified ? '' : 'primary')));
      if (view.selection === 'selected') content.push(githubScope(origin), publicationSelector(origin, confirmed.snapshot.tasks));
      if (view.repository) content.push(node('p', 'muted', 'An older backup or separate copy cannot know about GitHub attempts made later.'));
    }
  } else if (!githubLoading) {
    content.push(githubButton('Refresh saved GitHub state', 'read-saved-state', () => {
      if (githubVisible(epoch) && !githubView && !githubLoading) void loadGithub();
    }));
  }
  if (operation) {
    const descriptions = { starting: 'Starting sign-in…', 'awaiting-code': 'Waiting for GitHub authorization…', discovering: 'Checking GitHub access…',
      selecting: 'Checking the repository and saving the connection…', refreshing: 'Refreshing the selected scope…',
      stopping: 'Waiting for owned work to settle…', cancelled: 'Operation cancelled.' };
    if (operation.message || descriptions[operation.state]) content.push(node('p', '', operation.message ?? descriptions[operation.state]));
    if (operation.nextAllowedAt) content.push(node('p', 'muted', 'Next attempt after ' + operation.nextAllowedAt));
    if (operation.device) content.push(node('p', '', githubLink('Open GitHub device authorization', operation.device.verificationUri),
      ' · Code ', node('strong', '', operation.device.userCode), ' · Expires ' + operation.device.expiresAt));
    if (view && operation.state === 'choosing-repository') content.push(githubChooser(origin, operation));
    if (operation.capabilities) content.push(stamped(node('p', 'muted', 'Repository access checked ' + when(operation.capabilities.checkedAt) + '.'), operation.capabilities.checkedAt));
    if (!githubFinished.has(operation.state) && !operation.localDisconnected && operation.state !== 'stopping') {
      content.push(githubButton('Cancel GitHub operation', 'cancel', () => githubOperationCommand(epoch, operation.operationId, 'cancel')));
    }
    if (operation.localDisconnected) {
      const labels = { pending: 'Credential cleanup pending.', complete: 'Local credential cleanup confirmed.', unknown: 'Local credential cleanup is unconfirmed.' };
      content.push(node('p', '', labels[operation.cleanup]));
    }
    if (view) content.push(githubPreview(origin, operation));
    const publication = operation.publication;
    if (publication?.kind === 'publishing') {
      content.push(publicationResults(operation));
      if (githubFinished.has(operation.state)) publicationFocus = 'github-publication-results-heading';
    } else if (publication && view) {
      content.push(publicationConfirmation(origin, operation, publication));
      publicationFocus = 'github-publication-preview-heading';
    } else if (publication) {
      content.push(githubButton('Discard preview', 'publication-discard',
        () => githubOperationCommand(epoch, operation.operationId, 'preview-invalidate')));
    }
  }
  if (view) {
    if (view.selection === 'selected' || (operation && !operation.localDisconnected && !githubFinished.has(operation.state))) {
      content.push(githubButton('Disconnect locally', 'disconnect', () => githubCommand('disconnect', githubVersion(origin), { origin })));
    }
    if (view.selection !== 'none') content.push(node('p', '', githubLink('Review or revoke access on GitHub', view.revocationUrl)));
    if (view.lastAttempt) content.push(stamped(node('p', 'muted', 'Last refresh ' + view.lastAttempt.outcome + ' · ' + when(view.lastAttempt.at)), view.lastAttempt.at));
    for (const row of view.collections) content.push(stamped(node('p', 'muted',
      (githubKinds.find(([kind]) => kind === row.kind)?.[1] ?? row.kind) + ' · ' + row.count + ' · ' + row.completeness + ' · observed ' + when(row.observedAt)), row.observedAt));
    if (view.facts.length) {
      const facts = node('details', '', node('summary', '', 'Cached observations (' + view.facts.length + ')'));
      for (const fact of view.facts) facts.append(stamped(node('p', 'github-value', factText(fact) + ' · observed ' + when(fact.observedAt)), fact.observedAt));
      content.push(facts, githubCache(origin));
    }
    if (view.issues.length) content.push(node('section', '', node('h4', '', 'Linked issues'), ...view.issues.map((mapping) => githubMappedIssue(origin, mapping))));
    content.push(publicationHistory(origin));
    if (githubRetire) content.push(publicationArchivePreview(origin, githubRetire));
  }
  target.replaceChildren(...content.filter(Boolean));
  id('close-github').textContent = operation?.publication?.kind === 'publishing' && !githubFinished.has(operation.state)
    ? 'Close GitHub (sent requests may complete)' : 'Close GitHub';
  const focusMarker = publicationFocus ? operation.operationId + ':' + publicationFocus : '';
  if (focusMarker && focusMarker !== githubPublicationFocus && id(publicationFocus)) id(publicationFocus).focus();
  else if (key) ([...target.querySelectorAll('[data-focus-key]')].find((element) => element.dataset.focusKey === key) ?? id('github-title')).focus();
  githubPublicationFocus = focusMarker;
}

function publicFailure(error, message) {
  invalidatePublic(message, true);
  if (error instanceof RequestFailure && (error.code === 'RECOVERY_REQUIRED' || error.status === 401)) handleReadFailure(error);
}

async function preparePublicPreview() {
  if (!publicAvailable() || publicBusy) return;
  invalidatePublic();
  const state = confirmed;
  const draft = JSON.stringify(publicDraft);
  const input = { expectedVersion: state.version, labels: JSON.parse(draft) };
  if ((input.labels.project !== null && !isPublicLabel(input.labels.project)) ||
      publicGroups.some(([key]) => input.labels[key].some(({ label }) => !isPublicLabel(label)))) {
    publicMessage('Check the public labels. Each label must have 1–200 characters and no line breaks or control characters.', true);
    return;
  }
  if (publicEncoder.encode(JSON.stringify(input)).byteLength > publicRequestLimit) {
    publicMessage('Public labels exceed the request limit. Use generic labels or enter fewer names.', true);
    return;
  }
  const pack = { generation: publicGeneration, token, version: state.version, draft, files: null };
  publicBusy = true;
  updatePublicControls();
  publicMessage('Preparing public preview…');
  try {
    const result = await api('/api/public-report', input);
    if (!publicIdentity(pack)) return;
    await validatePublicPackage(result, state);
    if (!publicIdentity(pack)) return;
    pack.files = result;
    publicPackage = pack;
    renderPublicPreview(pack);
    publicMessage('Review the exact public contents before confirming.');
    id('public-preview-title').focus();
  } catch (error) {
    if (publicIdentity(pack)) {
      const message = error instanceof RequestFailure && error.code === 'REVISION_CONFLICT'
        ? 'The board changed. Refresh it and prepare a new public preview.'
        : error instanceof RequestFailure ? error.message : 'The public preview could not be verified. Prepare a new preview when ready.';
      publicFailure(error, message);
    }
  } finally {
    if (publicGeneration === pack.generation) {
      publicBusy = false;
      updatePublicControls();
    }
  }
}

function freshPublicBoard(result, state) {
  if (!exactPublicKeys(result, ['ok', 'initialized', 'snapshot', 'version', 'report']) ||
      result.initialized !== true || typeof result.version !== 'string' ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}:[1-9]\d{0,9}$/.test(result.version) ||
      !result.snapshot || result.snapshot.boardId !== state.snapshot.boardId ||
      !publicInteger(result.snapshot.revision, 2147483647) || result.snapshot.revision === 0 ||
      result.version !== result.snapshot.generation + ':' + result.snapshot.revision ||
      typeof result.snapshot.updatedAt !== 'string' || !Number.isFinite(Date.parse(result.snapshot.updatedAt)) ||
      !result.snapshot.project || !Array.isArray(result.snapshot.tasks) || !Array.isArray(result.snapshot.milestones) ||
      !Array.isArray(result.snapshot.workstreams) || !result.report?.counts || !result.report?.acceptance ||
      !Array.isArray(result.report.taskReviews)) throw new Error('The saved board response could not be verified.');
  if (result.version === state.version && (JSON.stringify(result.snapshot) !== JSON.stringify(state.snapshot) ||
      JSON.stringify(result.report) !== JSON.stringify(state.report))) {
    throw new Error('The saved board response did not match the captured revision.');
  }
  return result.version;
}

async function verifyPublicFreshness(format) {
  const pack = publicPackage;
  if (publicBusy || !pack || !publicIdentity(pack) || (format && publicConfirmed !== pack)) return;
  const state = confirmed;
  if (!format) publicConfirmed = null;
  publicBusy = true;
  updatePublicControls();
  publicMessage('Checking the saved revision…');
  try {
    const fresh = await api('/api/board');
    if (!publicIdentity(pack) || publicPackage !== pack || (format && publicConfirmed !== pack)) return;
    if (freshPublicBoard(fresh, state) !== pack.version) {
      invalidatePublic('The saved board changed. Refresh it and prepare a new public preview.', true);
      return;
    }
    if (format) {
      initiateDownload(pack.files[format.key], format.name, format.mediaType);
      publicMessage('Download initiated for ' + format.name + '.');
    } else {
      publicConfirmed = pack;
      publicMessage('The saved revision matches. Public downloads are available.');
    }
  } catch (error) {
    if (publicIdentity(pack) && publicPackage === pack) {
      publicFailure(error, 'Could not verify the saved revision or initiate the download. Prepare a new public preview.');
    }
  } finally {
    if (publicGeneration === pack.generation) {
      publicBusy = false;
      updatePublicControls();
    }
  }
}

function renderExport() {
  const pack = exportPackage;
  id('export-panel').hidden = !pack;
  if (!pack) return;
  id('export-meta').textContent = 'Revision ' + pack.version + ' · ' + pack.exportedAt + ' · Review before sharing';
  id('export-links').replaceChildren(...formats.map((format) => button('Download ' + format.label, () => {
    initiateDownload(pack[format.key], format.name, format.mediaType);
    initiated.add(format.label);
    id('export-status').textContent = 'Download initiated: ' + [...initiated].join(', ') + '.';
  })));
  id('export-status').textContent = '';
}

async function prepareExport() {
  if (preparing || checking || quitting || !confirmed || screen !== 'board') return;
  preparing = true;
  id('prepare-export').disabled = true;
  const expectedVersion = confirmed.version;
  try {
    const result = await api('/api/export', { expectedVersion });
    if (quitting || screen !== 'board') return;
    exportPackage = Object.freeze({ ...result, sha256: Object.freeze(result.sha256) });
    initiated = new Set();
    renderExport();
    notice('Export prepared from revision ' + result.version + '.');
  } catch (error) {
    if (quitting || screen !== 'board') return;
    if (error instanceof RequestFailure && error.code === 'REVISION_CONFLICT' && error.current) {
      accept(error.current);
      notice('The board changed. Review the saved revision and prepare a new export when ready.', true);
    } else {
      handleReadFailure(error);
    }
  } finally {
    preparing = false;
    id('prepare-export').disabled = false;
  }
}

async function downloadReviewArchive() {
  if (backupPending || checking || quitting || !confirmed || screen !== 'board') return;
  const displayed = confirmed;
  const control = id('download-review-archive');
  const status = id('review-backup-status');
  backupPending = true;
  control.disabled = true;
  status.textContent = '';
  try {
    const result = await api('/api/backup', { expectedVersion: displayed.version });
    if (quitting || screen !== 'board') return;
    if (result.version !== displayed.version || result.boardId !== displayed.snapshot.boardId ||
        typeof result.backupJson !== 'string' || !/^[0-9a-f]{64}$/.test(result.sha256) ||
        !/^[0-9a-f]{64}$/.test(result.snapshotSha256)) {
      throw new Error('The current backup response could not be confirmed.');
    }
    initiateDownload(result.backupJson, 'glance-review-archive.json', 'application/json');
    status.textContent = 'Download initiated for ' + result.version + '. Raw file SHA-256 ' + result.sha256 +
      ' · Normalized snapshot SHA-256 ' + result.snapshotSha256;
  } catch (error) {
    if (quitting || screen !== 'board') return;
    if (error instanceof RequestFailure && error.code === 'REVISION_CONFLICT') {
      status.textContent = 'The board changed. Refresh and choose Download review archive again.';
    } else {
      status.textContent = error instanceof Error ? error.message : 'The backup is unavailable.';
    }
  } finally {
    backupPending = false;
    control.disabled = false;
  }
}

async function downloadRecovery() {
  const control = id('recover-download');
  if (control.disabled || quitting || screen !== 'recovery') return;
  control.disabled = true;
  try {
    const source = recoverySource ?? Object.freeze(await api('/api/recovery'));
    if (quitting || screen !== 'recovery') return;
    recoverySource = source;
    if (recoverySource.available) {
      initiateDownload(recoverySource.backupJson, 'glance-recovery.json', 'application/json');
      notice('Recovery backup download initiated for ' + recoverySource.sourceVersion + '.');
    } else {
      control.hidden = true;
      id('recovery-detail').textContent = 'No validated previous revision is available.';
    }
  } catch (error) {
    if (!quitting && screen === 'recovery') handleReadFailure(error);
  } finally {
    control.disabled = false;
  }
}

function initialDraft() {
  return screen === 'initialization' && (id('blank-name').value !== '' || id('backup-file').files.length > 0);
}

async function quit() {
  if (quitting || !token || initializing || editor || reviewForm) return;
  if (initialDraft() && !confirm('Discard the unfinished board setup and quit?')) return;
  quitting = true;
  invalidatePublic();
  id('quit').disabled = true;
  try {
    await api('/api/quit', {});
    forgetToken();
    clearBoardView();
    recoverySource = null;
    screenTo('shutdown');
    notice('');
    id('check-host').focus();
  } catch (error) {
    if (!(error instanceof RequestFailure)) {
      notice('Host unavailable. Check the terminal for process exit.', true);
    } else {
      handleReadFailure(error);
    }
  } finally {
    quitting = false;
    updatePublicControls();
    id('quit').disabled = false;
  }
}

async function checkHost() {
  id('check-host').disabled = true;
  try {
    await fetch('/', { cache: 'no-store', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(3500) });
    notice('The listener still responded. Check the terminal for process exit.');
  } catch {
    notice('Host unavailable');
  } finally {
    id('check-host').disabled = false;
  }
}

id('view-navigation').addEventListener('click', (event) => {
  const control = event.target.closest('button[data-view]');
  if (control) showView(control.dataset.view);
});
id('task-search').addEventListener('input', renderTasks);
id('task-status').addEventListener('change', renderTasks);
for (const mode of ['cards', 'table']) {
  id(mode + '-mode').addEventListener('click', () => {
    layout = mode;
    pressed(id('cards-mode'), mode === 'cards');
    pressed(id('table-mode'), mode === 'table');
    renderTasks();
  });
}
for (const [element, kind] of [
  ['edit-project', 'project.edit'], ['add-task', 'task.add'], ['add-milestone', 'milestone.add'],
  ['add-workstream', 'workstream.add'], ['add-evidence', 'evidence.add'],
]) {
  id(element).addEventListener('click', (event) => openEditor(kind, null, event.currentTarget));
}
id('close-detail').addEventListener('click', () => closeDetail());
id('detail-dialog').addEventListener('cancel', (event) => {
  event.preventDefault();
  closeDetail();
});
id('review-form').addEventListener('submit', saveReview);
id('close-review').addEventListener('click', closeReview);
id('review-dialog').addEventListener('cancel', (event) => {
  event.preventDefault();
  closeReview();
});
id('refresh-review').addEventListener('click', refreshReviewHistory);
id('download-review-archive').addEventListener('click', downloadReviewArchive);
id('review-cycle-link').addEventListener('click', () => { id('review-cycle-instructions').open = true; });
id('edit-form').addEventListener('submit', saveEditor);
id('close-editor').addEventListener('click', () => closeEditor());
id('edit-dialog').addEventListener('cancel', (event) => {
  event.preventDefault();
  closeEditor();
});
id('reload-draft').addEventListener('click', () => applyComparison(false));
id('reapply-draft').addEventListener('click', () => applyComparison(true));
id('check-outcome').addEventListener('click', checkOutcome);
id('blank-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void initialize(() => ({ kind: 'blank', name: id('blank-name').value }));
});
id('create-sample').addEventListener('click', () => { void initialize(() => ({ kind: 'sample' })); });
id('import-identity').addEventListener('change', setInitControls);
id('import-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void initialize(async () => {
    const file = id('backup-file').files[0];
    const identity = id('import-identity').value;
    if (!file || file.size > 3 * 1024 * 1024) throw new Error('Choose a JSON backup within the 3 MiB import limit.');
    let backup;
    try { backup = JSON.parse(await file.text()); } catch { throw new Error('The selected file is not a readable JSON backup.'); }
    return { kind: 'import', backup, identity,
      ...(identity === 'continue' ? { preserveHistoryConfirmed: id('continue-confirm').checked } : {}) };
  });
});
id('check-initialization').addEventListener('click', refreshBoard);
id('refresh').addEventListener('click', refreshBoard);
id('prepare-export').addEventListener('click', prepareExport);
id('open-public-report').addEventListener('click', () => {
  if (confirmed && screen === 'board') setPublicPanel(id('public-report').hidden, true);
});
id('close-public-report').addEventListener('click', () => setPublicPanel(false, true));
id('open-github').addEventListener('click', () => {
  if (confirmed && screen === 'board') setGithubPanel(id('github-panel').hidden, true);
});
id('close-github').addEventListener('click', () => setGithubPanel(false, true));
id('public-current-names').addEventListener('click', useCurrentPublicNames);
id('public-generic-names').addEventListener('click', () => {
  if (!publicAvailable()) return;
  publicDraft = genericPublicDraft();
  publicDraftChanged();
  renderPublicLabels();
});
id('prepare-public-report').addEventListener('click', preparePublicPreview);
id('confirm-public-report').addEventListener('change', (event) => {
  if (event.currentTarget.checked) void verifyPublicFreshness();
  else {
    publicConfirmed = null;
    publicMessage('Public downloads require confirmation.');
    updatePublicControls();
  }
});
id('recover-download').addEventListener('click', downloadRecovery);
id('quit').addEventListener('click', quit);
id('check-host').addEventListener('click', checkHost);
window.addEventListener('beforeunload', (event) => {
  if (editorDirty() || initialDraft() || (reviewForm && ['reviewer', 'review-scope', 'review-note'].some((key) => id(key).value))) {
    event.preventDefault();
    event.returnValue = '';
  }
});

async function connectSession() {
  const launchCode = new URLSearchParams(location.hash.slice(1)).get('launch');
  if (location.hash) history.replaceState(null, '', location.pathname);
  try {
    if (launchCode) {
      forgetToken();
      const result = await api('/api/session', { launchCode });
      sessionStorage.setItem(sessionKey, result.token);
      token = result.token;
    } else {
      token = sessionStorage.getItem(sessionKey);
    }
  } catch {
    accessPanel('Restart the local host and use its new launch link. The previous exchange cannot be repeated.');
    return;
  }
  if (token) await refreshBoard();
  else accessPanel();
}

void connectSession();
