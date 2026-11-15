import { createHash, randomUUID } from 'node:crypto';
import { request } from 'node:https';
import { createServer } from 'node:net';
import { userInfo } from 'node:os';
import { normalize } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { githubPendingFields, hasGithub, publicationDestination, publicationFields, publicationRefusal, publicationRetirable,
  publicationState, publicationTarget, publicationValues, samePublicationIssue } from './board.ts';
import type { Changed, Failure, GithubCode, GithubCollection, GithubFact, GithubIssueValues, GithubKind,
  GithubRepository, GithubState, Initialized, PublicationField, PublicationIntent, PublicationIssue, PublicationOutcome, openBoard } from './board.ts';
import type { GithubAppConfig } from './github-config.ts';
export type { GithubAppConfig } from './github-config.ts';

type Board = Pick<ReturnType<typeof openBoard>, 'read' | 'github' | 'publication' | 'exportCurrentBackup'>;
type RecordInput = Record<string, unknown>;
type Reply = { status: number; headers: Record<string, string | string[] | undefined>; body: Buffer };
type Request = { url: URL; method: 'GET' | 'POST' | 'PATCH'; headers: Record<string, string>; body?: string; cap: number;
  signal: AbortSignal; observedStatus?: (status: number) => void };
type Owner = { close(): Promise<void> };
type Vault = { read(): Promise<Buffer | null>; write(value: Buffer): Promise<void>; remove(): Promise<void> };
type Target = { boardId: string; generation: string; rootBinding: string };
export type GithubDependencies = {
  request?: (input: Request) => Promise<Reply>;
  vault?: (target: Target) => Promise<Vault>;
  acquire?: (target: Target) => Promise<Owner>;
  now?: () => number;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
};
const service = 'KitFlint.Glance.GitHub.v1';
const api = 'https://api.github.com';
const auth = 'https://github.com';
const deviceUrl = auth + '/login/device';
const revokeUrl = auth + '/settings/installations';
const minutes = 60_000;
const previewLifetime = 10 * minutes;
const maxRecord = 2400;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const versionPattern = new RegExp(uuidPattern.source.slice(0, -1) + ':[1-9][0-9]{0,9}$');
const boardPattern = /^b_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const tasksPattern = /^t_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ownerPattern = /^[A-Za-z0-9-]{1,100}$/;
const repoPattern = /^[A-Za-z0-9_.-]{1,100}$/;
const hashPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const apiVersion = '2026-03-10';
const messages: Record<GithubCode, string> = {
  CONFIG_REQUIRED: 'GitHub connection is not configured in this build.',
  PLATFORM_UNSUPPORTED: 'Protected GitHub credentials require Windows x64.',
  CONNECTION_BUSY: 'Another operation owns this GitHub connection.',
  CONNECTION_REQUIRED: 'Sign in and select the repository to continue.',
  AUTH_DENIED: 'GitHub sign-in was denied.',
  AUTH_EXPIRED: 'The sign-in expired. Sign in again.',
  AUTH_CANCELLED: 'GitHub sign-in was cancelled.',
  INSTALLATION_REQUIRED: 'Install the GitHub App or request access, then check again.',
  PERMISSION_REQUIRED: 'The current installation or user lacks the required read permission.',
  REPOSITORY_UNAVAILABLE: 'The repository is unavailable in the selected installation.',
  DESTINATION_MISMATCH: 'The confirmed GitHub repository changed.',
  RATE_LIMITED: 'GitHub rate limited the request. Try again after the indicated time.',
  NETWORK_FAILED: 'The GitHub request did not complete.',
  REQUEST_TIMEOUT: 'The GitHub request timed out.',
  RESPONSE_INVALID: 'GitHub returned an unexpected response.',
  RESPONSE_LIMIT: 'The response exceeds the allowed size.',
  OPERATION_LIMIT: 'The operation could not finish within its limits.',
  CREDENTIAL_UNAVAILABLE: 'Protected GitHub credentials are unavailable.',
  CREDENTIAL_ROTATION_UNCERTAIN: 'GitHub did not renew this sign-in. It may have been revoked or expired. Sign in again.',
  CREDENTIAL_MISMATCH: 'The protected entry belongs to a different board or location.',
  PREVIEW_EXPIRED: 'Refresh the selected scope to obtain a current import preview.',
  OPERATION_CANCELLED: 'The GitHub operation was cancelled.',
  CLEANUP_UNKNOWN: 'Local credential cleanup could not be confirmed.',
};
class GithubError extends Error {
  readonly code: GithubCode;
  readonly nextAllowedAt?: string;
  constructor(code: GithubCode, nextAllowedAt?: string) {
    super(messages[code]);
    this.code = code;
    this.nextAllowedAt = nextAllowedAt;
  }
}
class BoardRefusal extends Error {
  readonly failure: Failure;
  constructor(failure: Failure) { super(failure.error.message); this.failure = failure; }
}
function refuse(code: GithubCode): never { throw new GithubError(code); }
function malformed(): never { throw new BoardRefusal({ error: { code: 'INVALID_INPUT', message: 'Invalid GitHub request.' } }); }
function plain(value: unknown, error: () => never = () => refuse('RESPONSE_INVALID')): RecordInput {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) error();
  return value as RecordInput;
}
function exact(value: unknown, keys: string[], error: () => never = malformed): RecordInput {
  const row = plain(value, error);
  if (Reflect.ownKeys(row).length !== keys.length ||
      keys.some((key) => !Object.hasOwn(row, key) || !('value' in Object.getOwnPropertyDescriptor(row, key)!))) error();
  return row;
}
function string(value: unknown, test: RegExp, error: () => never = () => refuse('RESPONSE_INVALID')): string {
  if (typeof value !== 'string') return error();
  if (test.exec(value)?.[0] !== value) return error();
  return value;
}
function integer(value: unknown, max = Number.MAX_SAFE_INTEGER, min = 1, error: () => never = () => refuse('RESPONSE_INVALID')): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) return error();
  return value;
}
function providerId(value: unknown): string {
  return typeof value === 'number' ? String(integer(value)) : localId(value, () => refuse('RESPONSE_INVALID'));
}
function localId(value: unknown, error: () => never = malformed): string {
  const id = string(value, /^[1-9][0-9]{0,15}$/, error);
  if (!Number.isSafeInteger(Number(id))) error();
  return id;
}
function date(value: unknown, error: () => never = () => refuse('RESPONSE_INVALID')): string {
  const text = string(value, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/, error);
  const instant = new Date(text);
  if (!Number.isFinite(instant.valueOf()) || instant.toISOString().slice(0, 19) !== text.slice(0, 19)) error();
  return text;
}
function boundedText(value: unknown, min: number, max: number): string {
  if (typeof value !== 'string' || value.length < min || value.length > max ||
      /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(value)) refuse('RESPONSE_INVALID');
  return value;
}
function ref(value: unknown, max = 255): string {
  const result = boundedText(value, 1, max);
  if (/[\x00-\x1f\x7f-\x9f]/.test(result)) refuse('RESPONSE_INVALID');
  return result;
}
function optional<T>(value: unknown, convert: (v: unknown) => T): T | null {
  return value == null ? null : convert(value);
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') refuse('RESPONSE_INVALID');
  return value;
}
function list(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) refuse('RESPONSE_INVALID');
  return value;
}
function epoch(board: Initialized): string | null {
  return hasGithub(board.snapshot) ? board.snapshot.github.connectionEpoch : null;
}
function saved(board: Board): Initialized {
  const result = board.read();
  if ('error' in result) throw new BoardRefusal(result);
  if (!result.initialized) throw new BoardRefusal({ error: { code: 'NOT_INITIALIZED', message: 'Initialize a board first.' } });
  return result;
}
function checked(board: Board, value: unknown, keys: string[] = []): { board: Initialized; input: RecordInput } {
  const input = exact(value, ['boardId', 'expectedVersion', ...keys]);
  const boardId = string(input.boardId, boardPattern, malformed);
  const version = string(input.expectedVersion, versionPattern, malformed);
  if (Number(version.slice(37)) > 2_147_483_647) malformed();
  const current = saved(board);
  if (current.snapshot.boardId !== boardId || current.version !== version) {
    throw new BoardRefusal({ error: { code: 'REVISION_CONFLICT', message: 'The board version changed.' },
      current: { snapshot: current.snapshot, version: current.version, report: current.report } });
  }
  return { board: current, input };
}
function transition(board: Board, from: Initialized, operation: object): Changed {
  const result = board.github({ boardId: from.snapshot.boardId, expectedVersion: from.version, operation });
  if ('error' in result) throw new BoardRefusal(result);
  return result;
}
function githubState(board: Initialized): GithubState {
  if (!hasGithub(board.snapshot)) refuse('CONNECTION_REQUIRED');
  return board.snapshot.github;
}
function sameTarget(current: Initialized, prior: Initialized): boolean {
  return current.snapshot.boardId === prior.snapshot.boardId && current.snapshot.generation === prior.snapshot.generation;
}
function nativePlatform(): void {
  if (process.platform !== 'win32' || process.arch !== 'x64') refuse('PLATFORM_UNSUPPORTED');
}
function targetName(target: Target): string {
  if (!boardPattern.test(target.boardId) || !uuidPattern.test(target.generation)) refuse('CREDENTIAL_MISMATCH');
  return target.boardId + ':' + target.generation;
}
async function nativeVault(target: Target): Promise<Vault> {
  nativePlatform();
  const username = targetName(target);
  try {
    const packageName = '@napi-rs/keyring';
    const { AsyncEntry } = await import(packageName) as {
      AsyncEntry: new (service: string, user: string) => {
        getSecret(): Promise<number[] | null>; setSecret(value: Buffer): Promise<void>; deleteCredential(): Promise<boolean>;
      };
    };
    const entry = new AsyncEntry(service, username);
    return {
      async read() {
        const bytes = await entry.getSecret();
        if (bytes === null) return null;
        if (!Array.isArray(bytes) || bytes.length > maxRecord || bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
          refuse('CREDENTIAL_UNAVAILABLE');
        }
        return Buffer.from(bytes);
      },
      write: (value) => entry.setSecret(value),
      async remove() { await entry.deleteCredential(); },
    };
  } catch {
    return refuse('CREDENTIAL_UNAVAILABLE');
  }
}

export async function acquireGithubOwner(target: Target): Promise<Owner> {
  nativePlatform();
  targetName(target);
  let home: string;
  try {
    home = normalize(userInfo().homedir).replace(/[\\/]+$/, '').toLowerCase();
    if (!/^[a-z]:\\/.test(home)) refuse('PLATFORM_UNSUPPORTED');
  } catch { return refuse('PLATFORM_UNSUPPORTED'); }
  const suffix = createHash('sha256').update([home, service, target.boardId, target.generation]
    .map((part) => Buffer.byteLength(part) + ':' + part).join('')).digest('hex');
  const sockets = new Set<Promise<void>>();
  const pipe = createServer((socket) => {
    const closed = new Promise<void>((resolve) => socket.once('close', resolve));
    sockets.add(closed);
    void closed.then(() => sockets.delete(closed));
    socket.once('error', () => {});
    socket.destroy();
  });
  await new Promise<void>((resolve, reject) => {
    const failed = (error: NodeJS.ErrnoException) => reject(new GithubError(
      error.code === 'EADDRINUSE' || error.code === 'EACCES' ? 'CONNECTION_BUSY' : 'CREDENTIAL_UNAVAILABLE'));
    pipe.once('error', failed);
    pipe.listen({ path: '\\\\.\\pipe\\kitflint-glance-github-' + suffix, exclusive: true }, () => {
      pipe.off('error', failed);
      resolve();
    });
  });
  return { async close() {
    await new Promise<void>((resolve, reject) => pipe.close((error) => error ? reject(new GithubError('CLEANUP_UNKNOWN')) : resolve()));
    await Promise.all(sockets);
  } };
}

