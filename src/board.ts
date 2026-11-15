
import { createHash, randomUUID } from 'node:crypto';
import { createCurrentBackup, createExport, createRecovery } from './export.ts';
import type { CurrentBackup, ExportPackage, Recovery } from './export.ts';
import { createPublicExport } from './public-export.ts';
import type { PublicExportFiles, PublicReport } from './public-export.ts';
import { sampleSnapshot } from './sample.ts';
import { SqliteStore, StoreError, sqliteCode } from './store.ts';
import type { CapturedRows, StoreAccess, StoredDocument } from './store.ts';

const snapshotLimit = 2 * 1024 * 1024;
const reviewLimit = 2000;
const staleNote = 'Reviewed work or prerequisite acceptance changed.';
const revisionLimit = 2147483647;
const stages = ['Plan', 'Build', 'Verify', 'Release'] as const;
const priorities = ['P0', 'P1', 'P2'] as const;
const statuses = ['Planned', 'In progress', 'Needs review', 'Blocked'] as const;
const scopes = ['source', 'unit', 'local', 'assistant', 'remote', 'public'] as const;
const outcomes = ['passed', 'failed', 'unknown', 'not-run'] as const;
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const generationPattern = new RegExp('^' + uuid + '$');
const boardIdPattern = new RegExp('^b_' + uuid + '$');
const versionPattern = new RegExp('^' + uuid + ':[1-9][0-9]{0,9}$');

type Project = {
  name: string;
  goal: string;
  stage: typeof stages[number];
  focusTaskId: string | null;
  nextActions: string[];
};
type Group = { id: string; title: string };
type Criterion = { id: string; requirement: string; evidenceIds: string[] };
type Task = {
  id: string;
  title: string;
  description: string;
  owner: string;
  priority: typeof priorities[number];
  status: typeof statuses[number];
  milestoneId: string | null;
  workstreamId: string | null;
  prerequisites: string[];
  criteria: Criterion[];
  blockers: string[];
  evidenceIds: string[];
};
type Evidence = {
  id: string;
  title: string;
  scope: typeof scopes[number];
  outcome: typeof outcomes[number];
  location: string;
  recordedAt: string;
  supersedesId: string | null;
};

type SnapshotFields = {
  boardId: string;
  generation: string;
  revision: number;
  updatedAt: string;
  project: Project;
  milestones: Group[];
  workstreams: Group[];
  tasks: Task[];
  evidence: Evidence[];
};
type ReviewBasis = {
  task: Task;
  projectGoal: string;
  milestoneTitle: string | null;
  workstreamTitle: string | null;
  evidence: Evidence[];
  prerequisites: { taskId: string; reviewId: string | null }[];
};
type HumanDecision = 'accepted' | 'changes-requested';
type ReviewState = HumanDecision | 'stale' | 'unreviewed';
type ReviewRecord = {
  id: string;
  taskId: string;
  generation: string;
  recordedAt: string;
  decision: Exclude<ReviewState, 'unreviewed'>;
  reviewer: string;
  scope: string;
  note: string;
  basis: ReviewBasis | null;
  basisSha256: string;
  previousReviewId: string | null;
};
type ReviewArchive = {
  boardId: string;
  generation: string;
  revision: number;
  snapshotSha256: string;
  reviewCount: number;
  continuedAt: string;
};
type ReviewFields = SnapshotFields & { reviews: ReviewRecord[]; reviewArchive: ReviewArchive | null };
type ReviewedSnapshot = (ReviewFields & { schemaVersion: 2 }) | ConnectedSnapshot;
export type Snapshot = (SnapshotFields & { schemaVersion: 1 }) | ReviewedSnapshot;
type TaskReview = { taskId: string; state: ReviewState; latestReviewId: string | null; historicalCount: number };
type GroupCount = { id: string; totalTasks: number; openTasks: number };
export type Report = {
  counts: { tasks: number; open: number; inProgress: number; blocked: number; needsReview: number };
  acceptance: { available: true; accepted: number; stale: number; changesRequested: number };
  taskReviews: TaskReview[];
  milestones: GroupCount[];
  workstreams: GroupCount[];
  focusTaskId: string | null;
  nextActions: string[];
};

export type Initialized = { initialized: true; snapshot: Snapshot; version: string; report: Report };
type CreatedIds = {
  taskId?: string;
  taskIds?: string[];
  criterionIds?: string[];
  milestoneId?: string;
  workstreamId?: string;
  evidenceId?: string;
  reviewId?: string;
};
export type Changed = Initialized & { committed: boolean; createdIds: CreatedIds };
type Code = 'IO_NOT_COMMITTED' | 'INVALID_INPUT' | 'LIMIT_REACHED' | 'NOT_INITIALIZED' | 'ALREADY_EXISTS' |
  'REVISION_CONFLICT' | 'BOARD_BUSY' | 'UNSUPPORTED_VERSION' | 'RECOVERY_REQUIRED' | 'IO_OUTCOME_UNKNOWN' | 'CLOSED';
export type Failure = {
  error: { code: Code; message: string; fields?: string[] };
  current?: Omit<Initialized, 'initialized'>;
  recoveryAvailable?: boolean;
};
type Result<T> = T | Failure;
export type BoardReader = Readonly<{
  read(): Result<Initialized | { initialized: false }>;
  close(): Result<{ closed: true }>;
}>;
type BoardRow = StoredDocument & { snapshot: Snapshot };
type Captured = { current?: BoardRow; predecessor?: BoardRow; valid: boolean };
type Input = Record<string, unknown>;

const projectKeys = ['name', 'goal', 'stage', 'focusTaskId', 'nextActions'];
const taskEditKeys = [
  'title', 'description', 'owner', 'priority', 'status', 'milestoneId', 'workstreamId',
  'prerequisites', 'blockers', 'evidenceIds',
];
const evidenceInputKeys = ['title', 'scope', 'outcome', 'location', 'supersedesId'];

class ValidationError extends Error {
  readonly result: Failure;
  constructor(code: 'INVALID_INPUT' | 'LIMIT_REACHED' | 'UNSUPPORTED_VERSION', field: string, message: string) {
    super(message);
    this.result = { error: { code, message, fields: [field] } };
  }
}

function invalid(field: string, message = 'Value does not match the board contract.'): never {
  throw new ValidationError('INVALID_INPUT', field, message);
}

function limit(field: string): never {
  throw new ValidationError('LIMIT_REACHED', field, 'The board or value exceeds its allowed size.');
}

function failure(code: Code, message: string): Failure {
  return { error: { code, message } };
}

function isFailure(value: unknown): value is Failure {
  return typeof value === 'object' && value !== null && 'error' in value;
}

function object(value: unknown, field: string): Input {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(field, 'Expected an object.');
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(field, 'Expected a plain object.');
  return value as Input;
}

function fields(value: unknown, field: string, allowed: readonly string[], required = allowed): Input {
  const input = object(value, field);
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string' || !allowed.includes(key)) invalid(field, 'Object contains an unknown field.');
  }
  for (const key of required) {
    if (!Object.hasOwn(input, key)) invalid(field + '.' + key, 'A required field is missing.');
  }
  return input;
}

function patch(value: unknown, field: string, allowed: readonly string[]): Input {
  const input = fields(value, field, allowed, []);
  if (Object.keys(input).length === 0) invalid(field, 'An edit requires at least one field.');
  return input;
}

function text(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== 'string' || value.length < min || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(value)) {
    invalid(field, 'Expected text with a supported length and characters.');
  }
  if (value.length > max) limit(field);
  return value;
}

function choice<T extends string>(value: unknown, field: string, values: readonly T[]): T {
  const match = values.find((candidate) => candidate === value);
  if (match === undefined) invalid(field, 'Unknown option.');
  return match;
}

function id(value: unknown, prefix: string, field: string): string {
  if (typeof value !== 'string' || !new RegExp('^' + prefix + uuid + '$').test(value)) {
    invalid(field, 'Expected a canonical board record ID.');
  }
  return value;
}

function nullableId(value: unknown, prefix: string, field: string): string | null {
  return value === null ? null : id(value, prefix, field);
}

function timestamp(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value)) {
    invalid(field, 'Expected an ISO UTC timestamp.');
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString().slice(0, 19) !== value.slice(0, 19)) {
    invalid(field, 'Invalid UTC date or time.');
  }
  return value;
}

function revision(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > revisionLimit) {
    invalid(field, 'Expected a supported positive revision.');
  }
  return value;
}

function expectedVersion(value: unknown): string {
  if (typeof value !== 'string' || !versionPattern.test(value)) invalid('expectedVersion', 'Expected a generation and revision.');
  revision(Number(value.split(':')[1]), 'expectedVersion');
  return value;
}

function list<T>(value: unknown, field: string, max: number, parse: (item: unknown, field: string) => T): T[] {
  if (!Array.isArray(value)) invalid(field, 'Expected a list.');
  if (value.length > max) limit(field);
  return Array.from(value, (item, index) => parse(item, field + '[' + index + ']'));
}

function idSet(value: unknown, field: string, prefix: string, max: number): string[] {
  const ids = list(value, field, max, (entry, at) => id(entry, prefix, at));
  if (new Set(ids).size !== ids.length) invalid(field, 'Duplicate reference.');
  return ids.sort();
}

function group(value: unknown, field: string, prefix: string): Group {
  const entry = fields(value, field, ['id', 'title']);
  return { id: id(entry.id, prefix, field + '.id'), title: text(entry.title, field + '.title', 1, 200) };
}

function criterion(value: unknown, field: string): Criterion {
  const entry = fields(value, field, ['id', 'requirement', 'evidenceIds']);
  return {
    id: id(entry.id, 'c_', field + '.id'),
    requirement: text(entry.requirement, field + '.requirement', 1, 2000),
    evidenceIds: idSet(entry.evidenceIds, field + '.evidenceIds', 'e_', 100),
  };
}

function task(value: unknown, field: string): Task {
  const entry = fields(value, field, ['id', ...taskEditKeys, 'criteria']);
  return {
    id: id(entry.id, 't_', field + '.id'),
    title: text(entry.title, field + '.title', 1, 200),
    description: text(entry.description, field + '.description', 0, 16000),
    owner: text(entry.owner, field + '.owner', 0, 200),
    priority: choice(entry.priority, field + '.priority', priorities),
    status: choice(entry.status, field + '.status', statuses),
    milestoneId: nullableId(entry.milestoneId, 'm_', field + '.milestoneId'),
    workstreamId: nullableId(entry.workstreamId, 'w_', field + '.workstreamId'),
    prerequisites: idSet(entry.prerequisites, field + '.prerequisites', 't_', 10000),
    criteria: list(entry.criteria, field + '.criteria', 20, criterion),
    blockers: list(entry.blockers, field + '.blockers', 20, (entry, at) => text(entry, at, 1, 1000)),
    evidenceIds: idSet(entry.evidenceIds, field + '.evidenceIds', 'e_', 100),
  };
}

function evidence(value: unknown, field: string): Evidence {
  const entry = fields(value, field, ['id', ...evidenceInputKeys, 'recordedAt']);
  return {
    id: id(entry.id, 'e_', field + '.id'),
    title: text(entry.title, field + '.title', 1, 200),
    scope: choice(entry.scope, field + '.scope', scopes),
    outcome: choice(entry.outcome, field + '.outcome', outcomes),
    location: text(entry.location, field + '.location', 0, 2048),
    recordedAt: timestamp(entry.recordedAt, field + '.recordedAt'),
    supersedesId: nullableId(entry.supersedesId, 'e_', field + '.supersedesId'),
  };
}

function validateReferences(snapshot: SnapshotFields): void {
  const unique = (items: readonly { id: string }[], field: string) => {
    const ids = new Set(items.map((item) => item.id));
    if (ids.size !== items.length) invalid(field, 'Duplicate record ID.');
    return ids;
  };
  const reference = (target: string | null, valid: Set<string>, field: string) => {
    if (target !== null && !valid.has(target)) invalid(field, 'Reference does not identify an existing record.');
  };
  const milestones = unique(snapshot.milestones, 'milestones');
  const workstreams = unique(snapshot.workstreams, 'workstreams');
  const tasks = unique(snapshot.tasks, 'tasks');
  const evidence = unique(snapshot.evidence, 'evidence');
  unique(snapshot.tasks.flatMap((entry) => entry.criteria), 'tasks.criteria');
  reference(snapshot.project.focusTaskId, tasks, 'project.focusTaskId');
  const earlier = new Set<string>();
  snapshot.evidence.forEach((entry, index) => {
    reference(entry.supersedesId, earlier, 'evidence[' + index + '].supersedesId');
    earlier.add(entry.id);
  });

  let edges = 0;
  snapshot.tasks.forEach((entry, index) => {
    const field = 'tasks[' + index + ']';
    reference(entry.milestoneId, milestones, field + '.milestoneId');
    reference(entry.workstreamId, workstreams, field + '.workstreamId');
    for (const link of entry.evidenceIds) reference(link, evidence, field + '.evidenceIds');
    entry.criteria.forEach((check, checkIndex) => {
      for (const link of check.evidenceIds) reference(link, evidence, field + '.criteria[' + checkIndex + '].evidenceIds');
    });
    edges += entry.prerequisites.length;
    if (edges > 10000) limit('tasks.prerequisites');
    for (const link of entry.prerequisites) {
      reference(link, tasks, field + '.prerequisites');
      if (link === entry.id) invalid(field + '.prerequisites', 'A task cannot depend on itself.');
    }
  });
  prerequisiteFirst(snapshot.tasks);
}

function prerequisiteFirst(tasks: Task[]): Task[] {
  const dependents = new Map(tasks.map((task) => [task.id, [] as Task[]]));
  const remaining = new Map<string, number>();
  const ready: Task[] = [];
  for (const task of tasks) {
    for (const prerequisite of task.prerequisites) dependents.get(prerequisite)!.push(task);
    remaining.set(task.id, task.prerequisites.length);
    if (task.prerequisites.length === 0) ready.push(task);
  }
  for (let index = 0; index < ready.length; index++) {
    for (const dependent of dependents.get(ready[index].id)!) {
      const count = remaining.get(dependent.id)! - 1;
      remaining.set(dependent.id, count);
      if (count === 0) ready.push(dependent);
    }
  }
  if (ready.length !== tasks.length) invalid('tasks.prerequisites', 'Prerequisites contain a cycle.');
  return ready;
}

function sha(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length !== 64 || !/^[0-9a-f]+$/.test(value)) invalid(field, 'Expected a SHA-256 digest.');
  return value;
}

function archive(value: unknown): ReviewArchive {
  const field = 'reviewArchive';
  const entry = fields(value, field, ['boardId', 'generation', 'revision', 'snapshotSha256', 'reviewCount', 'continuedAt']);
  const count = revision(entry.reviewCount, field + '.reviewCount');
  if (count > reviewLimit) invalid(field + '.reviewCount', 'The archive count exceeds the supported limit.');
  return {
    boardId: id(entry.boardId, 'b_', field + '.boardId'), generation: id(entry.generation, '', field + '.generation'),
    revision: revision(entry.revision, field + '.revision'), snapshotSha256: sha(entry.snapshotSha256, field + '.snapshotSha256'),
    reviewCount: count, continuedAt: timestamp(entry.continuedAt, field + '.continuedAt'),
  };
}

function basis(value: unknown, field: string): ReviewBasis {
  const entry = fields(value, field, ['task', 'projectGoal', 'milestoneTitle', 'workstreamTitle', 'evidence', 'prerequisites']);
  const subject = task(entry.task, field + '.task');
  const evidenceRecords = list(entry.evidence, field + '.evidence', 2000, evidence);
  const earlier = new Set<string>();
  for (const record of evidenceRecords) {
    if (earlier.has(record.id) || (record.supersedesId !== null && !earlier.has(record.supersedesId))) {
      invalid(field + '.evidence', 'Historical evidence must retain unique records and earlier supersession references.');
    }
    earlier.add(record.id);
  }
  if ([...subject.evidenceIds, ...subject.criteria.flatMap((criterion) => criterion.evidenceIds)].some((id) => !earlier.has(id))) {
    invalid(field + '.evidence', 'The captured task references missing historical evidence.');
  }
  if (new Set(subject.criteria.map(({ id }) => id)).size !== subject.criteria.length) {
    invalid(field + '.task.criteria', 'Duplicate historical criterion ID.');
  }
  const prerequisites = list(entry.prerequisites, field + '.prerequisites', 10000, (value, at) => {
    const record = fields(value, at, ['taskId', 'reviewId']);
    return { taskId: id(record.taskId, 't_', at + '.taskId'), reviewId: nullableId(record.reviewId, 'r_', at + '.reviewId') };
  });
  if (prerequisites.length !== subject.prerequisites.length ||
      prerequisites.some((record, index) => record.taskId !== subject.prerequisites[index] || record.taskId === subject.id)) {
    invalid(field + '.prerequisites', 'Historical prerequisite IDs must match the captured task.');
  }
  const title = (value: unknown, at: string) => value === null ? null : text(value, at, 1, 200);
  const milestoneTitle = title(entry.milestoneTitle, field + '.milestoneTitle');
  const workstreamTitle = title(entry.workstreamTitle, field + '.workstreamTitle');
  if ((subject.milestoneId === null) !== (milestoneTitle === null) ||
      (subject.workstreamId === null) !== (workstreamTitle === null)) {
    invalid(field, 'Historical group titles must match the captured group assignments.');
  }
  return {
    task: subject, projectGoal: text(entry.projectGoal, field + '.projectGoal', 0, 16000),
    milestoneTitle, workstreamTitle, evidence: evidenceRecords, prerequisites,
  };
}

function normalizeReviews(value: unknown, snapshot: SnapshotFields): ReviewRecord[] {
  const earlier = new Map<string, ReviewRecord>();
  const lastByTask = new Map<string, string>();
  const tasks = new Set(snapshot.tasks.map(({ id }) => id));
  return list(value, 'reviews', reviewLimit, (item, field) => {
    const entry = fields(item, field, ['id', 'taskId', 'generation', 'recordedAt', 'decision', 'reviewer', 'scope', 'note',
      'basis', 'basisSha256', 'previousReviewId']);
    const recordId = id(entry.id, 'r_', field + '.id');
    const taskId = id(entry.taskId, 't_', field + '.taskId');
    const generation = id(entry.generation, '', field + '.generation');
    const recordedAt = timestamp(entry.recordedAt, field + '.recordedAt');
    const decision = choice(entry.decision, field + '.decision', ['accepted', 'changes-requested', 'stale']);
    const reviewer = text(entry.reviewer, field + '.reviewer', decision === 'stale' ? 0 : 1, decision === 'stale' ? 0 : 200);
    const scope = text(entry.scope, field + '.scope', 1, 500);
    const note = text(entry.note, field + '.note', 1, 2000);
    const basisSha256 = sha(entry.basisSha256, field + '.basisSha256');
    const previousReviewId = nullableId(entry.previousReviewId, 'r_', field + '.previousReviewId');
    const previous = previousReviewId === null ? undefined : earlier.get(previousReviewId);
    if (!tasks.has(taskId) || earlier.has(recordId)) invalid(field, 'Unknown task or duplicate review ID.');
    if (previousReviewId !== null && previous?.taskId !== taskId) {
      invalid(field + '.previousReviewId', 'The previous review must be an earlier record for this task.');
    }

    let subject: ReviewBasis | null = null;
    if (decision === 'stale') {
      if (entry.basis !== null || note !== staleNote || previous?.decision !== 'accepted' ||
          previous.generation !== generation || previous.scope !== scope || previous.basisSha256 !== basisSha256) {
        invalid(field, 'Invalid system invalidation record.');
      }
    } else {
      if (previousReviewId !== (lastByTask.get(taskId) ?? null)) {
        invalid(field + '.previousReviewId', 'A human review must follow the last review for the task.');
      }
      subject = basis(entry.basis, field + '.basis');
      if (digest(JSON.stringify(subject)) !== basisSha256) invalid(field + '.basisSha256', 'The captured review basis digest does not match.');
      if (decision === 'accepted' && subject.prerequisites.some(({ reviewId }) => reviewId === null)) {
        invalid(field + '.basis.prerequisites', 'An accepted subject must record prerequisite reviews.');
      }
    }
    const record: ReviewRecord = {
      id: recordId, taskId, generation, recordedAt, decision, reviewer, scope, note,
      basis: subject, basisSha256, previousReviewId,
    };
    earlier.set(recordId, record);
    lastByTask.set(taskId, recordId);
    return record;
  });
}


const githubKinds = ['issues', 'pull-requests', 'workflow-runs', 'releases', 'pull-request-reviews'] as const;
const githubFactKinds = ['pull-request', 'workflow-run', 'release', 'pull-request-review'] as const;
const issueFields = ['title', 'body', 'state'] as const;
const issueStates = ['open', 'closed'] as const;
const githubCodes = [
  'CONFIG_REQUIRED', 'PLATFORM_UNSUPPORTED', 'CONNECTION_BUSY', 'CONNECTION_REQUIRED', 'AUTH_DENIED', 'AUTH_EXPIRED',
  'AUTH_CANCELLED', 'INSTALLATION_REQUIRED', 'PERMISSION_REQUIRED', 'REPOSITORY_UNAVAILABLE', 'DESTINATION_MISMATCH',
  'RATE_LIMITED', 'NETWORK_FAILED', 'REQUEST_TIMEOUT', 'RESPONSE_INVALID', 'RESPONSE_LIMIT', 'OPERATION_LIMIT',
  'CREDENTIAL_UNAVAILABLE', 'CREDENTIAL_ROTATION_UNCERTAIN', 'CREDENTIAL_MISMATCH', 'PREVIEW_EXPIRED',
  'OPERATION_CANCELLED', 'CLEANUP_UNKNOWN',
] as const;
export type GithubCode = typeof githubCodes[number];
export type GithubKind = typeof githubKinds[number];
export type GithubFactKind = typeof githubFactKinds[number];
type IssueField = typeof issueFields[number];
export type GithubIssueValues = { title: string; body: string; state: typeof issueStates[number] };
export type GithubRepository = {
  id: string; installationId: string; installationPageHint: number; repositoryPageHint: number;
  owner: string; name: string; visibility: 'public' | 'private' | 'internal'; defaultBranch: string | null;
  selectedAt: string; selectedByHuman: true;
};
type IssueMapping = {
  localTaskId: string; repositoryId: string; issueId: string; number: number; fetchedAt: string; remoteUpdatedAt: string;
  common: GithubIssueValues; remote: GithubIssueValues; localIssueState: GithubIssueValues['state'];
  availability: 'observed' | 'unknown' | 'historical'; conflictFields: IssueField[];
};
type FactBase = { id: string; repositoryId: string; observedAt: string };
export type GithubFact =
  | (FactBase & { kind: 'pull-request'; number: number; state: GithubIssueValues['state']; merged: boolean | null;
      headSha: string | null; baseRef: string | null; updatedAt: string })
  | (FactBase & { kind: 'workflow-run'; workflowId: string; status: string | null; conclusion: string | null;
      headSha: string | null; headBranch: string | null; attempt: number; createdAt: string; updatedAt: string })
  | (FactBase & { kind: 'release'; tagName: string; targetCommitish: string; draft: boolean;
      prerelease: boolean; publishedAt: string | null })
  | (FactBase & { kind: 'pull-request-review'; pullRequestId: string; number: number; commitId: string | null;
      state: string; authorLogin: string | null; submittedAt: string | null });
export type GithubCollection = {
  kind: GithubKind; pullRequestId: string | null; page: number; pagesFetched: number; count: number;
  observedAt: string; completeness: 'complete-for-scope' | 'partial';
};
type GithubAttempt = { at: string; outcome: 'success' | 'partial' | 'failed' | 'cancelled'; code: GithubCode | null };
export type GithubState = {
  selection: 'none' | 'disconnected' | 'selected'; connectionEpoch: string; repository: GithubRepository | null;
  issues: IssueMapping[]; facts: GithubFact[]; collections: GithubCollection[]; lastAttempt: GithubAttempt | null;
};
type GithubSnapshot = ReviewFields & { schemaVersion: 3; github: GithubState };

export const publicationFields = issueFields;
export type PublicationField = IssueField;
export type PublicationValues = Partial<GithubIssueValues>;
export type PublicationIssue = { id: string; number: number };
type PublicationDestination = Pick<GithubRepository, 'id' | 'owner' | 'name' | 'visibility'>;
export type PublicationIntent = {
  id: string; batchId: string;
  origin: { boardId: string; generation: string; revision: number; connectionEpoch: string; taskId: string };
  repository: PublicationDestination; action: 'create' | 'update'; issue: PublicationIssue | null;
  fields: PublicationField[]; before: PublicationValues | null; proposed: PublicationValues; preparedAt: string;
};
const publicationCodes = ['PRE_SEND_REFUSED', 'PROVIDER_REJECTED', 'RATE_LIMITED', 'AUTH_REQUIRED', 'DESTINATION_CHANGED',
  'CANCELLED', 'TIMEOUT', 'NETWORK_FAILED', 'INVALID_RESPONSE', 'RESPONSE_LIMIT', 'OPERATION_LIMIT',
  'READBACK_FAILED', 'READBACK_MISMATCH', 'VERIFIED'] as const;