async function httpsRequest(input: Request): Promise<Reply> {
  return new Promise((resolve, reject) => {
    let reply: Reply | undefined;
    let failure: unknown;
    let socketClosed = Promise.resolve();
    const headers = input.body === undefined ? input.headers : { ...input.headers, 'Content-Length': String(Buffer.byteLength(input.body)) };
    const req = request(input.url, { method: input.method, headers, agent: false, signal: input.signal }, (res) => {
      if (res.statusCode !== undefined) input.observedStatus?.(res.statusCode);
      const buffers: Buffer[] = [];
      let size = 0;
      const encoding = res.headers['content-encoding'];
      if (encoding !== undefined && encoding !== 'identity') {
        failure = new GithubError('RESPONSE_INVALID');
        req.destroy();
        return;
      }
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > input.cap) {
          failure = new GithubError('RESPONSE_LIMIT');
          req.destroy();
        } else buffers.push(chunk);
      });
      res.once('error', () => { failure ??= new GithubError('NETWORK_FAILED'); });
      res.once('end', () => {
        if (res.complete && !failure) reply = { status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(buffers, size) };
      });
    });
    req.once('socket', (socket) => {
      socketClosed = new Promise((closed) => { socket.once('close', () => closed()); });
    });
    req.once('error', () => { failure ??= new GithubError('NETWORK_FAILED'); });
    req.once('close', () => {
      void socketClosed.then(() => {
        if (reply && !failure) resolve(reply);
        else reject(failure ?? new GithubError('NETWORK_FAILED'));
      });
    });
    req.end(input.body);
  });
}


type TokenPair = { accessToken: string; accessExpiresAt: string; refreshToken: string; refreshExpiresAt: string };
type Credential = TokenPair & Target & { version: 1; clientId: string; authenticatedUserId: string; connectionEpoch: string;
  state: 'pending-selection' | 'active' | 'rotation-pending' };
type Budget = { requests: number; pages: number; bytes: number; until: number };
type Permissions = { issues: Grant; pullRequests: Grant; actions: Grant; contents: Grant; metadata: Grant };
type Grant = 'none' | 'read' | 'write' | 'unknown';
type Installation = { id: string; accountLogin: string; accountType: string; permissions: Permissions };
type Repo = { id: string; owner: string; name: string; visibility: GithubRepository['visibility']; defaultBranch: string | null };
type UserPermissions = { pull: boolean | null; push: boolean | null; admin: boolean | null };
type Capabilities = { checkedAt: string; installationId: string; repositoryId: string; app: Permissions; user: UserPermissions;
  state: 'verified' | 'unavailable' };
type Page = { kind: 'installations' | 'repositories'; installationId?: string; page: number; moreAvailable: boolean };
type Issue = { issueId: string; number: number; remoteUpdatedAt: string; fetchedAt: string; values: GithubIssueValues };
type PreviewIssue = Issue | { issueId: string; number: number; ineligible: 'FIELD_LIMIT' };
type Preview = { version: string; expiresAt: string; issues: PreviewIssue[]; facts: GithubFact[]; collection: GithubCollection };
type ReviewAction = { intent: PublicationIntent; baseline: GithubIssueValues | null };
type PublishResult = { intentId: string; taskId: string; outcome: PublicationOutcome; recorded: boolean; attached?: boolean };
type PublicationWork =
  | { kind: 'publish-preview'; version: string; expiresAt: string; actions: ReviewAction[] }
  | { kind: 'publishing'; expiresAt: string; results: PublishResult[] }
  | { kind: 'reconcile-preview'; version: string; expiresAt: string; intentId: string; issue: Issue;
      repository: PublicationIntent['repository']; taskId: string | null; action: 'create' | 'update'; proposed: PublicationIntent['proposed'] | null }
  | { kind: 'retire-preview'; version: string; expiresAt: string; ids: string[]; backupSha256: string; backupJson: string };
type PublicationWire = { method: 'POST' | 'PATCH'; body: string; entered(): void; observed(status: number): void };
type State = 'starting' | 'awaiting-code' | 'discovering' | 'choosing-repository' | 'selecting' | 'refreshing' |
  'succeeded' | 'cancelled' | 'failed' | 'stopping';
type Work = {
  id: string; session: string; state: State; board: Initialized; controller: AbortController; lastHeartbeat: number;
  device: { userCode: string; verificationUri: string; expiresAt: string } | null;
  installations: Installation[]; repositories: Repo[]; discovery: Page | null;
  installationPages: Map<string, number>; capabilities: Capabilities | null; preview: Preview | null;
  code: GithubCode | null; boardFailure?: Failure['error']; nextAllowedAt?: string;
  cleanup: 'pending' | 'complete' | 'unknown' | null; localDisconnected: boolean;
  expires: number; authUntil: number; owner?: Owner; pair?: TokenPair; userId?: string; task?: Promise<void>;
  monitor?: ReturnType<typeof setInterval>; cleanupEpochs?: Set<string>; selectionWriteEpoch?: string;
  oldWork?: Promise<void>; prior?: Work; refresh?: boolean; cancelled?: boolean;
  publication?: PublicationWork; sendingClosed?: boolean; publicationRecordingClosed?: boolean;
  publicationDeadline?: number;
};
type Scope = { kind: GithubKind; page: number; pages: number; linkedTaskIds: string[]; pullRequestId: string | null };
const kindToPath: Record<Exclude<GithubKind, 'pull-request-reviews'>, string> = {
  issues: '/issues', 'pull-requests': '/pulls', 'workflow-runs': '/actions/runs', releases: '/releases',
};
const requiredGrant: Record<GithubKind, keyof Permissions> = {
  issues: 'issues', 'pull-requests': 'pullRequests', 'pull-request-reviews': 'pullRequests', 'workflow-runs': 'actions', releases: 'contents',
};

function permissions(value: unknown): Permissions {
  const row = value == null ? {} : plain(value);
  const grant = (entry: unknown): Grant => entry === 'none' || entry === 'read' || entry === 'write' ? entry : 'unknown';
  return { issues: grant(row.issues), pullRequests: grant(row.pull_requests), actions: grant(row.actions),
    contents: grant(row.contents), metadata: grant(row.metadata) };
}
function installation(value: unknown): Installation {
  const row = plain(value), account = plain(row.account);
  return { id: providerId(row.id), accountLogin: string(account.login, /^[A-Za-z0-9_-]{1,100}$/),
    accountType: string(account.type, /^(?:User|Organization)$/), permissions: permissions(row.permissions) };
}
function repository(value: unknown): Repo {
  const row = plain(value), owner = plain(row.owner);
  const name = string(row.name, repoPattern);
  if (name === '.' || name === '..') refuse('RESPONSE_INVALID');
  return { id: providerId(row.id), owner: string(owner.login, ownerPattern), name,
    visibility: string(row.visibility, /^(?:public|private|internal)$/) as Repo['visibility'],
    defaultBranch: optional(row.default_branch, ref) };
}
function userPermissions(value: unknown): UserPermissions {
  const row = value == null ? {} : plain(value);
  return { pull: optional(row.pull, boolean), push: optional(row.push, boolean), admin: optional(row.admin, boolean) };
}
const tokenPattern = /^[\x21-\x7e]+$/;
function tokenPair(value: unknown, now: number): TokenPair {
  const row = plain(value);
  if (typeof row.token_type !== 'string' || row.token_type.toLowerCase() !== 'bearer') refuse('RESPONSE_INVALID');
  return { accessToken: string(row.access_token, tokenPattern),
    refreshToken: string(row.refresh_token, tokenPattern),
    accessExpiresAt: new Date(now + integer(row.expires_in, 31_536_000) * 1000).toISOString(),
    refreshExpiresAt: new Date(now + integer(row.refresh_token_expires_in, 31_536_000) * 1000).toISOString() };
}
function credential(bytes: Buffer, target: Target, clientId: string): Credential {
  const bad = () => refuse('CREDENTIAL_MISMATCH');
  if (bytes.length > maxRecord) bad();
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return bad(); }
  const row = exact(value, ['version', 'clientId', 'authenticatedUserId', 'boardId', 'generation', 'rootBinding', 'connectionEpoch',
    'state', 'accessToken', 'accessExpiresAt', 'refreshToken', 'refreshExpiresAt'], bad);
  if (row.version !== 1 || row.clientId !== clientId || row.boardId !== target.boardId ||
      row.generation !== target.generation || row.rootBinding !== target.rootBinding) bad();
  const state = string(row.state, /^(?:pending-selection|active|rotation-pending)$/, bad) as Credential['state'];
  return { version: 1, clientId, ...target, authenticatedUserId: localId(row.authenticatedUserId, bad),
    connectionEpoch: string(row.connectionEpoch, uuidPattern, bad), state,
    accessToken: string(row.accessToken, tokenPattern, bad), refreshToken: string(row.refreshToken, tokenPattern, bad),
    accessExpiresAt: date(row.accessExpiresAt, bad), refreshExpiresAt: date(row.refreshExpiresAt, bad) };
}
function encodeCredential(value: Credential): Buffer {
  const data = Buffer.from(JSON.stringify(value), 'utf8');
  if (data.length > maxRecord) refuse('CREDENTIAL_UNAVAILABLE');
  return data;
}
function scope(value: unknown): Scope {
  const row = exact(value, ['kind', 'page', 'pages', 'linkedTaskIds', 'pullRequestId']);
  const kind = string(row.kind, /^(?:issues|pull-requests|workflow-runs|releases|pull-request-reviews)$/, malformed) as GithubKind;
  const page = integer(row.page, 1000, 1, malformed), pages = integer(row.pages, 3, 1, malformed);
  if (page + pages - 1 > 1000 || !Array.isArray(row.linkedTaskIds) || row.linkedTaskIds.length > (kind === 'issues' ? 8 : 0)) malformed();
  const linkedTaskIds = row.linkedTaskIds.map((key) => string(key, tasksPattern, malformed));
  if (new Set(linkedTaskIds).size !== linkedTaskIds.length) malformed();
  const pullRequestId = row.pullRequestId === null ? null : localId(row.pullRequestId);
  if ((kind === 'pull-request-reviews') !== (pullRequestId !== null)) malformed();
  return { kind, page, pages, linkedTaskIds, pullRequestId };
}
function pageUrl(path: string, page: number, state = false): URL {
  const url = new URL(api + path);
  if (state) url.searchParams.set('state', 'all');
  url.searchParams.set('per_page', '10');
  url.searchParams.set('page', String(page));
  return url;
}
function nextPage(header: Reply['headers']['link'], url: URL): number | null {
  if (header === undefined) return null;
  if (typeof header !== 'string' || header.length > 8192) refuse('RESPONSE_INVALID');
  const links = header.split(/,\s*(?=<)/);
  let next: number | null = null;
  for (const link of links) {
    const match = /^<([^<>]+)>;\s*rel="([a-z]+)"$/.exec(link.trim());
    if (!match) refuse('RESPONSE_INVALID');
    if (match[2] !== 'next') continue;
    if (next !== null) refuse('RESPONSE_INVALID');
    let target: URL;
    try { target = new URL(match[1]); } catch { return refuse('RESPONSE_INVALID'); }
    if (target.origin !== api || target.pathname !== url.pathname || target.username || target.password || target.hash) refuse('RESPONSE_INVALID');
    const page = target.searchParams.get('page');
    const oldPage = Number(url.searchParams.get('page'));
    if (!page || !/^[1-9][0-9]{0,3}$/.test(page) || Number(page) !== oldPage + 1 || Number(page) > 1000) refuse('RESPONSE_INVALID');
    const remaining = (params: URLSearchParams) => [...params].filter(([key]) => key !== 'page').sort().map((pair) => pair.join('=')).join('&');
    if (target.searchParams.getAll('page').length !== 1 || remaining(target.searchParams) !== remaining(url.searchParams)) refuse('RESPONSE_INVALID');
    next = Number(page);
  }
  return next;
}
function parseJson(reply: Reply): unknown {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(reply.body)); }
  catch { return refuse('RESPONSE_INVALID'); }
}
function issueIdentity(row: RecordInput): PublicationIssue | null {
  if (Object.hasOwn(row, 'pull_request')) return null;
  return { id: providerId(row.id), number: integer(row.number) };
}
function issueRecord(value: unknown, now: string): PreviewIssue | null {
  const row = plain(value);
  const identity = issueIdentity(row);
  if (!identity) return null;
  const { id: issueId, number } = identity;
  const body = row.body === null ? '' : row.body;
  if (typeof row.title !== 'string' || typeof body !== 'string') refuse('RESPONSE_INVALID');
  if (row.title.length < 1 || row.title.length > 200 || body.length > 16_000 ||
      /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(row.title + body)) return { issueId, number, ineligible: 'FIELD_LIMIT' };
  return { issueId, number, remoteUpdatedAt: date(row.updated_at), fetchedAt: now,
    values: { title: row.title, body, state: string(row.state, /^(?:open|closed)$/) as GithubIssueValues['state'] } };
}
function factRecord(value: unknown, kind: Exclude<GithubKind, 'issues'>, repositoryId: string, observedAt: string,
  parent?: { id: string; number: number }): GithubFact {
  const row = plain(value);
  const base = { id: providerId(row.id), repositoryId, observedAt };
  const sha = (v: unknown) => optional(v, (v) => string(v, hashPattern));
  switch (kind) {
    case 'pull-requests': {
      const head = row.head == null ? null : plain(row.head), baseRef = row.base == null ? null : plain(row.base);
      return { kind: 'pull-request', ...base, number: integer(row.number),
        state: string(row.state, /^(?:open|closed)$/) as GithubIssueValues['state'], merged: optional(row.merged, boolean),
        headSha: sha(head?.sha), baseRef: optional(baseRef?.ref, ref), updatedAt: date(row.updated_at) };
    }
    case 'workflow-runs':
      return { kind: 'workflow-run', ...base, workflowId: providerId(row.workflow_id),
        status: optional(row.status, (v) => ref(v, 80)), conclusion: optional(row.conclusion, (v) => ref(v, 80)),
        headSha: sha(row.head_sha), headBranch: optional(row.head_branch, ref), attempt: integer(row.run_attempt),
        createdAt: date(row.created_at), updatedAt: date(row.updated_at) };
    case 'releases':
      return { kind: 'release', ...base, tagName: ref(row.tag_name), targetCommitish: ref(row.target_commitish),
        draft: boolean(row.draft), prerelease: boolean(row.prerelease), publishedAt: optional(row.published_at, date) };
    case 'pull-request-reviews':
      if (!parent) refuse('RESPONSE_INVALID');
      return { kind: 'pull-request-review', ...base, pullRequestId: parent.id, number: parent.number, commitId: sha(row.commit_id),
        state: ref(row.state, 80), authorLogin: optional(row.user, (v) => string(plain(v).login, /^[A-Za-z0-9_-]{1,100}$/)),
        submittedAt: optional(row.submitted_at, date) };
  }
}