export type PublicationOutcome = {
  kind: 'not-sent' | 'rejected' | 'unknown' | 'conflict' | 'confirmed';
  at: string; code: typeof publicationCodes[number] | null; httpStatus: number | null;
  issue: PublicationIssue | null; remoteUpdatedAt: string | null; observedSha256: string | null; matched: boolean | null;
};
type PublicationReconciliation = {
  kind: 'linked' | 'observed-match' | 'observed-conflict'; at: string; issue: PublicationIssue;
  observedSha256: string; matched: boolean; actorConfirmed: true;
};
export type PublicationRecord = {
  intent: PublicationIntent; associationTaskId: string | null; attemptedAt: string | null;
  outcome: PublicationOutcome | null; reconciliation: PublicationReconciliation | null; mergePendingFields: PublicationField[];
};
type CreationLink = { intentId: string; associationTaskId: string | null; repositoryId: string; issue: PublicationIssue };
type PublicationArchive = {
  at: string; boardId: string; generation: string; revision: number; backupSha256: string; recordIds: string[];
};
type PublicationState = { records: PublicationRecord[]; creationLinks: CreationLink[]; retired: PublicationArchive | null };
type PublicationSnapshot = ReviewFields & { schemaVersion: 4; github: GithubState; publication: PublicationState };
type ConnectedSnapshot = GithubSnapshot | PublicationSnapshot;
export function hasGithub(snapshot: Snapshot): snapshot is ConnectedSnapshot {
  return snapshot.schemaVersion === 3 || snapshot.schemaVersion === 4;
}
export function publicationValues(values: GithubIssueValues, keys: readonly PublicationField[]): PublicationValues {
  return Object.fromEntries(keys.map((key) => [key, values[key]]));
}
export function publicationDestination(repo: GithubRepository): PublicationDestination {
  return { id: repo.id, owner: repo.owner, name: repo.name, visibility: repo.visibility };
}
export function samePublicationIssue(a: PublicationIssue | null, b: PublicationIssue | null): boolean {
  return a === null || b === null ? a === b : a.id === b.id && a.number === b.number;
}
export function publicationState(record: PublicationRecord): PublicationOutcome['kind'] | 'prepared' {
  return record.outcome?.kind ?? (record.attemptedAt ? 'unknown' : 'prepared');
}
function publicationObject(value: unknown, field: string, keys: readonly string[]): Input {
  const row = fields(value, field, keys);
  if (keys.some((key) => !('value' in Object.getOwnPropertyDescriptor(row, key)!))) invalid(field);
  return row;
}
function publicationKeys(value: unknown, field: string): PublicationField[] {
  const keys = list(value, field, 3, (entry, at) => choice(entry, at, issueFields));
  if (issueFields.filter((key) => keys.includes(key)).join() !== keys.join()) invalid(field);
  return keys;
}
function publicationIds(value: unknown, field: string): string[] {
  const values = list(value, field, 20, (entry, at) => id(entry, '', at));
  if (!values.length || new Set(values).size !== values.length) invalid(field);
  return values;
}
function parsePublicationIssue(value: unknown, field: string): PublicationIssue {
  const row = publicationObject(value, field, ['id', 'number']);
  return { id: githubId(row.id, field), number: githubInteger(row.number, field) };
}
function parsePublicationValues(value: unknown, field: string, keys: PublicationField[]): PublicationValues {
  const row = publicationObject(value, field, keys);
  return Object.fromEntries(keys.map((key) => [key, key === 'state' ? choice(row[key], field, issueStates)
    : text(row[key], field, key === 'title' ? 1 : 0, key === 'title' ? 200 : 16000)]));
}
function parseIntent(value: unknown, field: string): PublicationIntent {
  const row = publicationObject(value, field, ['id', 'batchId', 'origin', 'repository', 'action', 'issue', 'fields', 'before', 'proposed', 'preparedAt']);
  const origin = publicationObject(row.origin, field, ['boardId', 'generation', 'revision', 'connectionEpoch', 'taskId']);
  const repo = publicationObject(row.repository, field, ['id', 'owner', 'name', 'visibility']);
  const name = githubWord(repo.name, field, 100, /^[A-Za-z0-9_.-]+$/);
  if (name === '.' || name === '..') invalid(field);
  const action = choice(row.action, field, ['create', 'update'] as const);
  const keys = publicationKeys(row.fields, field);
  const issue = optionalGithub(row.issue, (entry) => parsePublicationIssue(entry, field));
  const before = optionalGithub(row.before, (entry) => parsePublicationValues(entry, field, keys));
  if (!keys.length || (action === 'create'
    ? !keys.includes('title') || keys.includes('state') || issue !== null || before !== null
    : issue === null || before === null)) invalid(field);
  const proposed = parsePublicationValues(row.proposed, field, keys);
  if (before && keys.some((key) => before[key] === proposed[key])) invalid(field);
  return {
    id: id(row.id, '', field), batchId: id(row.batchId, '', field),
    origin: { boardId: id(origin.boardId, 'b_', field), generation: id(origin.generation, '', field),
      revision: revision(origin.revision, field), connectionEpoch: id(origin.connectionEpoch, '', field), taskId: id(origin.taskId, 't_', field) },
    repository: { id: githubId(repo.id, field), owner: githubWord(repo.owner, field, 100, /^[A-Za-z0-9-]+$/), name,
      visibility: choice(repo.visibility, field, ['public', 'private', 'internal'] as const) },
    action, issue, fields: keys, before, proposed, preparedAt: timestamp(row.preparedAt, field),
  };
}
function parseOutcome(value: unknown, field: string): PublicationOutcome {
  const row = publicationObject(value, field, ['kind', 'at', 'code', 'httpStatus', 'issue', 'remoteUpdatedAt', 'observedSha256', 'matched']);
  const outcome: PublicationOutcome = {
    kind: choice(row.kind, field, ['not-sent', 'rejected', 'unknown', 'conflict', 'confirmed'] as const),
    at: timestamp(row.at, field), code: optionalGithub(row.code, (v) => choice(v, field, publicationCodes)),
    httpStatus: optionalGithub(row.httpStatus, (v) => githubInteger(v, field, 599, 100)),
    issue: optionalGithub(row.issue, (v) => parsePublicationIssue(v, field)),
    remoteUpdatedAt: optionalGithub(row.remoteUpdatedAt, (v) => timestamp(v, field)),
    observedSha256: optionalGithub(row.observedSha256, (v) => sha(v, field)),
    matched: optionalGithub(row.matched, (v) => githubBoolean(v, field)),
  };
  if (outcome.kind === 'confirmed' || outcome.kind === 'conflict') {
    if (!outcome.issue || !outcome.observedSha256 || outcome.matched !== (outcome.kind === 'confirmed') ||
        (outcome.kind === 'confirmed' && !outcome.remoteUpdatedAt)) invalid(field);
  } else if (outcome.matched !== null || outcome.observedSha256 !== null || outcome.remoteUpdatedAt !== null) invalid(field);
  if (outcome.kind === 'not-sent' && (outcome.issue || outcome.httpStatus !== null)) invalid(field);
  if (outcome.kind === 'rejected' && (outcome.httpStatus === null ||
      ![400, 401, 403, 404, 410, 422, 429].includes(outcome.httpStatus))) invalid(field);
  return outcome;
}
function parseReconciliation(value: unknown, field: string): PublicationReconciliation {
  const row = publicationObject(value, field, ['kind', 'at', 'issue', 'observedSha256', 'matched', 'actorConfirmed']);
  const kind = choice(row.kind, field, ['linked', 'observed-match', 'observed-conflict'] as const);
  const matched = githubBoolean(row.matched, field);
  if (row.actorConfirmed !== true || (kind !== 'linked' && matched !== (kind === 'observed-match'))) invalid(field);
  return { kind, at: timestamp(row.at, field), issue: parsePublicationIssue(row.issue, field),
    observedSha256: sha(row.observedSha256, field), matched, actorConfirmed: true };
}
function exactMapping(snapshot: ConnectedSnapshot, taskId: string | null, repositoryId: string, issue: PublicationIssue | null) {
  if (!issue || taskId === null) return undefined;
  return snapshot.github.issues.find((m) => m.localTaskId === taskId && m.repositoryId === repositoryId &&
    m.issueId === issue.id && m.number === issue.number);
}
function relatedPublication(snapshot: Snapshot, mapping: IssueMapping): PublicationRecord[] {
  return snapshot.schemaVersion !== 4 ? [] : snapshot.publication.records.filter((record) =>
    record.associationTaskId === mapping.localTaskId && record.intent.repository.id === mapping.repositoryId &&
    samePublicationIssue(record.intent.issue, { id: mapping.issueId, number: mapping.number }));
}
function publicationAnchors(snapshot: Snapshot, mapping: IssueMapping): PublicationValues {
  return Object.fromEntries(relatedPublication(snapshot, mapping).flatMap((record) =>
    record.mergePendingFields.map((key) => [key, record.intent.proposed[key]])));
}
function uncertainPublication(record: PublicationRecord): boolean {
  return record.attemptedAt !== null && ['unknown', 'conflict'].includes(publicationState(record)) && !record.reconciliation;
}
export function githubPendingFields(snapshot: Snapshot, task: Task, mapping: IssueMapping): PublicationField[] {
  const anchors = publicationAnchors(snapshot, mapping);
  const local = localIssue(task, mapping);
  return issueFields.filter((key) => !mapping.conflictFields.includes(key) && local[key] !== (anchors[key] ?? mapping.common[key]));
}
export function publicationRefusal(snapshot: Snapshot, taskId: string, repositoryId: string, keys: readonly PublicationField[],
  intentId?: string): string | null {
  if (!hasGithub(snapshot) || !snapshot.tasks.some((task) => task.id === taskId)) return 'Select a current saved task.';
  const mapping = snapshot.github.issues.find((m) => m.localTaskId === taskId);
  if (!mapping && snapshot.schemaVersion === 4 && (snapshot.publication.creationLinks.some((link) =>
    link.associationTaskId === taskId && link.repositoryId === repositoryId) || snapshot.publication.records.some((record) =>
    record.intent.id !== intentId && record.intent.action === 'create' && record.associationTaskId === taskId &&
    record.intent.repository.id === repositoryId && (uncertainPublication(record) || record.reconciliation !== null ||
    record.outcome?.kind === 'confirmed')))) return 'Inspect and link the previously recorded issue before publishing.';
  if (mapping && (mapping.repositoryId !== repositoryId || mapping.availability !== 'observed' ||
    keys.some((key) => mapping.conflictFields.includes(key)))) return 'Refresh or resolve the saved issue before publishing.';
  if (mapping && relatedPublication(snapshot, mapping).some((record) => record.intent.id !== intentId &&
    (uncertainPublication(record) || record.mergePendingFields.length || record.intent.fields.some((key) => mapping.conflictFields.includes(key))))) {
    return 'Inspect the earlier send, refresh or resolve the issue before publishing again.';
  }
  return null;
}