type Context = { operation: Work; budget: Budget; deviceFlow?: boolean };
type ReplyStatus = ReturnType<typeof operationStatus>;
function operationStatus(work: Work) {
  const publication = work.publication?.kind === 'publish-preview'
    ? { ...work.publication, actions: work.publication.actions.map(({ intent }) => ({ intent })) }
    : work.publication;
  return {
    operationId: work.id, state: work.owner && ['succeeded', 'failed', 'cancelled'].includes(work.state) ? 'stopping' : work.state,
    code: work.boardFailure?.code ?? work.code, message: work.boardFailure?.message ?? (work.code ? messages[work.code] : null),
    device: work.device, installations: work.discovery?.kind === 'installations' ? work.installations : null,
    repositories: work.discovery?.kind === 'repositories' ? work.repositories : null,
    discovery: work.discovery, capabilities: work.capabilities, preview: work.preview,
    cleanup: work.cleanup, localDisconnected: work.localDisconnected,
    ...(publication?.kind !== 'retire-preview' && publication ? { publication } : {}),
    ...(work.nextAllowedAt ? { nextAllowedAt: work.nextAllowedAt } : {}),
  };
}
function grantRead(value: Grant): boolean { return value === 'read' || value === 'write'; }

export function githubErrorResponse(error: unknown): Failure | { error: { code: GithubCode; message: string; nextAllowedAt?: string } } {
  if (error instanceof BoardRefusal) return error.failure;
  const failure = error instanceof GithubError ? error : new GithubError('NETWORK_FAILED');
  return { error: { code: failure.code, message: failure.message,
    ...(failure.nextAllowedAt ? { nextAllowedAt: failure.nextAllowedAt } : {}) } };
}
export function githubHttpStatus(code: string): number {
  if (code === 'CONNECTION_BUSY') return 423;
  if (code === 'RESPONSE_LIMIT' || code === 'OPERATION_LIMIT') return 413;
  if (['CONFIG_REQUIRED', 'PLATFORM_UNSUPPORTED', 'CONNECTION_REQUIRED', 'DESTINATION_MISMATCH',
    'PREVIEW_EXPIRED', 'INSTALLATION_REQUIRED', 'PERMISSION_REQUIRED', 'REPOSITORY_UNAVAILABLE', 'CREDENTIAL_MISMATCH'].includes(code)) return 409;
  return 503;
}

export function githubOverview(current: Initialized, config: GithubAppConfig | null) {
  const state = hasGithub(current.snapshot) ? current.snapshot.github : null;
  const publication = current.snapshot.schemaVersion === 4 ? current.snapshot.publication : null;
  return {
    configured: config !== null, boardState: 'READY', boardId: current.snapshot.boardId, version: current.version,
    selection: state?.selection ?? 'none', repository: state?.repository ?? null,
    installationUrl: config && /^[A-Za-z0-9-]{1,100}$/.test(config.slug) ? auth + '/apps/' + config.slug + '/installations/new' : null,
    createRepositoryUrl: auth + '/new', revocationUrl: revokeUrl,
    collections: state?.collections ?? [], facts: state?.facts ?? [],
    issues: state?.issues.map((mapping) => {
      const task = current.snapshot.tasks.find((t) => t.id === mapping.localTaskId)!;
      return { ...mapping, local: { title: task.title, body: task.description, state: mapping.localIssueState },
        pendingFields: githubPendingFields(current.snapshot, task, mapping) };
    }) ?? [], lastAttempt: state?.lastAttempt ?? null,
    publication: publication && { records: publication.records.map((record) => {
      const { intent } = record;
      return { ...record, intent: { id: intent.id, repository: intent.repository, action: intent.action, issue: intent.issue,
        preparedAt: intent.preparedAt, proposed: Object.fromEntries(record.mergePendingFields.map((key) => [key, intent.proposed[key]])) },
        state: publicationState(record), retirable: publicationRetirable(current.snapshot, record) };
    }),
      creationLinks: publication.creationLinks, retired: publication.retired },
  };
}

class GithubConnection {
  readonly #board: Board;
  readonly #rootBinding: string;
  readonly #config: GithubAppConfig | null;
  readonly #request: NonNullable<GithubDependencies['request']>;
  readonly #vault: NonNullable<GithubDependencies['vault']>;
  readonly #acquire: NonNullable<GithubDependencies['acquire']>;
  readonly #now: () => number;
  readonly #wait: NonNullable<GithubDependencies['wait']>;
  #current: Work | undefined;
  #credentialState: 'unchecked' | 'active-for-this-process' | 'reconnect-required' = 'unchecked';
  #credentialEpoch: string | null = null;
  #closed = false;
  #closure: Promise<void> | undefined;