export function publicationTarget(snapshot: Snapshot, intentId: string) {
  if (snapshot.schemaVersion !== 4) return undefined;
  const record = snapshot.publication.records.find((r) => r.intent.id === intentId);
  if (record) {
    if (!record.attemptedAt || record.outcome?.kind === 'rejected') return undefined;
    const { intent } = record;
    const alreadyKnownUpdate = intent.action === 'update' && !uncertainPublication(record);
    if (alreadyKnownUpdate && (!record.associationTaskId ||
        exactMapping(snapshot, record.associationTaskId, intent.repository.id, intent.issue))) return undefined;
    return { action: intent.action, repositoryId: intent.repository.id, taskId: record.associationTaskId,
      issue: record.reconciliation?.issue ?? record.outcome?.issue ?? intent.issue, record,
      reattachOnly: alreadyKnownUpdate };
  }
  const marker = snapshot.publication.creationLinks.find((link) => link.intentId === intentId);
  return marker && { action: 'create' as const, repositoryId: marker.repositoryId, taskId: marker.associationTaskId,
    issue: marker.issue, record: undefined, reattachOnly: true };
}
export function publicationRetirable(snapshot: Snapshot, record: PublicationRecord): boolean {
  if (!hasGithub(snapshot) || record.mergePendingFields.length) return false;
  const { intent } = record;
  const issue = record.reconciliation?.issue ?? record.outcome?.issue ?? intent.issue;
  const mapping = exactMapping(snapshot, record.associationTaskId, intent.repository.id, issue);
  if (mapping && intent.fields.some((key) => mapping.conflictFields.includes(key))) return false;
  if (!record.attemptedAt || record.outcome?.kind === 'rejected') return true;
  if (record.reconciliation) return true;
  return record.outcome?.kind === 'confirmed' && (intent.action === 'update' || !!mapping);
}
function setPublicationValue<K extends IssueField>(target: GithubIssueValues, key: K, value: PublicationValues) {
  target[key] = value[key]!;
}
function applyPublication(snapshot: PublicationSnapshot, value: unknown): CreatedIds {
  const field = 'publication.operation';
  const command = object(value, field);
  const type = choice(command.type, field, ['prepare-intents', 'mark-attempted', 'settle-outcome',
    'attach-created-mapping', 'reconcile', 'retire'] as const);
  const row = (keys: string[]) => publicationObject(value, field, ['type', ...keys]);
  const state = snapshot.publication;
  const currentRepository = () => {
    if (snapshot.github.selection !== 'selected' || !snapshot.github.repository) invalid(field, 'Select a GitHub repository first.');
    return snapshot.github.repository;
  };
  const currentIntent = (intent: PublicationIntent, taskId: string | null) => {
    const repo = currentRepository();
    if (!taskId || intent.origin.boardId !== snapshot.boardId || intent.origin.generation !== snapshot.generation ||
        intent.origin.connectionEpoch !== snapshot.github.connectionEpoch ||
        JSON.stringify(intent.repository) !== JSON.stringify(publicationDestination(repo))) invalid(field);
    const refusal = publicationRefusal(snapshot, taskId, repo.id, intent.fields, intent.id);
    if (refusal) invalid(field, refusal);
    const task = find(snapshot.tasks, taskId, field);
    const mapping = snapshot.github.issues.find((m) => m.localTaskId === taskId);
    if ((intent.action === 'update') !== !!mapping ||
        (mapping && (!samePublicationIssue(intent.issue, { id: mapping.issueId, number: mapping.number }) ||
          JSON.stringify(intent.before) !== JSON.stringify(publicationValues(mapping.remote, intent.fields))))) invalid(field);
    const local = mapping ? localIssue(task, mapping) : { title: task.title, body: task.description, state: 'open' as const };
    if (JSON.stringify(intent.proposed) !== JSON.stringify(publicationValues(local, intent.fields))) invalid(field);
  };
  const recordFor = (value: unknown) => {
    const intentId = id(value, '', field);
    const record = state.records.find((entry) => entry.intent.id === intentId);
    if (!record) invalid(field);
    return record;
  };
  const observation = (input: Input) => {
    const at = timestamp(input.at, field);
    return { at, issue: parsePublicationIssue(input.issue, field), remote: githubValues(input.remote, field),
      remoteUpdatedAt: timestamp(input.remoteUpdatedAt, field) };
  };
  const attach = (taskId: string | null, repositoryId: string, observed: ReturnType<typeof observation>) => {
    if (!taskId) return;
    const prior = snapshot.github.issues.find((m) => m.localTaskId === taskId ||
      (m.repositoryId === repositoryId && m.issueId === observed.issue.id));
    if (prior) {
      if (!exactMapping(snapshot, taskId, repositoryId, observed.issue)) invalid(field, 'An existing issue link conflicts.');
      return;
    }
    find(snapshot.tasks, taskId, field);
    snapshot.github.issues.push({ localTaskId: taskId, repositoryId, issueId: observed.issue.id, number: observed.issue.number,
      fetchedAt: observed.at, remoteUpdatedAt: observed.remoteUpdatedAt, localIssueState: observed.remote.state,
      common: { ...observed.remote }, remote: observed.remote, availability: 'observed', conflictFields: [] });
  };
  switch (type) {
    case 'prepare-intents': {
      const items = list(row(['intents']).intents, field, 3, parseIntent);
      if (!items.length || new Set(items.map((item) => item.origin.taskId)).size !== items.length ||
          items.some((item) => item.batchId !== items[0].batchId || item.origin.revision !== snapshot.revision)) invalid(field);
      for (const intent of items) {
        currentIntent(intent, intent.origin.taskId);
        state.records.push({ intent, associationTaskId: intent.origin.taskId, attemptedAt: null,
          outcome: null, reconciliation: null, mergePendingFields: [] });
      }
      break;
    }
    case 'mark-attempted': {
      const input = row(['intentId', 'at']);
      const record = recordFor(input.intentId);
      if (record.attemptedAt || record.outcome) invalid(field);
      currentIntent(record.intent, record.associationTaskId);
      record.attemptedAt = timestamp(input.at, field);
      break;
    }
    case 'settle-outcome': {
      const input = row(['intentId', 'outcome']);
      const record = recordFor(input.intentId);
      if (record.outcome || record.reconciliation || record.intent.origin.boardId !== snapshot.boardId ||
          record.intent.origin.generation !== snapshot.generation) invalid(field);
      record.outcome = parseOutcome(input.outcome, field);
      if (record.outcome.kind === 'confirmed' && record.intent.action === 'update' &&
          exactMapping(snapshot, record.associationTaskId, record.intent.repository.id, record.intent.issue)) {
        record.mergePendingFields = [...record.intent.fields];
      }
      break;
    }
    case 'attach-created-mapping': {
      const input = row(['intentId', 'at', 'issue', 'remote', 'remoteUpdatedAt']);
      const record = recordFor(input.intentId);
      const observed = observation(input);
      const repo = currentRepository();
      const { intent } = record;
      if (intent.action !== 'create' || record.outcome?.kind !== 'confirmed' ||
          !samePublicationIssue(record.outcome.issue, observed.issue) || !record.associationTaskId ||
          intent.origin.boardId !== snapshot.boardId || intent.origin.generation !== snapshot.generation ||
          intent.origin.connectionEpoch !== snapshot.github.connectionEpoch ||
          JSON.stringify(intent.repository) !== JSON.stringify(publicationDestination(repo)) ||
          record.outcome.remoteUpdatedAt !== observed.remoteUpdatedAt ||
          record.outcome.observedSha256 !== digest(JSON.stringify(publicationValues(observed.remote, intent.fields))) ||
          observed.remote.state !== 'open') invalid(field);
      attach(record.associationTaskId, repo.id, observed);
      break;
    }
    case 'reconcile': {
      const input = row(['intentId', 'at', 'issue', 'remote', 'remoteUpdatedAt']);
      const observed = observation(input);
      const target = publicationTarget(snapshot, id(input.intentId, '', field));
      const repo = currentRepository();
      if (!target || target.repositoryId !== repo.id || (target.issue && !samePublicationIssue(target.issue, observed.issue))) invalid(field);
      const record = target.record;
      const matched = record ? record.intent.fields.every((key) => record.intent.proposed[key] === observed.remote[key]) : false;
      if (target.reattachOnly) {
        attach(target.taskId, repo.id, observed);
        break;
      }
      if (target.action === 'create') attach(target.taskId, repo.id, observed);
      else if (target.taskId) {
        const prior = exactMapping(snapshot, target.taskId, repo.id, observed.issue);
        if (!prior) attach(target.taskId, repo.id, observed);
        const mapping = exactMapping(snapshot, target.taskId, repo.id, observed.issue)!;
        if (matched) record!.mergePendingFields = [...record!.intent.fields];
        else if (prior) {
          const task = find(snapshot.tasks, target.taskId, field);
          const local = localIssue(task, mapping);
          const anchors = publicationAnchors(snapshot, mapping);
          const selected = record!.intent.fields;
          for (const related of relatedPublication(snapshot, mapping)) {
            related.mergePendingFields = related.mergePendingFields.filter((key) => !selected.includes(key));
          }
          mapping.conflictFields = issueFields.filter((key) => {
            if (selected.includes(key)) {
              setPublicationValue(mapping.common, key, local[key] === observed.remote[key] ? local : record!.intent.proposed);
              return local[key] !== observed.remote[key] && observed.remote[key] !== record!.intent.proposed[key];
            }
            const base = anchors[key] ?? mapping.common[key];
            return local[key] !== observed.remote[key] &&
              (mapping.conflictFields.includes(key) || (local[key] !== base && observed.remote[key] !== base));
          });
          mapping.remote = observed.remote;
          mapping.fetchedAt = observed.at;
          mapping.remoteUpdatedAt = observed.remoteUpdatedAt;
          mapping.availability = 'observed';
        }
      }
      if (record && !record.reconciliation) {
        record.reconciliation = { kind: target.action === 'create' ? 'linked' : matched ? 'observed-match' : 'observed-conflict',
          at: observed.at, issue: observed.issue,
          observedSha256: digest(JSON.stringify(publicationValues(observed.remote, record.intent.fields))), matched, actorConfirmed: true };
      }
      break;
    }
    case 'retire': {
      const input = row(['recordIds', 'backupSha256', 'at']);
      const recordIds = publicationIds(input.recordIds, field);
      const backupSha256 = sha(input.backupSha256, field);
      const records = recordIds.map(recordFor);
      if (records.some((record) => !publicationRetirable(snapshot, record))) invalid(field, 'Inspect or refresh dependent records before archiving.');
      for (const record of records) {
        const issue = record.reconciliation?.issue ?? record.outcome?.issue;
        if (record.intent.action === 'create' && record.attemptedAt && issue) {
          state.creationLinks.push({ intentId: record.intent.id, associationTaskId: record.associationTaskId,
            repositoryId: record.intent.repository.id, issue });
        }
      }
      state.records = state.records.filter((record) => !recordIds.includes(record.intent.id));
      state.retired = { at: timestamp(input.at, field), boardId: snapshot.boardId, generation: snapshot.generation,
        revision: snapshot.revision, backupSha256, recordIds };
      break;
    }
  }
  return {};
}
function settlementBytes(record: PublicationRecord): number {
  const { attemptedAt, outcome, reconciliation, mergePendingFields } = record;
  return Buffer.byteLength(JSON.stringify({ attemptedAt, outcome, reconciliation, mergePendingFields }), 'utf8');
}
function normalizePublication(value: unknown, snapshot: ConnectedSnapshot): PublicationState {
  const field = 'snapshot.publication';
  const row = publicationObject(value, field, ['records', 'creationLinks', 'retired']);
  const taskIds = new Set(snapshot.tasks.map((task) => task.id));
  const association = (value: unknown) => {
    const taskId = nullableId(value, 't_', field);
    if (taskId !== null && !taskIds.has(taskId)) invalid(field);
    return taskId;
  };
  const anchors = new Set<string>();
  const records = list(row.records, field, 20, (entry, at): PublicationRecord => {
    const item = publicationObject(entry, at, ['intent', 'associationTaskId', 'attemptedAt', 'outcome', 'reconciliation', 'mergePendingFields']);
    const record: PublicationRecord = {
      intent: parseIntent(item.intent, at), associationTaskId: association(item.associationTaskId),
      attemptedAt: optionalGithub(item.attemptedAt, (v) => timestamp(v, at)),
      outcome: optionalGithub(item.outcome, (v) => parseOutcome(v, at)),
      reconciliation: optionalGithub(item.reconciliation, (v) => parseReconciliation(v, at)),
      mergePendingFields: publicationKeys(item.mergePendingFields, at),
    };
    const { intent, attemptedAt, outcome, reconciliation, mergePendingFields } = record;
    if (intent.origin.boardId === snapshot.boardId &&
        (record.associationTaskId !== null ? record.associationTaskId !== intent.origin.taskId : taskIds.has(intent.origin.taskId))) invalid(at);
    if ((outcome && (outcome.kind === 'not-sent') !== (attemptedAt === null)) ||
        (attemptedAt && Date.parse(attemptedAt) < Date.parse(intent.preparedAt)) ||
        (outcome && Date.parse(outcome.at) < Date.parse(attemptedAt ?? intent.preparedAt))) invalid(at);
    if (intent.action === 'update' && outcome?.issue && !samePublicationIssue(outcome.issue, intent.issue)) invalid(at);
    if ((outcome?.kind === 'confirmed' || outcome?.kind === 'conflict') &&
        outcome.httpStatus !== (intent.action === 'create' ? 201 : 200)) invalid(at);
    if (reconciliation && (!attemptedAt || outcome?.kind === 'rejected' ||
        (intent.action === 'update' && outcome?.kind === 'confirmed') ||
        Date.parse(reconciliation.at) < Date.parse(outcome?.at ?? attemptedAt) ||
        (intent.action === 'create') !== (reconciliation.kind === 'linked') ||
        (intent.action === 'update' && !samePublicationIssue(reconciliation.issue, intent.issue)) ||
        (intent.action === 'create' && outcome?.issue && !samePublicationIssue(reconciliation.issue, outcome.issue)))) invalid(at);
    if (mergePendingFields.length && (intent.action !== 'update' ||
        !(outcome?.kind === 'confirmed' || reconciliation?.kind === 'observed-match') ||
        !exactMapping(snapshot, record.associationTaskId, intent.repository.id, intent.issue))) invalid(at);
    for (const key of mergePendingFields) {
      const anchor = record.associationTaskId + ':' + intent.repository.id + ':' + intent.issue?.id + ':' + key;
      if (!intent.fields.includes(key) || anchors.has(anchor)) invalid(at);
      anchors.add(anchor);
    }
    if (outcome?.kind === 'confirmed' && outcome.code !== 'VERIFIED') invalid(at);
    if (outcome?.kind === 'conflict' && outcome.code !== 'READBACK_MISMATCH') invalid(at);
    if (settlementBytes(record) > 4096) limit(at);
    return record;
  });
  const recordIds = new Set(records.map((record) => record.intent.id));
  if (recordIds.size !== records.length) invalid(field);
  const linkKeys = new Set<string>();
  const creationLinks = list(row.creationLinks, field, 100, (entry, at): CreationLink => {
    const item = publicationObject(entry, at, ['intentId', 'associationTaskId', 'repositoryId', 'issue']);
    const link = { intentId: id(item.intentId, '', at), associationTaskId: association(item.associationTaskId),
      repositoryId: githubId(item.repositoryId, at), issue: parsePublicationIssue(item.issue, at) };
    const key = link.associationTaskId + ':' + link.repositoryId;
    if (recordIds.has(link.intentId) || (link.associationTaskId && linkKeys.has(key))) invalid(at);
    recordIds.add(link.intentId);
    if (link.associationTaskId) linkKeys.add(key);
    return link;
  });
  const retired = optionalGithub(row.retired, (entry): PublicationArchive => {
    const item = publicationObject(entry, field, ['at', 'boardId', 'generation', 'revision', 'backupSha256', 'recordIds']);
    return { at: timestamp(item.at, field), boardId: id(item.boardId, 'b_', field), generation: id(item.generation, '', field),
      revision: revision(item.revision, field), backupSha256: sha(item.backupSha256, field), recordIds: publicationIds(item.recordIds, field) };
  });
  if (retired?.recordIds.some((intentId) => records.some((record) => record.intent.id === intentId))) invalid(field);
  return { records, creationLinks, retired };
}
const collectionByFact: Record<GithubFactKind, GithubKind> = {
  'pull-request': 'pull-requests', 'workflow-run': 'workflow-runs', release: 'releases',
  'pull-request-review': 'pull-request-reviews',
};

function githubInteger(value: unknown, field: string, maximum = Number.MAX_SAFE_INTEGER, minimum = 1): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) invalid(field);
  return value;
}

function githubId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,15}$/.test(value) || !Number.isSafeInteger(Number(value))) invalid(field);
  return value;
}

function githubWord(value: unknown, field: string, max: number, pattern = /^[^\x00-\x1f\x7f-\x9f]+$/): string {
  const result = text(value, field, 1, max);
  if (!pattern.test(result)) invalid(field);
  return result;
}

function optionalGithub<T>(value: unknown, parse: (value: unknown) => T): T | null {
  return value === null ? null : parse(value);
}

function githubBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') invalid(field);
  return value;
}

function githubRepository(value: unknown, field: string): GithubRepository {
  const row = fields(value, field, ['id', 'installationId', 'installationPageHint', 'repositoryPageHint', 'owner',
    'name', 'visibility', 'defaultBranch', 'selectedAt', 'selectedByHuman']);
  const name = githubWord(row.name, field, 100, /^[A-Za-z0-9_.-]+$/);
  if (name === '.' || name === '..' || row.selectedByHuman !== true) invalid(field);
  return {
    id: githubId(row.id, field), installationId: githubId(row.installationId, field),
    installationPageHint: githubInteger(row.installationPageHint, field, 1000),
    repositoryPageHint: githubInteger(row.repositoryPageHint, field, 1000),
    owner: githubWord(row.owner, field, 100, /^[A-Za-z0-9-]+$/), name,
    visibility: choice(row.visibility, field, ['public', 'private', 'internal'] as const),
    defaultBranch: optionalGithub(row.defaultBranch, (v) => githubWord(v, field, 255)),
    selectedAt: timestamp(row.selectedAt, field), selectedByHuman: true,
  };
}

function githubValues(value: unknown, field: string): GithubIssueValues {
  const row = fields(value, field, issueFields);
  return { title: text(row.title, field + '.title', 1, 200), body: text(row.body, field + '.body', 0, 16000),
    state: choice(row.state, field + '.state', issueStates) };
}

function localIssue(task: Task, mapping: IssueMapping): GithubIssueValues {
  return { title: task.title, body: task.description, state: mapping.localIssueState };
}

function githubConflicts(mapping: IssueMapping, local: GithubIssueValues, anchors: PublicationValues = {}): IssueField[] {
  return issueFields.filter((field) => local[field] !== mapping.remote[field] &&
    (mapping.conflictFields.includes(field) || (anchors[field] === undefined &&
      local[field] !== mapping.common[field] && mapping.remote[field] !== mapping.common[field])));
}

function githubMapping(value: unknown, field: string): IssueMapping {
  const row = fields(value, field, ['localTaskId', 'repositoryId', 'issueId', 'number', 'fetchedAt', 'remoteUpdatedAt',
    'common', 'remote', 'localIssueState', 'availability', 'conflictFields']);
  const conflicts = list(row.conflictFields, field, 3, (entry, at) => choice(entry, at, issueFields));
  if (new Set(conflicts).size !== conflicts.length) invalid(field);
  return { localTaskId: id(row.localTaskId, 't_', field), repositoryId: githubId(row.repositoryId, field),
    issueId: githubId(row.issueId, field), number: githubInteger(row.number, field), fetchedAt: timestamp(row.fetchedAt, field),
    remoteUpdatedAt: timestamp(row.remoteUpdatedAt, field), common: githubValues(row.common, field), remote: githubValues(row.remote, field),
    localIssueState: choice(row.localIssueState, field, issueStates),
    availability: choice(row.availability, field, ['observed', 'unknown', 'historical'] as const),
    conflictFields: conflicts };
}

function githubFact(value: unknown, field: string): GithubFact {
  const baseKeys = ['kind', 'id', 'repositoryId', 'observedAt'];
  const entry = object(value, field);
  const kind = choice(entry.kind, field, githubFactKinds);
  const base = { id: githubId(entry.id, field), repositoryId: githubId(entry.repositoryId, field),
    observedAt: timestamp(entry.observedAt, field) };
  const sha = (value: unknown) => optionalGithub(value, (v) => githubWord(v, field, 64, /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i));
  const ref = (value: unknown) => optionalGithub(value, (v) => githubWord(v, field, 255));
  const date = (value: unknown) => optionalGithub(value, (v) => timestamp(v, field));
  switch (kind) {
    case 'pull-request': {
      const row = fields(value, field, [...baseKeys, 'number', 'state', 'merged', 'headSha', 'baseRef', 'updatedAt']);
      return { kind, ...base, number: githubInteger(row.number, field), state: choice(row.state, field, issueStates),
        merged: optionalGithub(row.merged, (v) => githubBoolean(v, field)), headSha: sha(row.headSha),
        baseRef: ref(row.baseRef), updatedAt: timestamp(row.updatedAt, field) };
    }
    case 'workflow-run': {
      const row = fields(value, field, [...baseKeys, 'workflowId', 'status', 'conclusion', 'headSha', 'headBranch',
        'attempt', 'createdAt', 'updatedAt']);
      return { kind, ...base, workflowId: githubId(row.workflowId, field),
        status: optionalGithub(row.status, (v) => githubWord(v, field, 80)),
        conclusion: optionalGithub(row.conclusion, (v) => githubWord(v, field, 80)), headSha: sha(row.headSha),
        headBranch: ref(row.headBranch), attempt: githubInteger(row.attempt, field), createdAt: timestamp(row.createdAt, field),
        updatedAt: timestamp(row.updatedAt, field) };
    }
    case 'release': {
      const row = fields(value, field, [...baseKeys, 'tagName', 'targetCommitish', 'draft', 'prerelease', 'publishedAt']);
      return { kind, ...base, tagName: githubWord(row.tagName, field, 255), targetCommitish: githubWord(row.targetCommitish, field, 255),
        draft: githubBoolean(row.draft, field), prerelease: githubBoolean(row.prerelease, field), publishedAt: date(row.publishedAt) };
    }
    case 'pull-request-review': {
      const row = fields(value, field, [...baseKeys, 'pullRequestId', 'number', 'commitId', 'state', 'authorLogin', 'submittedAt']);
      return { kind, ...base, pullRequestId: githubId(row.pullRequestId, field), number: githubInteger(row.number, field),
        commitId: sha(row.commitId), state: githubWord(row.state, field, 80),
        authorLogin: optionalGithub(row.authorLogin, (v) => githubWord(v, field, 100, /^[A-Za-z0-9_-]+$/)),
        submittedAt: date(row.submittedAt) };
    }
  }
}

function githubCollection(value: unknown, field: string): GithubCollection {
  const row = fields(value, field, ['kind', 'pullRequestId', 'page', 'pagesFetched', 'count', 'observedAt', 'completeness']);
  const kind = choice(row.kind, field, githubKinds);
  const pullRequestId = optionalGithub(row.pullRequestId, (v) => githubId(v, field));
  if ((kind === 'pull-request-reviews') !== (pullRequestId !== null)) invalid(field);
  const page = githubInteger(row.page, field, 1000);
  const pagesFetched = githubInteger(row.pagesFetched, field, 3);
  if (page + pagesFetched - 1 > 1000) invalid(field);
  return { kind, pullRequestId, page, pagesFetched, count: githubInteger(row.count, field, 10 * pagesFetched, 0),
    observedAt: timestamp(row.observedAt, field), completeness: choice(row.completeness, field, ['complete-for-scope', 'partial'] as const) };
}

function githubAttempt(value: unknown, field: string): GithubAttempt {
  const row = fields(value, field, ['at', 'outcome', 'code']);
  const outcome = choice(row.outcome, field, ['success', 'partial', 'failed', 'cancelled'] as const);
  const code = optionalGithub(row.code, (v) => choice(v, field, githubCodes));
  const cancelled = code === 'AUTH_CANCELLED' || code === 'OPERATION_CANCELLED';
  if ((outcome === 'success' || outcome === 'partial') !== (code === null) || (outcome === 'cancelled') !== cancelled) invalid(field);
  return { at: timestamp(row.at, field), outcome, code };
}

const collectionKey = (row: GithubCollection) => row.kind + ':' + (row.pullRequestId ?? '');

function normalizeGithub(value: unknown, tasks: Task[], legacyComparison = true): GithubState {
  const field = 'snapshot.github';
  const row = fields(value, field, ['selection', 'connectionEpoch', 'repository', 'issues', 'facts', 'collections', 'lastAttempt']);
  const selection = choice(row.selection, field, ['none', 'disconnected', 'selected'] as const);
  const repository = optionalGithub(row.repository, (v) => githubRepository(v, field));
  const issues = list(row.issues, field, 100, githubMapping);
  const facts = list(row.facts, field, 100, githubFact);
  const collections = list(row.collections, field, 7, githubCollection);
  const lastAttempt = optionalGithub(row.lastAttempt, (v) => githubAttempt(v, field));
  if (!repository && (issues.length || facts.length || collections.length || lastAttempt)) invalid(field);
  if ((selection === 'none') !== (repository === null)) invalid(field);
  const byTask = new Map(tasks.map((task) => [task.id, task]));
  if (new Set(issues.map((m) => m.localTaskId)).size !== issues.length ||
      new Set(issues.map((m) => m.repositoryId + ':' + m.issueId)).size !== issues.length ||
      new Set(facts.map((f) => f.kind + ':' + f.id)).size !== facts.length ||
      new Set(collections.map(collectionKey)).size !== collections.length ||
      collections.filter((c) => c.kind === 'pull-request-reviews').length > 3) invalid(field);
  const pulls = new Map(facts.flatMap((f) => f.kind === 'pull-request' ? [[f.id, f.number] as const] : []));
  for (const mapping of issues) {
    const task = byTask.get(mapping.localTaskId);
    if (!task || mapping.repositoryId !== repository?.id || (selection === 'disconnected' && mapping.availability !== 'historical')) invalid(field);
    if (legacyComparison && githubConflicts(mapping, localIssue(task, mapping)).join() !== mapping.conflictFields.join()) invalid(field);
  }
  if (facts.some((f) => f.repositoryId !== repository?.id ||
      (f.kind === 'pull-request-review' && pulls.get(f.pullRequestId) !== f.number)) ||
      collections.some((c) => c.pullRequestId !== null && !pulls.has(c.pullRequestId))) invalid(field);
  const result: GithubState = { selection, connectionEpoch: id(row.connectionEpoch, '', field), repository, issues, facts, collections, lastAttempt };
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 512 * 1024) limit(field);
  return result;
}

function resetGithub(snapshot: Snapshot): void {
  if (!hasGithub(snapshot)) return;
  const state = snapshot.github;
  state.selection = state.repository ? 'disconnected' : 'none';
  state.connectionEpoch = randomUUID();
  state.lastAttempt = null;
  for (const mapping of state.issues) mapping.availability = 'historical';
}

function withGithubSchema(snapshot: ReviewedSnapshot): ConnectedSnapshot {
  if (hasGithub(snapshot)) return snapshot;
  return { ...snapshot, schemaVersion: 3, github: {
    selection: 'none', connectionEpoch: randomUUID(), repository: null, issues: [], facts: [], collections: [], lastAttempt: null,
  } };
}

function reconcileLocalGithub(snapshot: Snapshot): void {
  if (!hasGithub(snapshot)) return;
  const tasks = new Map(snapshot.tasks.map((task) => [task.id, task]));
  for (const mapping of snapshot.github.issues) {
    const local = localIssue(tasks.get(mapping.localTaskId)!, mapping);
    const anchors = publicationAnchors(snapshot, mapping);
    for (const key of issueFields) {
      if (anchors[key] === undefined && local[key] === mapping.remote[key]) setIssueValue(mapping.common, key, local);
    }
    mapping.conflictFields = githubConflicts(mapping, local, anchors);
  }
}

function applyGithub(snapshot: ConnectedSnapshot, value: unknown): CreatedIds {
  const type = choice(object(value, 'github.operation').type, 'github.operation.type',
    ['prepare', 'select', 'disconnect', 'refresh', 'record-attempt', 'import', 'resolve', 'issue-state', 'unlink', 'clear-facts'] as const);
  const field = 'github.operation';
  const state = snapshot.github;
  const command = (keys: string[]) => fields(value, field, ['type', ...keys]);
  const repository = (row: Input) => {
    if (state.selection !== 'selected' || !state.repository ||
        githubId(row.repositoryId, field) !== state.repository.id || id(row.connectionEpoch, '', field) !== state.connectionEpoch) {
      invalid(field, 'GitHub repository or connection changed.');
    }
    return state.repository;
  };
  const mappingFor = (taskId: unknown) => findMapping(state, id(taskId, 't_', field), field);
  switch (type) {
    case 'prepare':
      command([]);
      break;
    case 'select': {
      const row = command(['repository', 'connectionEpoch']);
      const chosen = githubRepository(row.repository, field);
      if (state.repository && state.repository.id !== chosen.id) invalid(field, 'Choose the same cached repository or use a new board.');
      state.repository = chosen;
      state.connectionEpoch = id(row.connectionEpoch, '', field);
      state.selection = 'selected';
      break;
    }
    case 'disconnect':
      command([]);
      resetGithub(snapshot);
      break;
    case 'record-attempt': {
      const row = command(['connectionEpoch', 'repositoryId', 'attempt']);
      repository(row);
      const attempt = githubAttempt(row.attempt, field);
      if (attempt.outcome !== 'failed' && attempt.outcome !== 'cancelled') invalid(field);
      state.lastAttempt = attempt;
      break;
    }
    case 'refresh': {
      const row = command(['connectionEpoch', 'repositoryId', 'issues', 'facts', 'collection', 'attempt']);
      const selected = repository(row);
      const collection = githubCollection(row.collection, field);
      const attempt = githubAttempt(row.attempt, field);
      if (attempt.outcome !== (collection.completeness === 'partial' ? 'partial' : 'success') ||
          attempt.at !== collection.observedAt) invalid(field);
      const seen = new Set<string>();
      list(row.issues, field, collection.kind === 'issues' ? 8 : 0, (value, at) => {
        const raw = object(value, at);
        const missing = Object.hasOwn(raw, 'unavailable');
        const issue = fields(value, at, ['issueId', 'number', ...(missing ? ['unavailable'] : ['remoteUpdatedAt', 'values'])]);
        const issueId = githubId(issue.issueId, at);
        if (seen.has(issueId)) invalid(at);
        seen.add(issueId);
        const mapping = state.issues.find((m) => m.issueId === issueId);
        if (!mapping || mapping.number !== githubInteger(issue.number, at)) invalid(at);
        if (missing) {
          if (issue.unavailable !== true) invalid(at);
          mapping.availability = 'unknown';
          return;
        }
        const records = relatedPublication(snapshot, mapping);
        if (records.some(uncertainPublication)) invalid(at, 'Inspect the previous send before refreshing this issue.');
        const remoteUpdatedAt = timestamp(issue.remoteUpdatedAt, at);
        const remote = githubValues(issue.values, at);
        const task = find(snapshot.tasks, mapping.localTaskId, at);
        const local = localIssue(task, mapping);
        const conflicts: IssueField[] = [];
        const anchors = publicationAnchors(snapshot, mapping);
        for (const key of issueFields) {
          if (anchors[key] !== undefined) {
            setPublicationValue(mapping.common, key, anchors);
            if (local[key] === remote[key] || local[key] === anchors[key]) {
              setIssueValue(local, key, remote);
              setIssueValue(mapping.common, key, remote);
            } else if (remote[key] !== anchors[key]) conflicts.push(key);
            continue;
          }
          if (local[key] === remote[key]) {
            setIssueValue(mapping.common, key, remote);
          } else if (mapping.conflictFields.includes(key)) {
            conflicts.push(key);
          } else if (local[key] === mapping.common[key]) {
            setIssueValue(local, key, remote);
            setIssueValue(mapping.common, key, remote);
          } else if (remote[key] !== mapping.common[key]) {
            conflicts.push(key);
          }
        }
        task.title = local.title;
        task.description = local.body;
        mapping.localIssueState = local.state;
        mapping.remote = remote;
        mapping.fetchedAt = collection.observedAt;
        mapping.remoteUpdatedAt = remoteUpdatedAt;
        mapping.availability = 'observed';
        mapping.conflictFields = conflicts;
        for (const record of records) record.mergePendingFields = [];
      });
      const facts = list(row.facts, field, collection.kind === 'issues' ? 0 : 30, githubFact);
      if (facts.length !== (collection.kind === 'issues' ? 0 : collection.count) ||
          new Set(facts.map((fact) => fact.id)).size !== facts.length) invalid(field);
      for (const fact of facts) {
        if (fact.repositoryId !== selected.id || collectionByFact[fact.kind] !== collection.kind ||
            (fact.kind === 'pull-request-review' && fact.pullRequestId !== collection.pullRequestId)) invalid(field);
        const index = state.facts.findIndex((entry) => entry.id === fact.id && entry.kind === fact.kind);
        if (index < 0) state.facts.push(fact);
        else state.facts[index] = fact;
      }
      const index = state.collections.findIndex((entry) => collectionKey(entry) === collectionKey(collection));
      if (index < 0) state.collections.push(collection);
      else state.collections[index] = collection;
      state.lastAttempt = attempt;
      break;
    }
    case 'import': {
      const row = command(['connectionEpoch', 'repositoryId', 'issues']);
      const selected = repository(row);
      const linked = new Set(state.issues.map((item) => item.issueId));
      const taskIds = list(row.issues, field, 10, (value, at) => {
        const item = fields(value, at, ['issueId', 'number', 'remoteUpdatedAt', 'fetchedAt', 'values']);
        const issueId = githubId(item.issueId, at);
        if (linked.has(issueId)) invalid(at, 'Issue is already linked.');
        linked.add(issueId);
        const values = githubValues(item.values, at);
        const taskId = 't_' + randomUUID();
        snapshot.tasks.push({ id: taskId, title: values.title, description: values.body, owner: '', priority: 'P1',
          status: 'Planned', milestoneId: null, workstreamId: null, prerequisites: [], criteria: [], blockers: [], evidenceIds: [] });
        state.issues.push({ localTaskId: taskId, repositoryId: selected.id, issueId, number: githubInteger(item.number, at),
          fetchedAt: timestamp(item.fetchedAt, at), remoteUpdatedAt: timestamp(item.remoteUpdatedAt, at),
          common: { ...values }, remote: values, localIssueState: values.state, availability: 'observed', conflictFields: [] });
        return taskId;
      });
      if (!taskIds.length) invalid(field, 'Choose at least one issue.');
      return { taskIds };
    }
    case 'resolve': {
      const row = command(['taskId', 'field', 'choice', 'remoteUpdatedAt', 'observedValue']);
      const mapping = mappingFor(row.taskId);
      const key = choice(row.field, field, issueFields);
      const pick = choice(row.choice, field, ['local', 'remote'] as const);
      if (publicationAnchors(snapshot, mapping)[key] !== undefined) invalid(field, 'Refresh the published issue before resolving this field.');
      if (!mapping.conflictFields.includes(key) || row.remoteUpdatedAt !== mapping.remoteUpdatedAt ||
          row.observedValue !== mapping.remote[key]) invalid(field, 'Review the current conflict before resolving.');
      setIssueValue(mapping.common, key, mapping.remote);
      if (pick === 'remote') {
        const task = find(snapshot.tasks, mapping.localTaskId, field);
        if (key === 'title') task.title = mapping.remote.title;
        if (key === 'body') task.description = mapping.remote.body;
        if (key === 'state') mapping.localIssueState = mapping.remote.state;
      }
      mapping.conflictFields = mapping.conflictFields.filter((entry) => entry !== key);
      break;
    }
    case 'issue-state': {
      const row = command(['taskId', 'state']);
      mappingFor(row.taskId).localIssueState = choice(row.state, field, issueStates);
      break;
    }
    case 'unlink': {
      const row = command(['taskId']);
      const mapping = mappingFor(row.taskId);
      for (const record of relatedPublication(snapshot, mapping)) record.mergePendingFields = [];
      state.issues = state.issues.filter((entry) => entry !== mapping);
      break;
    }
    case 'clear-facts': {
      const row = command(['kinds', 'confirmed']);
      const kinds = list(row.kinds, field, 4, (entry, at) => choice(entry, at, githubFactKinds));
      const selected = new Set(kinds);
      if (row.confirmed !== true || !kinds.length || selected.size !== kinds.length) invalid(field);
      const removedPulls = new Set(state.facts.flatMap((fact) => selected.has('pull-request') && fact.kind === 'pull-request' ? [fact.id] : []));
      const descriptors = new Set(kinds.map((entry) => collectionByFact[entry]));
      state.facts = state.facts.filter((fact) => !selected.has(fact.kind) &&
        (fact.kind !== 'pull-request-review' || !removedPulls.has(fact.pullRequestId)));
      state.collections = state.collections.filter((entry) => !descriptors.has(entry.kind) &&
        (entry.pullRequestId === null || !removedPulls.has(entry.pullRequestId)));
      break;
    }
  }
  return {};
}