  constructor(board: Board, root: string, config: GithubAppConfig | null, dependencies: GithubDependencies) {
    this.#board = board;
    this.#config = config;
    this.#rootBinding = createHash('sha256').update(root.toLowerCase()).digest('hex');
    this.#request = dependencies.request ?? httpsRequest;
    const vaultFactory = dependencies.vault ?? nativeVault;
    this.#vault = async (target) => {
      const safe = async <T>(action: () => Promise<T>): Promise<T> => {
        try { return await action(); }
        catch (error) { throw error instanceof GithubError ? error : new GithubError('CREDENTIAL_UNAVAILABLE'); }
      };
      const vault = await safe(() => vaultFactory(target));
      return { read: () => safe(() => vault.read()), write: (bytes) => safe(() => vault.write(bytes)), remove: () => safe(() => vault.remove()) };
    };
    this.#acquire = dependencies.acquire ?? acquireGithubOwner;
    this.#now = dependencies.now ?? Date.now;
    this.#wait = dependencies.wait ?? ((ms, signal) => delay(ms, undefined, { signal }));
  }
  #time(): string { return new Date(this.#now()).toISOString(); }
  #budget(): Budget { return { requests: 0, pages: 0, bytes: 0, until: this.#now() + minutes }; }
  #configRequired(): GithubAppConfig {
    if (this.#closed) refuse('OPERATION_CANCELLED');
    if (!this.#config) refuse('CONFIG_REQUIRED');
    return this.#config;
  }
  #target(board: Initialized): Target {
    return { boardId: board.snapshot.boardId, generation: board.snapshot.generation, rootBinding: this.#rootBinding };
  }
  #newWork(session: string, board: Initialized, state: State): Work {
    return {
      id: randomUUID(), session, state, board, controller: new AbortController(), lastHeartbeat: this.#now(),
      device: null, installations: [], repositories: [], discovery: null, installationPages: new Map(),
      capabilities: null, preview: null, code: null, cleanup: null, localDisconnected: false,
      expires: this.#now() + previewLifetime, authUntil: Infinity,
    };
  }
  #sameFence(work: Work): Initialized {
    const current = saved(this.#board);
    if (!sameTarget(current, work.board) || epoch(current) !== epoch(work.board)) refuse('OPERATION_CANCELLED');
    return current;
  }
  #guard(work: Work, strict = true): Initialized {
    if (this.#closed || this.#current !== work || work.controller.signal.aborted) refuse('OPERATION_CANCELLED');
    const current = this.#sameFence(work);
    if (strict && current.version !== work.board.version) {
      throw new BoardRefusal({ error: { code: 'REVISION_CONFLICT', message: 'The board version changed.' },
        current: { snapshot: current.snapshot, version: current.version, report: current.report } });
    }
    return current;
  }
  invalidatePublicationVersion(): void {
    const work = this.#current;
    if (!work?.publication) return;
    this.#publicationAuthority(work);
    if (work.sendingClosed && work.publication.kind !== 'publishing') work.publication = undefined;
  }
  #visible(session: string, input: unknown): Work {
    const value = exact(input, ['operationId']);
    const id = string(value.operationId, uuidPattern, malformed);
    const work = this.#current;
    if (!work || work.id !== id || work.session !== session) refuse('PREVIEW_EXPIRED');
    if (this.#terminal(work) && this.#now() >= work.expires) {
      this.#current = undefined;
      refuse('PREVIEW_EXPIRED');
    }
    return work;
  }
  #terminal(work: Work): boolean { return ['succeeded', 'failed', 'cancelled'].includes(work.state); }
  #busy(): boolean {
    return !!this.#current && (!!this.#current.task || !this.#terminal(this.#current));
  }
  #allowNew(): void { if (this.#busy()) refuse('CONNECTION_BUSY'); }
  #clearSensitive(work: Work): void {
    work.device = null;
    work.pair = undefined;
    work.userId = undefined;
    work.installations = [];
    work.repositories = [];
    work.installationPages.clear();
    work.discovery = null;
    clearInterval(work.monitor);
    work.monitor = undefined;
  }
  #failure(work: Work, error: unknown): void {
    const stopped = work.controller.signal.aborted;
    if (!stopped && error instanceof BoardRefusal) work.boardFailure = error.failure.error;
    const failure = error instanceof GithubError ? error : new GithubError(stopped ? 'OPERATION_CANCELLED' : 'NETWORK_FAILED');
    work.code = work.boardFailure ? null : failure.code;
    work.nextAllowedAt = failure.nextAllowedAt;
    work.state = stopped ? 'cancelled' : 'failed';
    work.expires = this.#now() + previewLifetime;
    work.capabilities = null;
    work.preview = null;
    if (['CONNECTION_REQUIRED', 'CREDENTIAL_UNAVAILABLE', 'CREDENTIAL_MISMATCH', 'CREDENTIAL_ROTATION_UNCERTAIN'].includes(failure.code)) {
      this.#credentialState = 'reconnect-required';
    }
  }
  #monitor(work: Work, authWork: boolean): void {
    if (work.monitor) return;
    work.monitor = setInterval(() => {
      if (work.controller.signal.aborted) return;
      let code: GithubCode | null = null;
      try { this.#sameFence(work); } catch { code = 'OPERATION_CANCELLED'; }
      if (!code && work.publication?.kind === 'publishing' && this.#now() >= work.authUntil) code = 'OPERATION_CANCELLED';
      if (!code && authWork) {
        if (this.#now() >= work.authUntil) code = 'AUTH_EXPIRED';
        else if (this.#now() - work.lastHeartbeat >= minutes) code = 'AUTH_CANCELLED';
      }
      if (!code) return;
      if (work.publication?.kind === 'publishing') work.sendingClosed = true;
      work.controller.abort(new GithubError(code));
      if (!work.task) this.#run(work, async () => { throw new GithubError(code); });
    }, 500);
  }
  #run(work: Work, process: () => Promise<void>, preserveChooser = false): void {
    const task = Promise.resolve().then(async () => {
      try { await process(); }
      catch (error) {
        if (preserveChooser && !work.controller.signal.aborted && this.#now() < work.authUntil && work.pair) {
          const failure = error instanceof GithubError ? error : new GithubError('NETWORK_FAILED');
          work.code = failure.code;
          work.nextAllowedAt = failure.nextAllowedAt;
          work.state = 'choosing-repository';
          return;
        }
        if (work.refresh && !work.cancelled && !work.controller.signal.aborted && error instanceof GithubError) {
          this.#recordAttempt(work, 'failed', error.code);
        }
        this.#failure(work, work.controller.signal.aborted ? work.controller.signal.reason : error);
      } finally {
        if (work.state !== 'choosing-repository') {
          this.#clearSensitive(work);
          if (work.owner) {
            try {
              await this.#deleteFencedCredential(work);
            } catch {
              work.state = 'failed';
              work.cleanup = 'unknown';
              work.code = 'CLEANUP_UNKNOWN';
            }
            try {
              await work.owner.close();
              work.owner = undefined;
            } catch {
              work.state = 'stopping';
              work.cleanup = 'unknown';
              work.code = 'CLEANUP_UNKNOWN';
            }
          }
        }
      }
    });
    work.task = task;
    void task.then(() => { if (work.task === task) work.task = undefined; });
  }
  async #deleteFencedCredential(work: Work): Promise<void> {
    const old = epoch(work.board);
    if ((!old && !work.selectionWriteEpoch) || !this.#config) return;
    let current: Initialized;
    try { current = saved(this.#board); } catch { return; }
    if (!sameTarget(current, work.board) || epoch(current) === old || !hasGithub(current.snapshot) ||
        current.snapshot.github.selection === 'selected') return;
    const target = this.#target(work.board);
    const vault = await this.#vault(target);
    const bytes = await vault.read();
    if (!bytes) return;
    const stored = credential(bytes, target, this.#config.clientId).connectionEpoch;
    if (stored !== old && stored !== work.selectionWriteEpoch) return;
    const rechecked = saved(this.#board);
    if (!sameTarget(rechecked, current) || epoch(rechecked) !== epoch(current)) return;
    await vault.remove();
  }
  #recordAttempt(work: Work, outcome: 'failed' | 'cancelled', code: GithubCode): void {
    if (this.#current !== work || !hasGithub(work.board.snapshot)) return;
    const state = work.board.snapshot.github;
    if (state.selection !== 'selected' || !state.repository) return;
    try {
      const from = this.#guard(work);
      work.board = transition(this.#board, from, { type: 'record-attempt', connectionEpoch: state.connectionEpoch,
        repositoryId: state.repository.id, attempt: { at: this.#time(), outcome, code } });
    } catch { /* A changed or uncertain board cannot receive this metadata. */ }
  }
  async #send(ctx: Context, url: URL, token?: string, form?: URLSearchParams, page = false,
    publication?: PublicationWire | 'readback'): Promise<Reply> {
    const { operation, budget } = ctx;
    this.#guard(operation);
    if (publication && operation.sendingClosed) refuse('OPERATION_CANCELLED');
    const mutation = publication && publication !== 'readback' ? publication : undefined;
    if (mutation && budget.requests > 18) refuse('OPERATION_LIMIT');
    if (mutation && (!token || form || url.search ||
        !(mutation.method === 'POST'
          ? /^\/repos\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+\/issues$/
          : /^\/repos\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+\/issues\/[1-9][0-9]*$/).test(url.pathname))) refuse('DESTINATION_MISMATCH');
    if (!ctx.deviceFlow && form === undefined && !/^\/(?:user(?:\/installations(?:\/[1-9][0-9]*\/repositories)?)?|repositories\/[1-9][0-9]*|repos\/[A-Za-z0-9-]{1,100}\/[A-Za-z0-9_.-]{1,100}(?:\/(?:issues(?:\/[1-9][0-9]*)?|pulls(?:\/[1-9][0-9]*\/reviews)?|actions\/runs|releases))?)$/.test(url.pathname)) refuse('DESTINATION_MISMATCH');
    const remaining = Math.min(budget.until, operation.authUntil) - this.#now();
    if (remaining <= 0 || (!ctx.deviceFlow && budget.requests >= 20) || (page && budget.pages >= 10) || budget.bytes >= 8 * 1024 * 1024) refuse('OPERATION_LIMIT');
    const authRequest = form !== undefined;
    if (url.username || url.password || url.hash || url.protocol !== 'https:' ||
        (authRequest ? (url.origin !== auth || !['/login/device/code', '/login/oauth/access_token'].includes(url.pathname) || url.search !== '')
          : url.origin !== api)) refuse('DESTINATION_MISMATCH');
    const cap = Math.min(authRequest ? 16 * 1024 : 2 * 1024 * 1024, 8 * 1024 * 1024 - budget.bytes);
    budget.requests++;
    if (page) budget.pages++;
    const timeout = AbortSignal.timeout(Math.max(1, Math.min(10_000, remaining)));
    const signal = AbortSignal.any([operation.controller.signal, timeout]);
    const headers: Record<string, string> = { Accept: 'application/json', 'Accept-Encoding': 'identity', 'User-Agent': 'KitFlint-Glance' };
    if (token) headers.Authorization = 'Bearer ' + token;
    if (!authRequest) {
      headers.Accept = 'application/vnd.github+json';
      headers['X-GitHub-Api-Version'] = apiVersion;
    }
    if (form) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    if (mutation) headers['Content-Type'] = 'application/json';
    let reply: Reply;
    try {
      signal.throwIfAborted();
      mutation?.entered();
      reply = await this.#request({ url, method: mutation?.method ?? (form ? 'POST' : 'GET'), headers,
        body: mutation?.body ?? form?.toString(), cap, signal, ...(mutation ? { observedStatus: mutation.observed } : {}) });
      mutation?.observed(reply.status);
    }
    catch (error) {
      if (operation.controller.signal.aborted) throw operation.controller.signal.reason;
      if (timeout.aborted) refuse(remaining <= 10_000 ? 'OPERATION_LIMIT' : 'REQUEST_TIMEOUT');
      throw error instanceof GithubError ? error : new GithubError('NETWORK_FAILED');
    }
    if (!publication) this.#guard(operation);
    if (timeout.aborted && !publication) refuse(remaining <= 10_000 ? 'OPERATION_LIMIT' : 'REQUEST_TIMEOUT');
    if (!publication && this.#now() >= Math.min(budget.until, operation.authUntil)) refuse('OPERATION_LIMIT');
    const encoding = reply.headers['content-encoding'];
    if (encoding !== undefined && encoding !== 'identity') refuse('RESPONSE_INVALID');
    if (!Buffer.isBuffer(reply.body) || reply.body.length > cap) refuse('RESPONSE_LIMIT');
    budget.bytes += reply.body.length;
    const retry = reply.headers['retry-after'];
    const reset = reply.headers['x-ratelimit-reset'];
    if (reply.status === 429 || (reply.status === 403 && (retry !== undefined || reply.headers['x-ratelimit-remaining'] === '0'))) {
      let timestamp = typeof retry === 'string' && /^\d{1,9}$/.test(retry) ? this.#now() + Number(retry) * 1000 :
        typeof retry === 'string' ? Date.parse(retry) : NaN;
      if (!Number.isFinite(timestamp) && typeof reset === 'string' && /^\d{1,12}$/.test(reset)) timestamp = Number(reset) * 1000;
      throw new GithubError('RATE_LIMITED', Number.isFinite(timestamp) && timestamp >= this.#now() && timestamp < 253402300799999
        ? new Date(timestamp).toISOString() : undefined);
    }
    return reply;
  }
  #apiResult(reply: Reply, missing: GithubCode = 'REPOSITORY_UNAVAILABLE'): unknown {
    if (reply.status === 401) refuse('CONNECTION_REQUIRED');
    if (reply.status === 403) refuse('PERMISSION_REQUIRED');
    if (reply.status === 404) refuse(missing);
    if (reply.status !== 200) refuse(reply.status >= 500 ? 'NETWORK_FAILED' : 'RESPONSE_INVALID');
    return parseJson(reply);
  }
  async #page(ctx: Context, path: string, page: number, token: string, state = false): Promise<{ data: unknown; next: number | null }> {
    const url = pageUrl(path, page, state);
    const reply = await this.#send(ctx, url, token, undefined, true);
    return { data: this.#apiResult(reply, path === '/user/installations' ? 'INSTALLATION_REQUIRED' : 'REPOSITORY_UNAVAILABLE'),
      next: nextPage(reply.headers.link, url) };
  }
  async #discover(ctx: Context, kind: 'installations' | 'repositories', page: number, installationId?: string): Promise<void> {
    const work = ctx.operation, token = work.pair!.accessToken;
    work.state = 'discovering';
    const path = kind === 'installations' ? '/user/installations' : '/user/installations/' + installationId + '/repositories';
    const result = await this.#page(ctx, path, page, token);
    const raw = plain(result.data);
    if (kind === 'installations') {
      const entries = list(raw.installations, 10).map(installation);
      if (new Set(entries.map((item) => item.id)).size !== entries.length) refuse('RESPONSE_INVALID');
      work.installations = entries;
      work.installationPages = new Map(entries.map((item) => [item.id, page]));
      work.repositories = [];
      work.code = entries.length ? null : 'INSTALLATION_REQUIRED';
    } else {
      const entries = list(raw.repositories, 10).map(repository);
      if (new Set(entries.map((item) => item.id)).size !== entries.length) refuse('RESPONSE_INVALID');
      work.repositories = entries;
      work.code = entries.length ? null : 'REPOSITORY_UNAVAILABLE';
    }
    work.discovery = { kind, ...(installationId ? { installationId } : {}), page, moreAvailable: result.next !== null };
    work.nextAllowedAt = undefined;
    work.state = 'choosing-repository';
  }
  async #locate<T extends { id: string }>(ctx: Context, path: string, key: string, hint: number, id: string, token: string,
    parse: (value: unknown) => T, missing: GithubCode): Promise<T> {
    const pages = new Map<number, { items: T[]; next: number | null }>();
    const fetchPage = async (page: number) => {
      const saved = pages.get(page);
      if (saved) return saved;
      const raw = await this.#page(ctx, path, page, token);
      const items = list(plain(raw.data)[key], 10).map(parse);
      if (new Set(items.map((item) => item.id)).size !== items.length) refuse('RESPONSE_INVALID');
      const fetched = { items, next: raw.next };
      pages.set(page, fetched);
      return fetched;
    };
    const hit = (await fetchPage(hint)).items.find((item) => item.id === id);
    if (hit) return hit;
    let page: number | null = 1;
    while (page !== null) {
      const fetched = await fetchPage(page);
      const match = fetched.items.find((item) => item.id === id);
      if (match) return match;
      page = fetched.next;
    }
    return refuse(missing);
  }
  async #verifyRepository(ctx: Context, token: string, id: string, installationId: string, installationPage: number,
    repoPage: number, kind?: GithubKind, publishing = false): Promise<Repo> {
    const selectedInstallation = await this.#locate(ctx, '/user/installations', 'installations', installationPage,
      installationId, token, installation, 'INSTALLATION_REQUIRED');
    const app = selectedInstallation.permissions;
    if (!grantRead(app.metadata) || (kind && !grantRead(app[requiredGrant[kind]]))) refuse('PERMISSION_REQUIRED');
    const membership = await this.#locate(ctx, '/user/installations/' + installationId + '/repositories', 'repositories',
      repoPage, id, token, (item) => ({ ...repository(item), user: userPermissions(plain(item).permissions) }), 'REPOSITORY_UNAVAILABLE');
    if (membership.user.pull !== true || (publishing && (app.issues !== 'write' || membership.user.push !== true))) refuse('PERMISSION_REQUIRED');
    let reply = await this.#send(ctx, new URL(api + '/repositories/' + id), token);
    if (reply.status === 301 || reply.status === 302 || reply.status === 307 || reply.status === 308) {
      let next: URL;
      try { next = new URL(string(reply.headers.location, /^https:\/\/api\.github\.com\/[^\s]+$/)); }
      catch { return refuse('DESTINATION_MISMATCH'); }
      const segments = next.pathname.split('/');
      const validRepo = segments.length === 4 && segments[1] === 'repos' && ownerPattern.test(segments[2]) &&
        repoPattern.test(segments[3]) && segments[3] !== '.' && segments[3] !== '..';
      if (next.origin !== api || next.username || next.password || next.hash || next.search ||
          (next.pathname !== '/repositories/' + id && !validRepo)) refuse('DESTINATION_MISMATCH');
      reply = await this.#send(ctx, next, token);
    }
    const confirmed = repository(this.#apiResult(reply));
    if (confirmed.id !== id) refuse('DESTINATION_MISMATCH');
    ctx.operation.capabilities = { checkedAt: this.#time(), installationId, repositoryId: id, app, user: membership.user, state: 'verified' };
    return confirmed;
  }


  overview(session: string, input: unknown) {
    exact(input, []);
    const current = saved(this.#board);
    const operation = this.#current;
    if (operation?.publication && operation.publication.kind !== 'publishing') this.invalidatePublicationVersion();
    const visible = operation && operation.session === session && (!this.#terminal(operation) || this.#now() < operation.expires);
    return {
      ...githubOverview(current, this.#config),
      credentialState: this.#credentialState === 'active-for-this-process' && this.#credentialEpoch !== epoch(current)
        ? 'reconnect-required' : this.#credentialState,
      operation: visible ? operationStatus(operation) : null,
    };
  }
  start(session: string, input: unknown) {
    const config = this.#configRequired();
    this.#allowNew();
    const current = checked(this.#board, input).board;
    const prepared = transition(this.#board, current, { type: 'prepare' });
    const work = this.#newWork(session, prepared, 'starting');
    this.#current = work;
    work.authUntil = this.#now() + 16 * minutes;
    this.#monitor(work, true);
    this.#run(work, async () => {
      const target = this.#target(work.board);
      work.owner = await this.#acquire(target);
      this.#guard(work);
      const vault = await this.#vault(target);
      const existing = await vault.read();
      this.#guard(work);
      if (existing) {
        const entry = credential(existing, target, config.clientId);
        const current = githubState(work.board);
        if (current.selection !== 'selected' && entry.connectionEpoch !== current.connectionEpoch) {
          this.#guard(work);
          await vault.remove();
          this.#guard(work);
        }
      }
      const ctx: Context = { operation: work, deviceFlow: true, budget: { requests: 0, pages: 0, bytes: 0, until: work.authUntil } };
      const first = await this.#send(ctx, new URL(auth + '/login/device/code'), undefined,
        new URLSearchParams({ client_id: config.clientId, scope: 'offline_access' }));
      if (first.status !== 200) refuse('AUTH_DENIED');
      const device = plain(parseJson(first));
      const deviceCode = string(device.device_code, /^[\x21-\x7e]{1,512}$/);
      const userCode = string(device.user_code, /^[A-Za-z0-9-]{1,32}$/);
      if (device.verification_uri !== deviceUrl) refuse('RESPONSE_INVALID');
      work.authUntil = Math.min(work.authUntil, this.#now() + integer(device.expires_in, 86_400) * 1000);
      work.device = { userCode, verificationUri: deviceUrl, expiresAt: new Date(work.authUntil).toISOString() };
      work.state = 'awaiting-code';
      let interval = Math.max(5, device.interval === undefined ? 5 : integer(device.interval, 900)) * 1000;
      while (true) {
        const remaining = work.authUntil - this.#now();
        if (remaining <= 0) refuse('AUTH_EXPIRED');
        await this.#wait(Math.min(interval, remaining), work.controller.signal);
        if (this.#now() >= work.authUntil) refuse('AUTH_EXPIRED');
        const reply = await this.#send(ctx, new URL(auth + '/login/oauth/access_token'), undefined,
          new URLSearchParams({ client_id: config.clientId, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }));
        const result = plain(parseJson(reply));
        if (result.error === 'authorization_pending') continue;
        if (result.error === 'slow_down') { interval += 5000; continue; }
        if (result.error === 'expired_token') refuse('AUTH_EXPIRED');
        if (result.error === 'access_denied') refuse('AUTH_DENIED');
        if (result.error !== undefined || reply.status !== 200) refuse('AUTH_DENIED');
        work.pair = tokenPair(result, this.#now());
        break;
      }
      work.device = null;
      work.authUntil = Math.min(this.#now() + previewLifetime, Date.parse(work.pair.accessExpiresAt));
      const discoverCtx = { operation: work, budget: this.#budget() };
      const user = await this.#send(discoverCtx, new URL(api + '/user'), work.pair.accessToken);
      work.userId = providerId(plain(this.#apiResult(user)).id);
      try { await this.#discover(discoverCtx, 'installations', 1); }
      catch (error) {
        if (work.controller.signal.aborted) throw error;
        work.code = error instanceof GithubError ? error.code : 'NETWORK_FAILED';
        work.nextAllowedAt = error instanceof GithubError ? error.nextAllowedAt : undefined;
        work.state = 'choosing-repository';
      }
    });
    return { operationId: work.id, state: work.state };
  }
  status(session: string, input: unknown): ReplyStatus {
    const work = this.#visible(session, input);
    if (work.publication && work.publication.kind !== 'publishing') this.invalidatePublicationVersion();
    if (work.localDisconnected) this.#scheduleCleanup(work);
    else {
      work.lastHeartbeat = this.#now();
      if (work.state === 'choosing-repository' && this.#now() >= work.authUntil && !work.task) {
        work.state = 'stopping';
        this.#run(work, async () => { throw new GithubError('AUTH_EXPIRED'); });
      }
    }
    return operationStatus(work);
  }
  cancel(session: string, input: unknown): ReplyStatus {
    const work = this.#visible(session, input);
    work.sendingClosed = true;
    if (work.publication?.kind !== 'publishing') work.publication = undefined;
    if (work.localDisconnected || this.#terminal(work)) return operationStatus(work);
    const code = work.refresh ? 'OPERATION_CANCELLED' : 'AUTH_CANCELLED';
    if (work.refresh) this.#recordAttempt(work, 'cancelled', code);
    work.cancelled = true;
    work.preview = null;
    work.capabilities = null;
    work.device = null;
    work.state = 'stopping';
    work.controller.abort(new GithubError(code));
    if (!work.task) this.#run(work, async () => { throw new GithubError(code); });
    return operationStatus(work);
  }
  discover(session: string, input: unknown) {
    this.#configRequired();
    const row = exact(input, ['operationId', 'scope']);
    const work = this.#visible(session, { operationId: row.operationId });
    if (work.task) refuse('CONNECTION_BUSY');
    if (work.state !== 'choosing-repository' || !work.pair || this.#now() >= work.authUntil) refuse('AUTH_EXPIRED');
    const candidate = plain(row.scope, malformed);
    const kind = string(candidate.kind, /^(?:installations|repositories)$/, malformed) as Page['kind'];
    const query = exact(candidate, ['kind', 'page', ...(kind === 'repositories' ? ['installationId'] : [])]);
    const page = integer(query.page, 1000, 1, malformed);
    const installationId = kind === 'repositories' ? localId(query.installationId) : undefined;
    if (installationId && !work.installationPages.has(installationId)) refuse('INSTALLATION_REQUIRED');
    this.#guard(work);
    work.lastHeartbeat = this.#now();
    work.state = 'discovering';
    this.#run(work, () => this.#discover({ operation: work, budget: this.#budget() }, kind, page, installationId), true);
    return { operationId: work.id, state: work.state };
  }
  select(session: string, input: unknown) {
    const config = this.#configRequired();
    const { board, input: row } = checked(this.#board, input, ['operationId', 'repositoryId']);
    const work = this.#visible(session, { operationId: row.operationId });
    const id = localId(row.repositoryId);
    if (work.task) refuse('CONNECTION_BUSY');
    if (work.state !== 'choosing-repository' || !work.pair || !work.userId || this.#now() >= work.authUntil) refuse('AUTH_EXPIRED');
    const installationId = work.discovery?.installationId;
    const installationPage = installationId ? work.installationPages.get(installationId) : undefined;
    if (!installationId || !installationPage || !work.discovery || !work.repositories.some((r) => r.id === id)) refuse('REPOSITORY_UNAVAILABLE');
    const repoPage = work.discovery.page;
    if (githubState(board).repository && githubState(board).repository!.id !== id) refuse('DESTINATION_MISMATCH');
    this.#guard(work);
    work.lastHeartbeat = this.#now();
    work.state = 'selecting';
    this.#run(work, async () => {
      const pair = work.pair!;
      const confirmed = await this.#verifyRepository({ operation: work, budget: this.#budget() }, pair.accessToken, id, installationId,
        installationPage, repoPage);
      const target = this.#target(work.board);
      const vault = await this.#vault(target);
      const connectionEpoch = randomUUID();
      const entry: Credential = { ...pair, ...target, version: 1, clientId: config.clientId, authenticatedUserId: work.userId!,
        connectionEpoch, state: 'pending-selection' };
      const previous = await vault.read();
      if (previous) credential(previous, target, config.clientId);
      this.#guard(work);
      this.#credentialState = 'reconnect-required';
      try {
        work.selectionWriteEpoch = connectionEpoch;
        await vault.write(encodeCredential(entry));
        const current = this.#guard(work);
        work.board = transition(this.#board, current, { type: 'select', connectionEpoch,
          repository: { ...confirmed, installationId, installationPageHint: installationPage, repositoryPageHint: repoPage,
            selectedAt: this.#time(), selectedByHuman: true } });
        this.#guard(work);
        await vault.write(encodeCredential({ ...entry, state: 'active' }));
        this.#guard(work);
      } catch (error) {
        if (error instanceof BoardRefusal || work.controller.signal.aborted) throw error;
        refuse('CREDENTIAL_ROTATION_UNCERTAIN');
      }
      this.#credentialState = 'active-for-this-process';
      this.#credentialEpoch = connectionEpoch;
      work.code = null;
      work.state = 'succeeded';
      work.expires = this.#now() + previewLifetime;
    });
    return { operationId: work.id, state: work.state };
  }
  async #active(ctx: Context, config: GithubAppConfig): Promise<Credential> {
    const work = ctx.operation, target = this.#target(work.board);
    work.owner = await this.#acquire(target);
    this.#guard(work);
    const vault = await this.#vault(target);
    const bytes = await vault.read();
    this.#guard(work);
    if (!bytes) refuse('CONNECTION_REQUIRED');
    let entry = credential(bytes, target, config.clientId);
    if (entry.state !== 'active' || entry.connectionEpoch !== epoch(work.board)) refuse('CONNECTION_REQUIRED');
    if (Date.parse(entry.accessExpiresAt) <= this.#now()) {
      if (Date.parse(entry.refreshExpiresAt) <= this.#now()) refuse('AUTH_EXPIRED');
      this.#credentialState = 'reconnect-required';
      try {
        this.#guard(work);
        await vault.write(encodeCredential({ ...entry, state: 'rotation-pending' }));
        const result = await this.#send(ctx, new URL(auth + '/login/oauth/access_token'), undefined,
          new URLSearchParams({ client_id: config.clientId, grant_type: 'refresh_token', refresh_token: entry.refreshToken }));
        if (result.status !== 200) refuse('CREDENTIAL_ROTATION_UNCERTAIN');
        entry = { ...entry, ...tokenPair(parseJson(result), this.#now()) };
        this.#guard(work);
        await vault.write(encodeCredential(entry));
        this.#guard(work);
      } catch {
        if (work.controller.signal.aborted) throw work.controller.signal.reason;
        refuse('CREDENTIAL_ROTATION_UNCERTAIN');
      }
    }
    this.#credentialState = 'active-for-this-process';
    this.#credentialEpoch = entry.connectionEpoch;
    return entry;
  }
  refresh(session: string, input: unknown) {
    const config = this.#configRequired();
    this.#allowNew();
    const { board, input: row } = checked(this.#board, input, ['scope']);
    const query = scope(row.scope), state = githubState(board), chosen = state.repository;
    if (state.selection !== 'selected' || !chosen) refuse('CONNECTION_REQUIRED');
    const mapped = query.linkedTaskIds.map((id) => {
      const mapping = state.issues.find((m) => m.localTaskId === id);
      if (!mapping) malformed();
      return mapping;
    });
    const pr = query.pullRequestId === null ? undefined : state.facts.find((f) => f.kind === 'pull-request' && f.id === query.pullRequestId);
    if (query.pullRequestId !== null && (!pr || pr.kind !== 'pull-request')) malformed();
    const parent = pr?.kind === 'pull-request' ? { id: pr.id, number: pr.number } : undefined;
    const work = this.#newWork(session, board, 'refreshing');
    work.refresh = true;
    this.#current = work;
    this.#monitor(work, false);
    this.#run(work, async () => {
      const ctx = { operation: work, budget: this.#budget() };
      const entry = await this.#active(ctx, config);
      const repo = await this.#verifyRepository(ctx, entry.accessToken, chosen.id, chosen.installationId,
        chosen.installationPageHint, chosen.repositoryPageHint, query.kind);
      const repoPath = '/repos/' + encodeURIComponent(repo.owner) + '/' + encodeURIComponent(repo.name);
      const kind = query.kind;
      const path = repoPath + (kind === 'pull-request-reviews' ? '/pulls/' + parent!.number + '/reviews' : kindToPath[kind]);
      const observedAt = this.#time();
      const issues: PreviewIssue[] = [], facts: GithubFact[] = [];
      let next: number | null = query.page, pagesFetched = 0;
      while (next !== null && pagesFetched < query.pages) {
        const page = await this.#page(ctx, path, next, entry.accessToken, query.kind === 'issues' || query.kind === 'pull-requests');
        const rows = list(query.kind === 'workflow-runs' ? plain(page.data).workflow_runs : page.data, 10);
        for (const item of rows) {
          if (query.kind === 'issues') {
            const value = issueRecord(item, observedAt);
            if (value) issues.push(value);
          } else facts.push(factRecord(item, query.kind, repo.id, observedAt, parent));
        }
        pagesFetched++;
        next = page.next;
      }
      if (new Set(issues.map((i) => i.issueId)).size !== issues.length || Buffer.byteLength(JSON.stringify(issues)) > 1024 * 1024) refuse('RESPONSE_LIMIT');
      const linked = [];
      for (const mapping of mapped) {
        const reply = await this.#send(ctx, new URL(api + repoPath + '/issues/' + mapping.number), entry.accessToken);
        if (reply.status === 404) linked.push({ issueId: mapping.issueId, number: mapping.number, unavailable: true });
        else {
          const value = issueRecord(this.#apiResult(reply), observedAt);
          if (!value || value.issueId !== mapping.issueId || value.number !== mapping.number) refuse('DESTINATION_MISMATCH');
          if ('ineligible' in value) refuse('RESPONSE_LIMIT');
          linked.push({ issueId: value.issueId, number: value.number, remoteUpdatedAt: value.remoteUpdatedAt, values: value.values });
        }
      }
      const collection: GithubCollection = { kind: query.kind, pullRequestId: query.pullRequestId, page: query.page, pagesFetched,
        count: query.kind === 'issues' ? issues.length : facts.length, observedAt, completeness: next === null ? 'complete-for-scope' : 'partial' };
      const operation = { type: 'refresh', connectionEpoch: state.connectionEpoch, repositoryId: repo.id, issues: linked, facts, collection,
        attempt: { at: observedAt, outcome: next === null ? 'success' : 'partial', code: null } };
      work.board = transition(this.#board, this.#guard(work), operation);
      work.expires = this.#now() + previewLifetime;
      work.preview = { version: work.board.version, expiresAt: new Date(work.expires).toISOString(), issues, facts, collection };
      work.state = 'succeeded';
    });
    return { operationId: work.id, state: work.state };
  }
  importIssues(session: string, input: unknown): Changed {
    const { board, input: row } = checked(this.#board, input, ['operationId', 'issueIds']);
    const work = this.#visible(session, { operationId: row.operationId });
    const preview = work.preview;
    if (work.task || work.state !== 'succeeded' || !preview || preview.version !== board.version ||
        !sameTarget(board, work.board) || epoch(board) !== epoch(work.board)) refuse('PREVIEW_EXPIRED');
    const state = githubState(board);
    if (!state.repository || state.selection !== 'selected') refuse('CONNECTION_REQUIRED');
    if (!Array.isArray(row.issueIds) || !row.issueIds.length || row.issueIds.length > 10) malformed();
    const ids = row.issueIds.map((key) => localId(key));
    if (new Set(ids).size !== ids.length) malformed();
    const issues = ids.map((id) => {
      const issue = preview.issues.find((entry) => entry.issueId === id);
      if (!issue || 'ineligible' in issue) refuse('PREVIEW_EXPIRED');
      return issue;
    });
    const result = transition(this.#board, board, { type: 'import', connectionEpoch: state.connectionEpoch, repositoryId: state.repository.id, issues });
    work.board = result;
    work.preview = { ...preview, version: result.version, issues: preview.issues.filter((issue) => !ids.includes(issue.issueId)) };
    return result;
  }
  #local(input: unknown, type: string, keys: string[]): Changed {
    if (this.#closed) refuse('OPERATION_CANCELLED');
    const { board, input: row } = checked(this.#board, input, keys);
    const result = transition(this.#board, board, { type, ...Object.fromEntries(keys.map((key) => [key, row[key]])) });
    if (result.committed) this.invalidatePublicationVersion();
    return result;
  }
  resolve(_session: string, input: unknown) {
    return this.#local(input, 'resolve', ['taskId', 'field', 'choice', 'remoteUpdatedAt', 'observedValue']);
  }
  issueState(_session: string, input: unknown) { return this.#local(input, 'issue-state', ['taskId', 'state']); }
  unlink(_session: string, input: unknown) { return this.#local(input, 'unlink', ['taskId']); }
  clearFacts(_session: string, input: unknown) { return this.#local(input, 'clear-facts', ['kinds', 'confirmed']); }
  disconnect(session: string, input: unknown) {
    if (this.#closed) refuse('OPERATION_CANCELLED');
    const { board } = checked(this.#board, input);
    const state = githubState(board);
    const old = this.#current;
    if (old?.localDisconnected && old.session === session && epoch(old.board) === epoch(board)) {
      this.#scheduleCleanup(old);
      return { operationId: old.id, state: old.state, localDisconnected: true, cleanup: old.cleanup };
    }
    if (old?.localDisconnected && !this.#terminal(old)) refuse('CONNECTION_BUSY');
    const fenced = transition(this.#board, board, { type: 'disconnect' });
    const cleanup = this.#newWork(session, fenced, 'stopping');
    cleanup.localDisconnected = true;
    cleanup.cleanupEpochs = new Set(state.selection === 'selected' ? [state.connectionEpoch] : []);
    cleanup.cleanup = old?.task && old.owner ? 'unknown' : 'pending';
    this.#current = cleanup;
    this.#credentialState = 'reconnect-required';
    this.#credentialEpoch = null;
    if (old && !old.localDisconnected) {
      old.sendingClosed = true;
      if (old.selectionWriteEpoch && sameTarget(old.board, board)) cleanup.cleanupEpochs.add(old.selectionWriteEpoch);
      cleanup.prior = old;
      old.preview = null;
      old.device = null;
      old.controller.abort(new GithubError('OPERATION_CANCELLED'));
      if (old.owner && !old.task) this.#run(old, async () => { throw new GithubError('OPERATION_CANCELLED'); });
      cleanup.oldWork = old.task;
    }
    this.#scheduleCleanup(cleanup);
    return { operationId: cleanup.id, state: cleanup.state, localDisconnected: true, cleanup: cleanup.cleanup };
  }
  #scheduleCleanup(work: Work): void {
    if (work.task || work.owner || this.#terminal(work)) return;
    const task = Promise.resolve().then(async () => {
      await work.oldWork;
      if (work.prior?.owner) {
        work.cleanup = 'unknown'; work.code = 'CLEANUP_UNKNOWN';
        return;
      }
      const priorCleanupFailed = work.prior?.cleanup === 'unknown';
      work.prior = undefined;
      work.oldWork = undefined;
      if (priorCleanupFailed) {
        work.cleanup = 'unknown'; work.code = 'CLEANUP_UNKNOWN'; work.state = 'failed';
        work.expires = this.#now() + previewLifetime;
        return;
      }
      const epochs = work.cleanupEpochs, config = this.#config;
      if (!epochs?.size || !config) {
        work.cleanup = 'unknown'; work.code = 'CLEANUP_UNKNOWN'; work.state = 'failed';
        work.expires = this.#now() + previewLifetime;
        return;
      }
      const target = this.#target(work.board);
      try { work.owner = await this.#acquire(target); }
      catch (error) {
        if (error instanceof GithubError && error.code === 'CONNECTION_BUSY') return;
        work.cleanup = 'unknown'; work.code = 'CLEANUP_UNKNOWN'; work.state = 'failed';
        work.expires = this.#now() + previewLifetime;
        return;
      }
      let confirmed = false;
      work.cleanup = 'unknown';
      try {
        this.#sameFence(work);
        const vault = await this.#vault(target);
        const bytes = await vault.read();
        this.#sameFence(work);
        if (bytes) {
          const entry = credential(bytes, target, config.clientId);
          if (!epochs.has(entry.connectionEpoch)) refuse('CREDENTIAL_MISMATCH');
          await vault.remove();
        }
        confirmed = true;
      } catch { /* Only exact deletion or confirmed absence qualifies. */ }
      try { await work.owner.close(); work.owner = undefined; }
      catch { confirmed = false; }
      work.cleanup = confirmed ? 'complete' : 'unknown';
      work.code = confirmed ? null : 'CLEANUP_UNKNOWN';
      work.state = confirmed ? 'succeeded' : work.owner ? 'stopping' : 'failed';
      work.expires = this.#now() + previewLifetime;
    });
    work.task = task;
    void task.then(() => { if (work.task === task) work.task = undefined; });
  }

  #publicationInput(input: unknown, keys: string[]): { board: Initialized; row: RecordInput } {
    if (this.#closed) refuse('OPERATION_CANCELLED');
    const row = exact(input, ['expectedVersion', ...keys]);
    const current = saved(this.#board);
    const { board } = checked(this.#board, { boardId: current.snapshot.boardId, expectedVersion: row.expectedVersion });
    return { board, row };
  }
  #publicationCommit(board: Initialized, operation: object): Changed {
    const result = this.#board.publication({ boardId: board.snapshot.boardId, expectedVersion: board.version, operation });
    if ('error' in result) throw new BoardRefusal(result);
    return result;
  }
  #recordingFailure(work: Work, error: unknown): void {
    if (!(error instanceof BoardRefusal)) return;
    work.boardFailure = error.failure.error;
    if (['IO_OUTCOME_UNKNOWN', 'RECOVERY_REQUIRED', 'CLOSED'].includes(error.failure.error.code)) work.publicationRecordingClosed = true;
  }
  #publicationWork(session: string, board: Initialized) {
    const work = this.#newWork(session, board, 'refreshing');
    work.sendingClosed = false;
    this.#current = work;
    this.#monitor(work, false);
    return work;
  }
  #selectedRepository(board: Initialized): GithubRepository {
    const state = githubState(board);
    if (state.selection !== 'selected' || !state.repository) refuse('CONNECTION_REQUIRED');
    return state.repository;
  }
  async #publicationRepository(ctx: Context, token: string, repo: GithubRepository, writing: boolean) {
    const verified = await this.#verifyRepository(ctx, token, repo.id, repo.installationId, repo.installationPageHint,
      repo.repositoryPageHint, 'issues', writing);
    if (verified.id !== repo.id || verified.owner !== repo.owner || verified.name !== repo.name || verified.visibility !== repo.visibility) {
      refuse('DESTINATION_MISMATCH');
    }
    return new URL(api + '/repos/' + encodeURIComponent(repo.owner) + '/' + encodeURIComponent(repo.name) + '/issues');
  }
  async #publicationIssue(ctx: Context, url: URL, token: string, number: number, id?: string, readback = false): Promise<Issue> {
    const reply = await this.#send(ctx, new URL(url.href + '/' + number), token, undefined, false, readback ? 'readback' : undefined);
    const issue = this.#completeIssue(this.#apiResult(reply));
    if (issue.number !== number || (id && issue.issueId !== id)) refuse('DESTINATION_MISMATCH');
    return issue;
  }
  #completeIssue(value: unknown): Issue {
    const row = plain(value);
    if (!Object.hasOwn(row, 'body')) refuse('RESPONSE_INVALID');
    const issue = issueRecord(row, this.#time());
    if (!issue || 'ineligible' in issue) refuse('RESPONSE_INVALID');
    return issue;
  }
  #activePreview(session: string, operationId: unknown, board: Initialized) {
    const work = this.#visible(session, { operationId });
    if (work.task || work.state !== 'succeeded' || !work.publication || work.publication.kind === 'publishing' ||
        work.publication.version !== board.version || !sameTarget(work.board, board) || epoch(work.board) !== epoch(board) ||
        Date.parse(work.publication.expiresAt) <= this.#now() || work.sendingClosed) refuse('PREVIEW_EXPIRED');
    return { work, preview: work.publication };
  }
  #publicationRefusal(message: string): never {
    throw new BoardRefusal({ error: { code: 'INVALID_INPUT', message } });
  }

  publishPreview(session: string, input: unknown) {
    const config = this.#configRequired();
    this.#allowNew();
    const { board, row } = this.#publicationInput(input, ['items']);
    const repo = this.#selectedRepository(board);
    if (!Array.isArray(row.items) || !row.items.length || row.items.length > 3) malformed();
    const batchId = randomUUID();
    const seen = new Set<string>();
    const actions = row.items.map((value): ReviewAction => {
      const item = exact(value, ['taskId', 'fields']);
      const taskId = string(item.taskId, tasksPattern, malformed);
      const task = board.snapshot.tasks.find((entry) => entry.id === taskId);
      const requested = item.fields;
      if (!task || seen.has(taskId) || !Array.isArray(requested) || !requested.length || requested.length > 3) return malformed();
      seen.add(taskId);
      const keys = publicationFields.filter((key) => requested.includes(key));
      if (keys.length !== requested.length) malformed();
      const blocked = publicationRefusal(board.snapshot, taskId, repo.id, keys);
      if (blocked) this.#publicationRefusal(blocked);
      const mapping = githubState(board).issues.find((entry) => entry.localTaskId === taskId);
      if (!mapping && (!keys.includes('title') || keys.includes('state'))) malformed();
      const proposed = publicationValues({ title: task.title, body: task.description, state: mapping?.localIssueState ?? 'open' }, keys);
      const before = mapping ? publicationValues(mapping.remote, keys) : null;
      if (before && keys.some((key) => before[key] === proposed[key])) this.#publicationRefusal('Select only fields that differ from GitHub.');
      return { baseline: mapping ? structuredClone(mapping.remote) : null, intent: {
        id: randomUUID(), batchId, origin: { boardId: board.snapshot.boardId, generation: board.snapshot.generation,
          revision: board.snapshot.revision, connectionEpoch: githubState(board).connectionEpoch, taskId },
        repository: publicationDestination(repo), action: mapping ? 'update' : 'create',
        issue: mapping ? { id: mapping.issueId, number: mapping.number } : null,
        fields: keys, before, proposed, preparedAt: this.#time(),
      } };
    });
    const work = this.#publicationWork(session, board);
    this.#run(work, async () => {
      const ctx = { operation: work, budget: this.#budget() };
      const entry = await this.#active(ctx, config);
      const url = await this.#publicationRepository(ctx, entry.accessToken, repo, true);
      for (const action of actions) {
        const identity = action.intent.issue;
        if (identity) {
          const actual = await this.#publicationIssue(ctx, url, entry.accessToken, identity.number, identity.id);
          if (JSON.stringify(actual.values) !== JSON.stringify(action.baseline)) {
            this.#publicationRefusal('GitHub changed. Refresh or resolve the saved comparison before publishing.');
          }
        }
      }
      this.#guard(work);
      work.expires = this.#now() + previewLifetime;
      work.publication = { kind: 'publish-preview', version: board.version, expiresAt: new Date(work.expires).toISOString(), actions };
      work.state = 'succeeded';
    });
    return { operationId: work.id, state: work.state };
  }
  publishConfirm(session: string, input: unknown) {
    const config = this.#configRequired();
    const object = plain(input, malformed);
    const attested = Object.hasOwn(object, 'existingIssuesChecked');
    const { board, row } = this.#publicationInput(input, ['operationId', 'confirmed', ...(attested ? ['existingIssuesChecked'] : [])]);
    if (row.confirmed !== true || (attested && row.existingIssuesChecked !== true)) malformed();
    const { work, preview } = this.#activePreview(session, row.operationId, board);
    if (preview.kind !== 'publish-preview') refuse('PREVIEW_EXPIRED');
    const hasCreate = preview.actions.some(({ intent }) => intent.action === 'create');
    if (attested !== hasCreate) malformed();
    const repo = this.#selectedRepository(board);
    const reviewed = preview.actions;
    const publication: PublicationWork & { kind: 'publishing' } = { kind: 'publishing', expiresAt: preview.expiresAt, results: [] };
    work.publication = publication;
    work.state = 'refreshing';
    work.lastHeartbeat = this.#now();
    work.authUntil = Date.parse(preview.expiresAt);
    this.#monitor(work, false);
    this.#run(work, async () => {
      const ctx = { operation: work, budget: this.#budget() };
      work.publicationDeadline = ctx.budget.until;
      let entry: Credential;
      let prepared: Changed;
      try {
        entry = await this.#active(ctx, config);
        await this.#publicationRepository(ctx, entry.accessToken, repo, true);
        this.#guard(work);
        prepared = this.#publicationCommit(board, { type: 'prepare-intents', intents: reviewed.map(({ intent }) => intent) });
        if (!prepared.committed) refuse('OPERATION_CANCELLED');
      } catch (error) {
        work.sendingClosed = true;
        for (const { intent } of reviewed) publication.results.push({ intentId: intent.id, taskId: intent.origin.taskId,
          outcome: this.#publicationOutcome('not-sent', 'PRE_SEND_REFUSED', null, null), recorded: false });
        throw error;
      }
      work.board = prepared;
      let lastStart: number | undefined;
      for (const action of reviewed) {
        if (work.sendingClosed) {
          const result = this.#publicationOutcome('not-sent', 'PRE_SEND_REFUSED', null, null);
          this.#settlePublication(work, action.intent, result, publication.results);
          continue;
        }
        await this.#publishOne(ctx, repo, entry.accessToken, action, publication.results, () => {
          lastStart = this.#now();
        }, lastStart);
      }
      if (work.controller.signal.aborted) work.state = 'cancelled';
      else if (publication.results.some((item) => !item.recorded || item.outcome.kind !== 'confirmed' || item.attached === false)) {
        work.state = 'failed';
      } else work.state = 'succeeded';
    });
    return { operationId: work.id, state: work.state };
  }
  #publicationOutcome(kind: PublicationOutcome['kind'], code: PublicationOutcome['code'], httpStatus: number | null,
    issue: PublicationIssue | null, observed?: Issue, fields: PublicationField[] = []): PublicationOutcome {
    return { kind, code, httpStatus, issue, at: this.#time(), remoteUpdatedAt: observed?.remoteUpdatedAt ?? null,
      observedSha256: observed ? createHash('sha256').update(JSON.stringify(publicationValues(observed.values, fields))).digest('hex') : null,
      matched: observed ? kind === 'confirmed' : null };
  }
  #publicationAuthority(work: Work): boolean {
    if (work.sendingClosed) return false;
    try { this.#guard(work); } catch { work.sendingClosed = true; }
    if (this.#now() >= Math.min(work.authUntil, work.publicationDeadline ?? Infinity)) work.sendingClosed = true;
    return !work.sendingClosed;
  }
  #settlePublication(work: Work, intent: PublicationIntent, outcome: PublicationOutcome, results: PublishResult[]) {
    const result: PublishResult = { intentId: intent.id, taskId: intent.origin.taskId, outcome, recorded: false };
    results.push(result);
    if (work.publicationRecordingClosed) return result;
    this.#publicationAuthority(work);
    if (outcome.kind !== 'confirmed') work.sendingClosed = true;
    let from: Initialized;
    try {
      from = saved(this.#board);
      if (!sameTarget(from, work.board)) { work.sendingClosed = true; return result; }
      if (from.version !== work.board.version || epoch(from) !== epoch(work.board)) work.sendingClosed = true;
      let settled: Changed;
      const operation = { type: 'settle-outcome', intentId: intent.id, outcome };
      try { settled = this.#publicationCommit(from, operation); }
      catch (error) {
        if (!(error instanceof BoardRefusal) || error.failure.error.code !== 'REVISION_CONFLICT') throw error;
        work.sendingClosed = true;
        const latest = saved(this.#board);
        if (!sameTarget(latest, from)) return result;
        settled = this.#publicationCommit(latest, operation);
      }
      result.recorded = settled.committed;
      if (!work.sendingClosed && result.recorded) work.board = settled;
    } catch (error) {
      work.sendingClosed = true;
      this.#recordingFailure(work, error);
    }
    if (!result.recorded) work.sendingClosed = true;
    return result;
  }
  async #publishOne(ctx: Context, repo: GithubRepository, token: string, action: ReviewAction, results: PublishResult[],
    started: () => void, lastStart?: number) {
    const { operation: work, budget } = ctx;
    const { intent } = action;
    let attempted = false, identity = intent.issue;
    const wire: { status: number | null; entered: boolean } = { status: null, entered: false };
    let outcome: PublicationOutcome;
    let observed: Issue | undefined;
    let reading = false;
    try {
      if (!this.#publicationAuthority(work)) refuse('OPERATION_CANCELLED');
      const url = await this.#publicationRepository(ctx, token, repo, true);
      if (identity) {
        const preflight = await this.#publicationIssue(ctx, url, token, identity.number, identity.id);
        if (JSON.stringify(preflight.values) !== JSON.stringify(action.baseline)) refuse('DESTINATION_MISMATCH');
      }
      const wait = lastStart === undefined ? 0 : Math.max(0, 1000 - (this.#now() - lastStart));
      if (budget.requests > 18 || Math.min(budget.until, work.authUntil) - this.#now() <= wait ||
          budget.bytes >= 8 * 1024 * 1024) refuse('OPERATION_LIMIT');
      if (wait) await this.#wait(wait, work.controller.signal);
      if (lastStart !== undefined && this.#now() - lastStart < 1000) refuse('OPERATION_LIMIT');
      if (!this.#publicationAuthority(work) || this.#now() >= budget.until) refuse('OPERATION_CANCELLED');
      const marked = this.#publicationCommit(work.board, { type: 'mark-attempted', intentId: intent.id, at: this.#time() });
      if (!marked.committed) refuse('OPERATION_CANCELLED');
      work.board = marked;
      attempted = true;
      const reply = await this.#send(ctx, identity ? new URL(url.href + '/' + identity.number) : url, token, undefined, false, {
        method: intent.action === 'create' ? 'POST' : 'PATCH', body: JSON.stringify(intent.proposed),
        entered: () => { wire.entered = true; started(); }, observed: (status) => { wire.status = status; },
      });
      if ([400, 401, 403, 404, 410, 422, 429].includes(reply.status)) {
        outcome = this.#publicationOutcome('rejected', reply.status === 401 ? 'AUTH_REQUIRED' : 'PROVIDER_REJECTED', reply.status, identity);
      } else {
        if (this.#now() >= budget.until && reply.status !== (intent.action === 'create' ? 201 : 200)) refuse('OPERATION_LIMIT');
        if (reply.status !== (intent.action === 'create' ? 201 : 200)) refuse('RESPONSE_INVALID');
        const response = plain(parseJson(reply));
        const returned = issueIdentity(response);
        if (!returned || (identity && !samePublicationIssue(identity, returned))) refuse('RESPONSE_INVALID');
        identity ??= returned;
        this.#completeIssue(response);
        reading = true;
        if (this.#now() >= budget.until) refuse('OPERATION_LIMIT');
        if (!this.#publicationAuthority(work)) refuse('OPERATION_CANCELLED');
        observed = await this.#publicationIssue(ctx, url, token, identity.number, identity.id, true);
        const matched = intent.fields.every((key) => observed!.values[key] === intent.proposed[key]) &&
          (intent.action === 'update' || observed.values.state === 'open');
        outcome = this.#publicationOutcome(matched ? 'confirmed' : 'conflict', matched ? 'VERIFIED' : 'READBACK_MISMATCH',
          reply.status, identity, observed, intent.fields);
      }
    } catch (error) {
      if (error instanceof BoardRefusal && error.failure.error.code === 'IO_OUTCOME_UNKNOWN') {
        work.sendingClosed = true;
        work.publicationRecordingClosed = true;
        work.boardFailure = error.failure.error;
        results.push({ intentId: intent.id, taskId: intent.origin.taskId,
          outcome: this.#publicationOutcome('not-sent', 'PRE_SEND_REFUSED', null, null), recorded: false });
        return;
      }
      const failure = error instanceof GithubError ? error : null;
      const httpStatus = wire.status;
      const rejected = attempted && wire.entered && !reading && httpStatus !== null && [400, 401, 403, 404, 410, 422, 429].includes(httpStatus);
      const rate = rejected && (httpStatus === 429 || failure?.code === 'RATE_LIMITED');
      if (rate) work.nextAllowedAt = failure?.nextAllowedAt;
      const codes: Partial<Record<GithubCode, PublicationOutcome['code']>> = {
        REQUEST_TIMEOUT: 'TIMEOUT', OPERATION_CANCELLED: 'CANCELLED', RESPONSE_INVALID: 'INVALID_RESPONSE',
        RESPONSE_LIMIT: 'RESPONSE_LIMIT', OPERATION_LIMIT: 'OPERATION_LIMIT', DESTINATION_MISMATCH: 'DESTINATION_CHANGED',
        CONNECTION_REQUIRED: 'AUTH_REQUIRED', NETWORK_FAILED: 'NETWORK_FAILED',
      };
      outcome = this.#publicationOutcome(!attempted ? 'not-sent' : rejected ? 'rejected' : 'unknown',
        rate ? 'RATE_LIMITED' : rejected ? httpStatus === 401 ? 'AUTH_REQUIRED' : 'PROVIDER_REJECTED' :
          reading ? 'READBACK_FAILED' : failure ? codes[failure.code] ?? 'PRE_SEND_REFUSED' : 'PRE_SEND_REFUSED',
        attempted ? httpStatus : null, attempted ? identity : null);
    }
    const result = this.#settlePublication(work, intent, outcome, results);
    if (intent.action === 'create' && outcome.kind === 'confirmed' && observed) {
      result.attached = false;
      if (result.recorded && this.#publicationAuthority(work)) {
        try {
          const mapped = this.#publicationCommit(work.board, { type: 'attach-created-mapping', intentId: intent.id, at: observed.fetchedAt,
            issue: identity, remote: observed.values, remoteUpdatedAt: observed.remoteUpdatedAt });
          result.attached = true;
          work.board = mapped;
        } catch (error) {
          this.#recordingFailure(work, error);
        }
      }
      if (!result.attached) work.sendingClosed = true;
    }
  }

  previewInvalidate(session: string, input: unknown): ReplyStatus {
    const work = this.#visible(session, input);
    work.sendingClosed = true;
    if (work.publication?.kind !== 'publishing') work.publication = undefined;
    if (!this.#terminal(work) && !work.localDisconnected) return this.cancel(session, input);
    return operationStatus(work);
  }
  reconcilePreview(session: string, input: unknown) {
    const config = this.#configRequired();
    this.#allowNew();
    const { board, row } = this.#publicationInput(input, ['intentId', 'issueNumber']);
    const intentId = string(row.intentId, uuidPattern, malformed);
    const issueNumber = integer(row.issueNumber, Number.MAX_SAFE_INTEGER, 1, malformed);
    const target = publicationTarget(board.snapshot, intentId);
    const repo = this.#selectedRepository(board);
    if (!target || target.repositoryId !== repo.id || (target.issue && target.issue.number !== issueNumber)) refuse('DESTINATION_MISMATCH');
    const work = this.#publicationWork(session, board);
    this.#run(work, async () => {
      const ctx = { operation: work, budget: this.#budget() };
      const entry = await this.#active(ctx, config);
      const url = await this.#publicationRepository(ctx, entry.accessToken, repo, false);
      const issue = await this.#publicationIssue(ctx, url, entry.accessToken, issueNumber, target.issue?.id);
      this.#guard(work);
      work.expires = this.#now() + previewLifetime;
      work.publication = { kind: 'reconcile-preview', version: board.version, expiresAt: new Date(work.expires).toISOString(),
        intentId, issue, repository: publicationDestination(repo), taskId: target.taskId, action: target.action,
        proposed: target.record?.intent.proposed ?? null };
      work.state = 'succeeded';
    });
    return { operationId: work.id, state: work.state };
  }
  reconcileConfirm(session: string, input: unknown): Changed {
    const { board, row } = this.#publicationInput(input, ['operationId', 'confirmed']);
    if (row.confirmed !== true) malformed();
    const { work, preview } = this.#activePreview(session, row.operationId, board);
    if (preview.kind !== 'reconcile-preview') refuse('PREVIEW_EXPIRED');
    work.publication = undefined;
    const issue = preview.issue;
    return this.#publicationCommit(board, { type: 'reconcile', intentId: preview.intentId, at: issue.fetchedAt,
      issue: { id: issue.issueId, number: issue.number }, remote: issue.values, remoteUpdatedAt: issue.remoteUpdatedAt });
  }
  publicationRetirePreview(session: string, input: unknown) {
    this.#allowNew();
    const { board, row } = this.#publicationInput(input, ['intentIds']);
    if (board.snapshot.schemaVersion !== 4 || !Array.isArray(row.intentIds) || !row.intentIds.length || row.intentIds.length > 20) malformed();
    const ids = row.intentIds.map((value) => string(value, uuidPattern, malformed));
    if (new Set(ids).size !== ids.length) malformed();
    const records = ids.map((id) => {
      const record = board.snapshot.schemaVersion === 4 ? board.snapshot.publication.records.find((item) => item.intent.id === id) : undefined;
      if (!record || !publicationRetirable(board.snapshot, record)) this.#publicationRefusal('Inspect or refresh dependent records before archiving.');
      return { intentId: id, taskId: record.associationTaskId, action: record.intent.action, state: publicationState(record) };
    });
    const backup = this.#board.exportCurrentBackup(board.version);
    if ('error' in backup) throw new BoardRefusal(backup);
    const work = this.#newWork(session, board, 'succeeded');
    this.#current = work;
    const expiresAt = new Date(work.expires).toISOString();
    work.publication = { kind: 'retire-preview', version: board.version, expiresAt, ids, backupSha256: backup.sha256,
      backupJson: backup.backupJson };
    return { ...backup, backupSha256: backup.sha256, operationId: work.id, expiresAt, records };
  }
  publicationRetireConfirm(session: string, input: unknown): Changed {
    const { board, row } = this.#publicationInput(input, ['operationId', 'backupSha256', 'backupSavedConfirmed', 'confirmed']);
    if (row.backupSavedConfirmed !== true || row.confirmed !== true) malformed();
    const { work, preview } = this.#activePreview(session, row.operationId, board);
    if (preview.kind !== 'retire-preview' || row.backupSha256 !== preview.backupSha256) refuse('PREVIEW_EXPIRED');
    if (createHash('sha256').update(preview.backupJson).digest('hex') !== preview.backupSha256) refuse('PREVIEW_EXPIRED');
    work.publication = undefined;
    return this.#publicationCommit(board, { type: 'retire', recordIds: preview.ids, backupSha256: preview.backupSha256, at: this.#time() });
  }

  close(): Promise<void> {
    if (this.#closure) return this.#closure;
    this.#closed = true;
    const work = this.#current;
    this.#closure = (async () => {
      if (!work) return;
      work.sendingClosed = true;
      if (work.publication?.kind !== 'publishing') work.publication = undefined;
      work.preview = null;
      work.device = null;
      work.capabilities = null;
      if (!work.localDisconnected) {
        work.controller.abort(new GithubError('OPERATION_CANCELLED'));
        if (work.owner && !work.task) this.#run(work, async () => { throw new GithubError('OPERATION_CANCELLED'); });
      }
      await work.task;
      if (work.owner || work.prior?.owner) refuse('CLEANUP_UNKNOWN');
      this.#clearSensitive(work);
      this.#current = undefined;
    })();
    return this.#closure;
  }
}

export function createGithubConnection(board: Board, canonicalRoot: string, config: GithubAppConfig | null,
  dependencies: GithubDependencies = {}): GithubConnection {
  if (config && (!/^[A-Za-z0-9_]{1,100}$/.test(config.clientId) || !/^[A-Za-z0-9-]{1,100}$/.test(config.slug))) refuse('CONFIG_REQUIRED');
  return new GithubConnection(board, canonicalRoot, config, dependencies);
}