function findMapping(state: GithubState, taskId: string, field: string): IssueMapping {
  const mapping = state.issues.find((entry) => entry.localTaskId === taskId);
  if (!mapping) invalid(field, 'The task has no GitHub mapping.');
  return mapping;
}

function setIssueValue<K extends IssueField>(target: GithubIssueValues, field: K, source: GithubIssueValues): void {
  target[field] = source[field];
}

function withReviewSchema(snapshot: Snapshot): ReviewedSnapshot {
  return snapshot.schemaVersion === 1 ? { ...snapshot, schemaVersion: 2, reviews: [], reviewArchive: null } : snapshot;
}

function normalizeSnapshot(value: unknown): Snapshot {
  const candidate = object(value, 'snapshot');
  if (!Object.hasOwn(candidate, 'schemaVersion')) invalid('snapshot.schemaVersion', 'A required field is missing.');
  const schemaVersion = candidate.schemaVersion;
  if (schemaVersion !== 1 && schemaVersion !== 2 && schemaVersion !== 3 && schemaVersion !== 4) {
    throw new ValidationError('UNSUPPORTED_VERSION', 'snapshot.schemaVersion', 'The board schema version is unsupported.');
  }
  const entry = fields(value, 'snapshot', [
    'schemaVersion', 'boardId', 'generation', 'revision', 'updatedAt', 'project', 'milestones', 'workstreams', 'tasks', 'evidence',
    ...(schemaVersion === 1 ? [] : ['reviews', 'reviewArchive']),
    ...(schemaVersion === 3 || schemaVersion === 4 ? ['github'] : []),
    ...(schemaVersion === 4 ? ['publication'] : []),
  ]);
  const project = fields(entry.project, 'project', projectKeys);
  const common: SnapshotFields = {
    boardId: id(entry.boardId, 'b_', 'boardId'),
    generation: id(entry.generation, '', 'generation'),
    revision: revision(entry.revision, 'revision'),
    updatedAt: timestamp(entry.updatedAt, 'updatedAt'),
    project: {
      name: text(project.name, 'project.name', 1, 200),
      goal: text(project.goal, 'project.goal', 0, 16000),
      stage: choice(project.stage, 'project.stage', stages),
      focusTaskId: nullableId(project.focusTaskId, 't_', 'project.focusTaskId'),
      nextActions: list(project.nextActions, 'project.nextActions', 3, (item, at) => text(item, at, 1, 500)),
    },
    milestones: list(entry.milestones, 'milestones', 100, (item, at) => group(item, at, 'm_')),
    workstreams: list(entry.workstreams, 'workstreams', 100, (item, at) => group(item, at, 'w_')),
    tasks: list(entry.tasks, 'tasks', 1000, task),
    evidence: list(entry.evidence, 'evidence', 2000, evidence),
  };
  validateReferences(common);
  let snapshot: Snapshot = { schemaVersion: 1, ...common };
  if (schemaVersion !== 1) {
    const reviewed = { ...common, reviews: normalizeReviews(entry.reviews, common),
      reviewArchive: entry.reviewArchive === null ? null : archive(entry.reviewArchive) };
    if (schemaVersion === 4) {
      const github = normalizeGithub(entry.github, common.tasks, false);
      const connected: GithubSnapshot = { schemaVersion: 3, ...reviewed, github };
      const publication = normalizePublication(entry.publication, connected);
      snapshot = { schemaVersion, ...reviewed, github, publication };
      for (const mapping of github.issues) {
        const task = find(common.tasks, mapping.localTaskId, 'snapshot.github');
        if (githubConflicts(mapping, localIssue(task, mapping), publicationAnchors(snapshot, mapping)).join() !== mapping.conflictFields.join()) {
          invalid('snapshot.github');
        }
      }
      const reserved = publication.records.reduce((sum, record) => sum + 4096 - settlementBytes(record), 0);
      if (Buffer.byteLength(JSON.stringify({ github, publication })) + reserved > 512 * 1024 ||
          Buffer.byteLength(JSON.stringify(snapshot)) + reserved > snapshotLimit) limit('snapshot.publication');
    } else {
      snapshot = schemaVersion === 3
        ? { schemaVersion, ...reviewed, github: normalizeGithub(entry.github, common.tasks) }
        : { schemaVersion, ...reviewed };
    }
  }
  if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > snapshotLimit) limit('snapshot');
  return snapshot;
}


function copyIdentity(snapshot: Snapshot): void {
  const records = [...snapshot.milestones, ...snapshot.workstreams, ...snapshot.tasks,
    ...snapshot.tasks.flatMap((entry) => entry.criteria), ...snapshot.evidence];
  const remapped = new Map(records.map((record) => [record.id, record.id.slice(0, 2) + randomUUID()]));
  const map = (key: string): string => remapped.get(key)!;
  const optional = (key: string | null): string | null => key === null ? null : map(key);
  for (const record of records) record.id = map(record.id);
  snapshot.project.focusTaskId = optional(snapshot.project.focusTaskId);
  for (const entry of snapshot.tasks) {
    entry.milestoneId = optional(entry.milestoneId);
    entry.workstreamId = optional(entry.workstreamId);
    entry.prerequisites = entry.prerequisites.map(map);
    entry.evidenceIds = entry.evidenceIds.map(map);
    for (const check of entry.criteria) check.evidenceIds = check.evidenceIds.map(map);
  }
  for (const entry of snapshot.evidence) entry.supersedesId = optional(entry.supersedesId);
  if (snapshot.schemaVersion !== 1) for (const review of snapshot.reviews) review.taskId = map(review.taskId);
  if (hasGithub(snapshot)) for (const mapping of snapshot.github.issues) mapping.localTaskId = map(mapping.localTaskId);
  if (snapshot.schemaVersion === 4) {
    for (const row of [...snapshot.publication.records, ...snapshot.publication.creationLinks]) {
      row.associationTaskId = optional(row.associationTaskId);
    }
  }
  snapshot.boardId = 'b_' + randomUUID();
}

function initialSnapshot(input: unknown): Snapshot {
  const kind = choice(object(input, 'initialize').kind, 'initialize.kind', ['blank', 'sample', 'import']);
  const now = new Date().toISOString();
  if (kind === 'sample') {
    fields(input, 'initialize', ['kind']);
    return normalizeSnapshot(sampleSnapshot(now));
  }
  if (kind === 'blank') {
    const entry = fields(input, 'initialize', ['kind', 'name']);
    return normalizeSnapshot({
      schemaVersion: 2, boardId: 'b_' + randomUUID(), generation: randomUUID(), revision: 1, updatedAt: now,
      project: { name: entry.name, goal: '', stage: 'Plan', focusTaskId: null, nextActions: [] },
      milestones: [], workstreams: [], tasks: [], evidence: [], reviews: [], reviewArchive: null,
    });
  }
  const mode = choice(object(input, 'initialize').identity, 'initialize.identity', ['new', 'restore', 'continue']);
  const entry = fields(input, 'initialize', ['kind', 'backup', 'identity',
    ...(mode === 'continue' ? ['preserveHistoryConfirmed'] : [])]);
  if (mode === 'continue' && entry.preserveHistoryConfirmed !== true) {
    invalid('preserveHistoryConfirmed', 'Confirm that the original board and its full backup have been retained.');
  }
  const backup = fields(entry.backup, 'backup', ['format', 'version', 'exportedAt', 'snapshot']);
  if (backup.format !== 'kitflint.glance.backup') invalid('backup.format');
  if (backup.version !== 1) throw new ValidationError('UNSUPPORTED_VERSION', 'backup.version', 'The backup version is unsupported.');
  timestamp(backup.exportedAt, 'backup.exportedAt');
  const original = normalizeSnapshot(backup.snapshot);
  const snapshot = withReviewSchema(original);
  if (mode === 'continue') {
    if (original.schemaVersion === 1 || original.reviews.length === 0) {
      invalid('backup.snapshot.reviews', 'Continue from a full board backup containing review history.');
    }
    const reviewArchive = {
      boardId: original.boardId, generation: original.generation, revision: original.revision,
      snapshotSha256: stored(original).sha256, reviewCount: original.reviews.length, continuedAt: now,
    };
    resetGithub(snapshot);
    return normalizeSnapshot({ ...snapshot, generation: randomUUID(), revision: 1, updatedAt: now, reviews: [], reviewArchive });
  }
  if (mode === 'new') copyIdentity(snapshot);
  resetGithub(snapshot);
  snapshot.generation = randomUUID();
  snapshot.revision = 1;
  snapshot.updatedAt = now;
  return normalizeSnapshot(snapshot);
}

function find<T extends { id: string }>(items: T[], key: string, field: string): T {
  const entry = items.find((item) => item.id === key);
  if (!entry) invalid(field, 'The record does not exist.');
  return entry;
}

function newCriterion(value: unknown, field: string): Criterion {
  const entry = fields(value, field, ['requirement', 'evidenceIds'], ['requirement']);
  return criterion({ evidenceIds: [], ...entry, id: 'c_' + randomUUID() }, field);
}

function apply(snapshot: Snapshot, operation: unknown): CreatedIds {
  const entry = object(operation, 'operation');
  const type = choice(entry.type, 'operation.type', [
    'project.edit', 'milestone.add', 'milestone.edit', 'workstream.add', 'workstream.edit',
    'task.add', 'task.edit', 'criterion.add', 'criterion.edit', 'evidence.add',
  ]);
  switch (type) {
    case 'project.edit': {
      fields(entry, 'operation', ['type', 'fields']);
      Object.assign(snapshot.project, patch(entry.fields, 'operation.fields', projectKeys));
      return {};
    }
    case 'milestone.add':
    case 'workstream.add': {
      fields(entry, 'operation', ['type', 'title']);
      const milestone = type === 'milestone.add';
      const groupId = (milestone ? 'm_' : 'w_') + randomUUID();
      (milestone ? snapshot.milestones : snapshot.workstreams).push({
        id: groupId, title: text(entry.title, 'operation.title', 1, 200),
      });
      return milestone ? { milestoneId: groupId } : { workstreamId: groupId };
    }
    case 'milestone.edit':
    case 'workstream.edit': {
      fields(entry, 'operation', ['type', 'id', 'title']);
      const milestone = type === 'milestone.edit';
      const groupId = id(entry.id, milestone ? 'm_' : 'w_', 'operation.id');
      const item = find(milestone ? snapshot.milestones : snapshot.workstreams, groupId, 'operation.id');
      item.title = text(entry.title, 'operation.title', 1, 200);
      return {};
    }
    case 'task.add': {
      fields(entry, 'operation', ['type', 'fields']);
      const values = fields(entry.fields, 'operation.fields', [...taskEditKeys, 'criteria'], ['title']);
      const taskId = 't_' + randomUUID();
      const criteria = Object.hasOwn(values, 'criteria') ? list(values.criteria, 'operation.fields.criteria', 20, newCriterion) : [];
      const next = task({
        description: '', owner: '', priority: 'P1', status: 'Planned', milestoneId: null,
        workstreamId: null, prerequisites: [], blockers: [], evidenceIds: [], ...values, id: taskId, criteria,
      }, 'operation.fields');
      snapshot.tasks.push(next);
      return { taskId, criterionIds: next.criteria.map((check) => check.id) };
    }
    case 'task.edit': {
      fields(entry, 'operation', ['type', 'id', 'fields']);
      Object.assign(find(snapshot.tasks, id(entry.id, 't_', 'operation.id'), 'operation.id'),
        patch(entry.fields, 'operation.fields', taskEditKeys));
      return {};
    }
    case 'criterion.add': {
      fields(entry, 'operation', ['type', 'taskId', 'requirement', 'evidenceIds'], ['type', 'taskId', 'requirement']);
      const item = find(snapshot.tasks, id(entry.taskId, 't_', 'operation.taskId'), 'operation.taskId');
      const check = newCriterion({
        requirement: entry.requirement, ...(Object.hasOwn(entry, 'evidenceIds') ? { evidenceIds: entry.evidenceIds } : {}),
      }, 'operation');
      item.criteria.push(check);
      return { criterionIds: [check.id] };
    }
    case 'criterion.edit': {
      fields(entry, 'operation', ['type', 'taskId', 'id', 'fields']);
      const item = find(snapshot.tasks, id(entry.taskId, 't_', 'operation.taskId'), 'operation.taskId');
      Object.assign(find(item.criteria, id(entry.id, 'c_', 'operation.id'), 'operation.id'),
        patch(entry.fields, 'operation.fields', ['requirement', 'evidenceIds']));
      return {};
    }
    case 'evidence.add': {
      fields(entry, 'operation', ['type', 'fields', 'taskId'], ['type', 'fields']);
      const values = fields(entry.fields, 'operation.fields', evidenceInputKeys, ['title', 'scope', 'outcome']);
      // Optional taskId links the new record to that task in the same commit (A7, pilot finding F1).
      const linked = Object.hasOwn(entry, 'taskId')
        ? find(snapshot.tasks, id(entry.taskId, 't_', 'operation.taskId'), 'operation.taskId') : null;
      const evidenceId = 'e_' + randomUUID();
      snapshot.evidence.push(evidence({
        location: '', supersedesId: null, ...values, id: evidenceId, recordedAt: new Date().toISOString(),
      }, 'operation.fields'));
      if (linked) linked.evidenceIds = [...linked.evidenceIds, evidenceId];
      return { evidenceId };
    }
  }
}

function reviewRecords(snapshot: Snapshot): readonly ReviewRecord[] {
  return snapshot.schemaVersion === 1 ? [] : snapshot.reviews;
}

function reviewBasis(snapshot: Snapshot, task: Task, accepted: ReadonlyMap<string, string>): ReviewBasis {
  const links = new Set([...task.evidenceIds, ...task.criteria.flatMap((criterion) => criterion.evidenceIds)]);
  // Each supersedes edge points backward, so two ordered passes include ancestors, siblings and descendants.
  for (let i = snapshot.evidence.length - 1; i >= 0; i--) {
    const record = snapshot.evidence[i];
    if (record.supersedesId !== null && links.has(record.id)) links.add(record.supersedesId);
  }
  for (const record of snapshot.evidence) {
    if (record.supersedesId !== null && links.has(record.supersedesId)) links.add(record.id);
  }
  return {
    task, projectGoal: snapshot.project.goal,
    milestoneTitle: snapshot.milestones.find(({ id }) => id === task.milestoneId)?.title ?? null,
    workstreamTitle: snapshot.workstreams.find(({ id }) => id === task.workstreamId)?.title ?? null,
    evidence: snapshot.evidence.filter(({ id }) => links.has(id)),
    prerequisites: task.prerequisites.map((taskId) => ({ taskId, reviewId: accepted.get(taskId) ?? null })),
  };
}

function acceptanceIssue(subject: ReviewBasis): { field: string; message: string } | undefined {
  const { task, evidence, prerequisites } = subject;
  if (task.blockers.length) return { field: 'task.blockers', message: 'Resolve task blockers before accepting.' };
  if (!task.criteria.length) return { field: 'task.criteria', message: 'Add at least one criterion before accepting.' };
  if (prerequisites.some(({ reviewId }) => reviewId === null)) {
    return { field: 'task.prerequisites', message: 'Accept every prerequisite task before accepting this scope.' };
  }
  const superseded = new Set(evidence.map(({ supersedesId }) => supersedesId));
  const outcomes = new Map(evidence.map(({ id, outcome }) => [id, outcome]));
  const unmet = task.criteria.findIndex((criterion) => {
    const current = criterion.evidenceIds.filter((id) => !superseded.has(id));
    return !current.length || current.some((id) => outcomes.get(id) !== 'passed');
  });
  if (unmet !== -1) {
    return {
      field: 'task.criteria[' + unmet + '].evidenceIds',
      message: 'Link current passed evidence to each criterion and resolve every current nonpassing record.',
    };
  }
}

function reviewProjection(snapshot: Snapshot, onStale?: (record: ReviewRecord) => void) {
  const latest = new Map<string, ReviewRecord>();
  const counts = new Map<string, number>();
  for (const record of reviewRecords(snapshot)) {
    counts.set(record.taskId, (counts.get(record.taskId) ?? 0) + 1);
    if (record.generation === snapshot.generation) latest.set(record.taskId, record);
  }
  const accepted = new Map<string, string>();
  const states = new Map<string, ReviewState>();
  const ordered = latest.size > 0 ? prerequisiteFirst(snapshot.tasks) : [];
  for (const task of ordered) {
    const record = latest.get(task.id);
    if (!record) continue;
    let state: ReviewState = record.decision;
    if (record.decision === 'accepted') {
      const current = reviewBasis(snapshot, task, accepted);
      if (!acceptanceIssue(current) && record.basisSha256 === digest(JSON.stringify(current))) {
        accepted.set(task.id, record.id);
      } else {
        state = 'stale';
        onStale?.(record);
      }
    }
    states.set(task.id, state);
  }
  const taskReviews: TaskReview[] = snapshot.tasks.map(({ id }) => ({
    taskId: id, state: states.get(id) ?? 'unreviewed',
    latestReviewId: latest.get(id)?.id ?? null, historicalCount: counts.get(id) ?? 0,
  }));
  return { accepted, taskReviews };
}

function invalidateReviews(snapshot: ReviewedSnapshot): void {
  reviewProjection(snapshot, (prior) => {
    const record: ReviewRecord = {
      id: 'r_' + randomUUID(), taskId: prior.taskId, generation: snapshot.generation,
      recordedAt: new Date().toISOString(), decision: 'stale', reviewer: '', scope: prior.scope,
      note: staleNote, basis: null, basisSha256: prior.basisSha256, previousReviewId: prior.id,
    };
    snapshot.reviews.push(record);
  });
}

function recordReview(snapshot: ReviewedSnapshot, command: Input): CreatedIds {
  const taskId = id(command.taskId, 't_', 'taskId');
  const task = find(snapshot.tasks, taskId, 'taskId');
  const decision: HumanDecision = choice(command.decision, 'decision', ['accepted', 'changes-requested'] as const);
  const reviewer = text(command.reviewer, 'reviewer', 1, 200);
  const scope = text(command.scope, 'scope', 1, 500);
  const note = text(command.note, 'note', 1, 2000);
  const subject = reviewBasis(snapshot, task, reviewProjection(snapshot).accepted);
  if (decision === 'accepted') {
    const issue = acceptanceIssue(subject);
    if (issue) invalid(issue.field, issue.message);
  }
  const reviewId = 'r_' + randomUUID();
  snapshot.reviews.push({
    id: reviewId, taskId, generation: snapshot.generation, recordedAt: new Date().toISOString(),
    decision, reviewer, scope, note, basis: subject, basisSha256: digest(JSON.stringify(subject)),
    previousReviewId: snapshot.reviews.findLast((record) => record.taskId === taskId)?.id ?? null,
  });
  return { reviewId };
}

function projectReport(snapshot: Snapshot): Report {
  const { accepted, taskReviews } = reviewProjection(snapshot);
  const groupCounts = (groups: Group[], key: 'milestoneId' | 'workstreamId'): GroupCount[] => {
    const totals = new Map<string, number>();
    const open = new Map<string, number>();
    for (const task of snapshot.tasks) {
      const group = task[key];
      if (group === null) continue;
      totals.set(group, (totals.get(group) ?? 0) + 1);
      if (!accepted.has(task.id)) open.set(group, (open.get(group) ?? 0) + 1);
    }
    return groups.map(({ id }) => {
      const count = totals.get(id) ?? 0;
      return { id, totalTasks: count, openTasks: open.get(id) ?? 0 };
    });
  };
  const count = (status: Task['status']) => snapshot.tasks.filter((task) => task.status === status).length;
  return {
    counts: {
      tasks: snapshot.tasks.length, open: snapshot.tasks.length - accepted.size, inProgress: count('In progress'),
      blocked: count('Blocked'), needsReview: count('Needs review'),
    },
    acceptance: {
      available: true, accepted: accepted.size, stale: taskReviews.filter(({ state }) => state === 'stale').length,
      changesRequested: taskReviews.filter(({ state }) => state === 'changes-requested').length,
    },
    taskReviews,
    milestones: groupCounts(snapshot.milestones, 'milestoneId'),
    workstreams: groupCounts(snapshot.workstreams, 'workstreamId'),
    focusTaskId: snapshot.project.focusTaskId,
    nextActions: [...snapshot.project.nextActions],
  };
}

function version(snapshot: Snapshot): string {
  return snapshot.generation + ':' + snapshot.revision;
}

type PublicLabel = { id: string; label: string };

function publicLabel(value: unknown, field: string): string {
  const label = text(value, field, 1, 200);
  if (/[\x00-\x1f\x7f-\x9f]/.test(label)) invalid(field, 'Public labels cannot contain control characters.');
  return label;
}

function publicFields(value: unknown, field: string, keys: readonly string[]): Input {
  const input = fields(value, field, keys);
  return Object.fromEntries(keys.map((key) => {
    const property = Object.getOwnPropertyDescriptor(input, key);
    if (!property || !('value' in property)) invalid(field, 'Expected plain data fields.');
    return [key, property.value];
  }));
}

function publicLabels(value: unknown, collection: string, prefix: string, maximum: number): PublicLabel[] {
  const field = 'labels.' + collection;
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) invalid(field, 'Expected a plain array.');
  if (value.length > maximum) limit(field);
  if (Reflect.ownKeys(value).length !== value.length + 1) invalid(field, 'Expected only array entries.');
  const seen = new Set<string>();
  return Array.from({ length: value.length }, (_, index) => {
    const property = Object.getOwnPropertyDescriptor(value, index);
    if (!property || !('value' in property)) invalid(field, 'Expected plain data entries.');
    const at = field + '[' + index + ']';
    const item = publicFields(property.value, at, ['id', 'label']);
    const key = id(item.id, prefix, at + '.id');
    if (seen.has(key)) invalid(at + '.id', 'Duplicate public label ID.');
    seen.add(key);
    return { id: key, label: publicLabel(item.label, at + '.label') };
  });
}

function publicRequest(input: unknown) {
  const request = publicFields(input, 'publicReport', ['expectedVersion', 'labels']);
  const labels = publicFields(request.labels, 'labels', ['project', 'tasks', 'milestones', 'workstreams']);
  const normalized = {
    expectedVersion: expectedVersion(request.expectedVersion),
    labels: {
      project: labels.project === null ? null : publicLabel(labels.project, 'labels.project'),
      tasks: publicLabels(labels.tasks, 'tasks', 't_', 1000),
      milestones: publicLabels(labels.milestones, 'milestones', 'm_', 100),
      workstreams: publicLabels(labels.workstreams, 'workstreams', 'w_', 100),
    },
  };
  if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > 128 * 1024) limit('publicReport');
  return normalized;
}

function publicProjection(snapshot: Snapshot, labels: ReturnType<typeof publicRequest>['labels']): PublicReport {
  const report = projectReport(snapshot);
  const ordinal = (records: readonly { id: string }[], prefix: string) =>
    new Map(records.map((record, index) => [record.id, prefix + (index + 1)]));
  const taskIds = ordinal(snapshot.tasks, 't');
  const milestoneIds = ordinal(snapshot.milestones, 'm');
  const workstreamIds = ordinal(snapshot.workstreams, 'w');
  function overrides(entries: PublicLabel[], ids: Map<string, string>, field: string) {
    const result = new Map<string, string>();
    for (const item of entries) {
      if (!ids.has(item.id)) invalid(field, 'A public label ID is not in the captured collection.');
      result.set(item.id, item.label);
    }
    return result;
  }
  const taskLabels = overrides(labels.tasks, taskIds, 'labels.tasks');
  const groupProjection = (groups: Report['milestones'], ids: Map<string, string>, names: PublicLabel[],
    field: string, generic: string) => {
    const chosen = overrides(names, ids, field);
    return groups.map((group, index) => ({
      id: ids.get(group.id)!, label: chosen.get(group.id) ?? generic + (index + 1),
      total: group.totalTasks, accepted: group.totalTasks - group.openTasks,
    }));
  };
  const milestones = groupProjection(report.milestones, milestoneIds, labels.milestones, 'labels.milestones', 'Milestone ');
  const workstreams = groupProjection(report.workstreams, workstreamIds, labels.workstreams, 'labels.workstreams', 'Workstream ');
  const reviews = new Map(report.taskReviews.map((review) => [review.taskId, review.state]));
  return {
    format: 'kitflint.glance.public.v1',
    project: { label: labels.project ?? 'Project readiness', stage: snapshot.project.stage },
    captured: { revision: snapshot.revision, updatedAt: new Date(snapshot.updatedAt).toISOString(), preparedAt: new Date().toISOString() },
    counts: {
      tasks: report.counts.tasks, open: report.counts.open, accepted: report.acceptance.accepted,
      inProgress: report.counts.inProgress, blocked: report.counts.blocked, needsReview: report.counts.needsReview,
      stale: report.acceptance.stale, changesRequested: report.acceptance.changesRequested,
    },
    focusTaskId: report.focusTaskId === null ? null : taskIds.get(report.focusTaskId)!,
    milestones, workstreams,
    tasks: snapshot.tasks.map((task, index) => ({
      id: taskIds.get(task.id)!, label: taskLabels.get(task.id) ?? 'Task ' + (index + 1),
      priority: task.priority, status: task.status, review: reviews.get(task.id)!,
      milestoneId: task.milestoneId === null ? null : milestoneIds.get(task.milestoneId)!,
      workstreamId: task.workstreamId === null ? null : workstreamIds.get(task.workstreamId)!,
      prerequisites: task.prerequisites.map((key) => taskIds.get(key)!),
      criterionCount: task.criteria.length,
      evidenceCount: new Set([...task.evidenceIds, ...task.criteria.flatMap((criterion) => criterion.evidenceIds)]).size,
      blockerCount: task.blockers.length,
    })),
  };
}

function initialized(snapshot: Snapshot): Initialized {
  return { initialized: true, snapshot, version: version(snapshot), report: projectReport(snapshot) };
}

function conflict(snapshot: Snapshot): Failure {
  return { ...failure('REVISION_CONFLICT', 'The board version changed. Review the current snapshot.'),
    current: { snapshot, version: version(snapshot), report: projectReport(snapshot) } };
}

function digest(document: string): string {
  return createHash('sha256').update(document, 'utf8').digest('hex');
}

function stored(snapshot: Snapshot): StoredDocument {
  const document = JSON.stringify(snapshot);
  return { document, sha256: digest(document) };
}

function inspectRows(rows: CapturedRows): Captured {
  const identity = rows.identity[0];
  if (rows.identity.length !== 1 || identity.slot !== 1 ||
      typeof identity.board_id !== 'string' || !boardIdPattern.test(identity.board_id) ||
      typeof identity.generation !== 'string' || !generationPattern.test(identity.generation) ||
      rows.state.some((row) => row.slot !== 1 && row.slot !== 2) ||
      new Set(rows.state.map((row) => row.slot)).size !== rows.state.length) return { valid: false };
  const decode = (slot: number): BoardRow | undefined => {
    const row = rows.state.find((entry) => entry.slot === slot);
    if (!row || typeof row.document !== 'string' || typeof row.sha256 !== 'string' ||
        Buffer.byteLength(row.document, 'utf8') > snapshotLimit || digest(row.document) !== row.sha256) return undefined;
    try {
      const snapshot = normalizeSnapshot(JSON.parse(row.document) as unknown);
      if (snapshot.boardId !== identity.board_id || snapshot.generation !== identity.generation) return undefined;
      return { snapshot, document: row.document, sha256: row.sha256 };
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof ValidationError) return undefined;
      throw error;
    }
  };
  const current = decode(1);
  const predecessor = decode(2);
  if (current && predecessor && predecessor.snapshot.revision !== current.snapshot.revision - 1) {
    return { current, valid: false };
  }
  return { current, predecessor, valid: !!current && (!rows.state.some((row) => row.slot === 2) || !!predecessor) };
}

function mapFailure(error: unknown): Failure {
  if (error instanceof ValidationError) return error.result;
  if (error instanceof StoreError) return failure(error.code, error.message);
  const code = sqliteCode(error);
  if (code === 5 || code === 6) return failure('BOARD_BUSY', 'The board is busy. Read the current version before trying again.');
  if (code === 11 || code === 26) return failure('RECOVERY_REQUIRED', 'The board file cannot be read safely.');
  if (code === 13) return failure('LIMIT_REACHED', 'The board cannot grow within its storage limit.');
  return failure('IO_NOT_COMMITTED', 'The operation ended without a committed change.');
}


class Board {
  readonly #store: SqliteStore;
  readonly #readOnly: boolean;
  #state: 'open' | 'recovery' | 'closed' = 'open';
  #hold: 'none' | 'unknown' | 'terminal' = 'none';
  #recovery: Recovery = { available: false };

  constructor(root: string, access: StoreAccess = 'read-write') {
    this.#store = new SqliteStore(root, access);
    this.#readOnly = access === 'read-only';
  }

  #held(): Failure {
    return this.#hold === 'terminal'
      ? failure('IO_OUTCOME_UNKNOWN', 'The original connection is uncertain. Confirm process exit before launching again.')
      : failure('IO_OUTCOME_UNKNOWN', 'The write outcome is uncertain. Read the board and compare before editing again.');
  }

  #gate(allowFreshRead = false): Failure | undefined {
    if (this.#state === 'closed') return failure('CLOSED', 'This board is closed.');
    if (this.#hold === 'terminal' || (this.#hold === 'unknown' && !allowFreshRead)) return this.#held();
    if (this.#state === 'recovery') return {
      ...failure('RECOVERY_REQUIRED', 'The board requires recovery.'), recoveryAvailable: this.#recovery.available,
    };
    return undefined;
  }

  #terminal(): Failure {
    this.#hold = 'terminal';
    this.#recovery = { available: false };
    return this.#held();
  }

  #abort(): Failure | undefined {
    try {
      this.#store.rollback();
      return undefined;
    } catch {
      return this.#terminal();
    }
  }

  #recover(predecessor?: Snapshot): Failure {
    // Serialize while the detection transaction still owns the captured snapshot.
    const backup: Recovery = predecessor && !this.#readOnly ? createRecovery(predecessor) : { available: false };
    return this.#abort() ?? this.#holdForRecovery(backup);
  }

  #holdForRecovery(backup: Recovery = { available: false }): Failure {
    try {
      this.#store.close();
    } catch {
      return this.#terminal();
    }
    this.#recovery = Object.freeze(backup);
    this.#state = 'recovery';
    this.#hold = 'none';
    return { ...failure('RECOVERY_REQUIRED', 'The board requires recovery.'), recoveryAvailable: backup.available };
  }

  #refuseRead(error: unknown): Failure {
    const uncertain = this.#abort();
    if (uncertain) return uncertain;
    if (!(error instanceof StoreError)) {
      try {
        if (!this.#store.confirmReadContention(error)) return this.#holdForRecovery();
        error = new StoreError('BOARD_BUSY', 'The board is busy. Read the current version before trying again.');
      } catch (checkError) {
        if (checkError instanceof StoreError && checkError.code === 'IO_OUTCOME_UNKNOWN') return this.#terminal();
        return this.#holdForRecovery();
      }
    }
    const result = mapFailure(error);
    if (result.error.code === 'IO_OUTCOME_UNKNOWN') return this.#terminal();
    if (result.error.code === 'RECOVERY_REQUIRED') return this.#holdForRecovery();
    if (result.error.code === 'UNSUPPORTED_VERSION') {
      const held = this.#holdForRecovery();
      return held.error.code === 'RECOVERY_REQUIRED' ? result : held;
    }
    if (result.error.code === 'BOARD_BUSY') {
      try {
        this.#store.close();
      } catch {
        return this.#terminal();
      }
    }
    return result;
  }

  #refuse(error: unknown): Failure {
    const result = mapFailure(error);
    if (result.error.code === 'RECOVERY_REQUIRED') return this.#recover();
    const uncertain = this.#abort();
    if (uncertain) return uncertain;
    if (error instanceof StoreError && error.code === 'UNSUPPORTED_VERSION') {
      try {
        this.#store.close();
      } catch {
        return this.#terminal();
      }
    }
    return result;
  }

  #capture(): Result<Captured | undefined> {
    try {
      if (!this.#store.openExisting()) return undefined;
      this.#store.begin(false);
      const captured = inspectRows(this.#store.capture());
      if (!captured.valid) return this.#recover(captured.predecessor?.snapshot);
      return this.#abort() ?? captured;
    } catch (error) {
      return this.#readOnly ? this.#refuseRead(error) : this.#refuse(error);
    }
  }

  initialize(input: unknown): Result<Initialized> {
    const refusal = this.#gate();
    if (refusal) return refusal;
    try {
      const snapshot = initialSnapshot(input);
      this.#store.initialize(snapshot.boardId, snapshot.generation, stored(snapshot));
      return initialized(snapshot);
    } catch (error) {
      return this.#refuse(error);
    }
  }

  read(): Result<Initialized | { initialized: false }> {
    const refusal = this.#gate(true);
    if (refusal) return refusal;
    const captured = this.#capture();
    if (isFailure(captured)) return captured;
    if (!captured) return this.#hold === 'unknown' ? this.#held() : { initialized: false };
    this.#hold = 'none';
    return initialized(captured.current!.snapshot);
  }

  change(input: unknown): Result<Changed> {
    return this.#mutate(input, 'change');
  }

  review(input: unknown): Result<Changed> {
    return this.#mutate(input, 'review');
  }

  github(input: unknown): Result<Changed> {
    return this.#mutate(input, 'github');
  }

  publication(input: unknown): Result<Changed> {
    return this.#mutate(input, 'publication');
  }

  #mutate(input: unknown, kind: 'change' | 'review' | 'github' | 'publication'): Result<Changed> {
    const refusal = this.#gate();
    if (refusal) return refusal;
    try {
      const command = fields(input, kind, kind === 'review'
        ? ['boardId', 'expectedVersion', 'taskId', 'decision', 'reviewer', 'scope', 'note', 'confirmed']
        : ['boardId', 'expectedVersion', 'operation']);
      if (kind === 'review' && command.confirmed !== true) {
        invalid('confirmed', 'Confirm that you reviewed the displayed criteria and evidence.');
      }
      const boardId = id(command.boardId, 'b_', 'boardId');
      const expected = expectedVersion(command.expectedVersion);
      if (!this.#store.openExisting()) return failure('NOT_INITIALIZED', 'Initialize the board before editing.');
      this.#store.begin(true);
      const captured = inspectRows(this.#store.capture());
      if (!captured.valid) return this.#recover(captured.predecessor?.snapshot);
      const current = captured.current!;
      if (current.snapshot.boardId !== boardId || version(current.snapshot) !== expected) {
        return this.#abort() ?? conflict(current.snapshot);
      }

      const proposed = structuredClone(current.snapshot);
      let createdIds: CreatedIds;
      let normalized: ReviewedSnapshot;
      if (kind === 'change') {
        createdIds = apply(proposed, command.operation);
        reconcileLocalGithub(proposed);
        const commonChange = normalizeSnapshot(proposed);
        if (JSON.stringify(commonChange) === JSON.stringify(current.snapshot)) {
          return this.#abort() ?? { ...initialized(current.snapshot), committed: false, createdIds: {} };
        }
        normalized = withReviewSchema(commonChange);
      } else if (kind === 'review') {
        normalized = withReviewSchema(proposed);
        createdIds = recordReview(normalized, command);
      } else if (kind === 'publication') {
        const type = Object.getOwnPropertyDescriptor(object(command.operation, 'publication.operation'), 'type')?.value;
        if (!hasGithub(proposed) || (proposed.schemaVersion !== 4 && type !== 'prepare-intents')) invalid('publication.operation');
        const connected: PublicationSnapshot = proposed.schemaVersion === 4 ? proposed :
          { ...proposed, schemaVersion: 4, publication: { records: [], creationLinks: [], retired: null } };
        createdIds = applyPublication(connected, command.operation);
        if (JSON.stringify(connected) === JSON.stringify(current.snapshot)) {
          return this.#abort() ?? { ...initialized(current.snapshot), committed: false, createdIds: {} };
        }
        normalized = connected;
      } else {
        const type = object(command.operation, 'github.operation').type;
        if (!hasGithub(proposed) && type !== 'prepare') invalid('github.operation', 'Prepare the GitHub connection first.');
        const connected = withGithubSchema(withReviewSchema(proposed));
        createdIds = applyGithub(connected, command.operation);
        if (type === 'issue-state') reconcileLocalGithub(connected);
        if (JSON.stringify(connected) === JSON.stringify(current.snapshot)) {
          return this.#abort() ?? { ...initialized(current.snapshot), committed: false, createdIds: {} };
        }
        normalized = connected;
      }
      const githubOperation = kind === 'github' ? object(command.operation, 'github.operation').type : null;
      if (kind === 'change' || kind === 'review' || githubOperation === 'refresh' || githubOperation === 'resolve') invalidateReviews(normalized);
      if (normalized.revision === revisionLimit) limit('revision');
      normalized.revision++;
      normalized.updatedAt = new Date().toISOString();
      const next = normalizeSnapshot(normalized);
      const candidate = stored(next);
      this.#store.stage(current, candidate);
      const staged = inspectRows(this.#store.capture());
      if (!staged.valid || staged.current?.document !== candidate.document || staged.current.sha256 !== candidate.sha256 ||
          staged.predecessor?.document !== current.document || staged.predecessor.sha256 !== current.sha256) {
        throw new Error('Staged rows did not match the change.');
      }
      const result: Changed = { ...initialized(next), committed: true, createdIds };
      try {
        this.#store.commit();
      } catch (error) {
        const code = sqliteCode(error);
        if ((code === 5 || code === 6) && this.#store.inTransaction()) return this.#refuse(error);
        return this.#reconcile(current, candidate, result);
      }
      return result;
    } catch (error) {
      return this.#refuse(error);
    }
  }

  #reconcile(prior: StoredDocument, attempted: StoredDocument, result: Changed): Result<Changed> {
    try {
      this.#store.close();
    } catch {
      return this.#terminal();
    }
    this.#hold = 'unknown';
    const captured = this.#capture();
    if (this.#state === 'recovery') {
      return failure('IO_OUTCOME_UNKNOWN', 'The write outcome is uncertain and the board requires recovery.');
    }
    if (isFailure(captured) || !captured) return this.#held();
    const matches = (record: StoredDocument | undefined, expected: StoredDocument) =>
      record?.sha256 === expected.sha256 && record.document === expected.document;
    if (matches(captured.current, attempted) || matches(captured.predecessor, attempted)) {
      this.#hold = 'none';
      return result;
    }
    if (matches(captured.current, prior)) {
      this.#hold = 'none';
      return failure('IO_NOT_COMMITTED', 'The prior board version is confirmed. The proposed change did not commit.');
    }
    return this.#held();
  }

  exportSnapshot(expected: unknown): Result<ExportPackage> {
    return this.#export(expected, (snapshot, token) => createExport(snapshot, projectReport(snapshot), token),
      'The complete export exceeds the response size limit.');
  }

  exportCurrentBackup(expected: unknown): Result<CurrentBackup> {
    return this.#export(expected, createCurrentBackup, 'The current backup exceeds the response size limit.');
  }

  preparePublicReport(input: unknown): Result<{ version: string } & PublicExportFiles> {
    const refusal = this.#gate();
    if (refusal) return refusal;
    try {
      const request = publicRequest(input);
      const captured = this.#capture();
      if (isFailure(captured)) return captured;
      if (!captured) return failure('NOT_INITIALIZED', 'Initialize the board before preparing a public report.');
      const { snapshot } = captured.current!;
      const token = version(snapshot);
      if (token !== request.expectedVersion) return conflict(snapshot);
      const files = createPublicExport(publicProjection(snapshot, request.labels));
      if (files !== undefined) {
        const payload = { version: token, ...files };
        if (Buffer.byteLength(JSON.stringify({ ok: true, ...payload }), 'utf8') <= 16 * 1024 * 1024) return payload;
      }
      return failure('LIMIT_REACHED', 'The complete public report could not be prepared within its limits.');
    } catch (error) {
      return this.#refuse(error);
    }
  }

  #export<T>(expected: unknown, serialize: (snapshot: Snapshot, token: string) => T | undefined,
    limitMessage: string): Result<T> {
    const refusal = this.#gate();
    if (refusal) return refusal;
    try {
      const token = expectedVersion(expected);
      const captured = this.#capture();
      if (isFailure(captured)) return captured;
      if (!captured) return failure('NOT_INITIALIZED', 'Initialize the board before exporting.');
      const { snapshot } = captured.current!;
      if (version(snapshot) !== token) return conflict(snapshot);
      const payload = serialize(snapshot, token);
      if (payload === undefined) return failure('LIMIT_REACHED', limitMessage);
      return payload;
    } catch (error) {
      return this.#refuse(error);
    }
  }

  recoverySnapshot(): Result<Recovery> {
    if (this.#state === 'recovery' && this.#hold === 'none') return this.#recovery;
    const refusal = this.#gate();
    if (refusal) return refusal;
    const captured = this.#capture();
    if (isFailure(captured)) return captured.error.code === 'RECOVERY_REQUIRED' ? this.#recovery : captured;
    const predecessor = captured?.predecessor?.snapshot;
    return predecessor ? createRecovery(predecessor) : { available: false };
  }

  close(): Result<{ closed: true }> {
    if (this.#state === 'closed') return failure('CLOSED', 'This board is closed.');
    this.#recovery = { available: false };
    try {
      this.#store.close();
    } catch {
      return this.#terminal();
    }
    this.#state = 'closed';
    return { closed: true };
  }
}

export function openBoard(root: string) {
  return new Board(root);
}

export function openBoardReader(root: string): BoardReader {
  const board = new Board(root, 'read-only');
  return Object.freeze({
    read: () => board.read(),
    close: () => board.close(),
  });
}
