import { randomBytes, timingSafeEqual } from 'node:crypto';
import { constants, realpathSync } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { normalize, parse } from 'node:path';
import { openBoard } from './board.ts';
import type { Failure } from './board.ts';
import { githubApp } from './github-config.ts';
import type { GithubAppConfig } from './github-config.ts';
import { createGithubConnection, githubErrorResponse, githubHttpStatus, githubOverview } from './github.ts';
import type { GithubDependencies } from './github.ts';

const bindAddress = '127.0.0.1';
const launchLifetime = 120_000;
const requestTimeout = 5000;
const stopGrace = 2000;
const maxRequests = 8;
const maxSockets = 16;
const commandLimit = 128 * 1024;
const importLimit = 3 * 1024 * 1024;
const hostedCsp = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";

const publicFiles = [
  ['/', 'index.html', 'text/html; charset=utf-8'],
  ['/app.js', 'app.js', 'text/javascript; charset=utf-8'],
  ['/style.css', 'style.css', 'text/css; charset=utf-8'],
] as const;

const githubRoutes = new Map([
  ['/api/github/overview', 'overview'], ['/api/github/start', 'start'], ['/api/github/status', 'status'],
  ['/api/github/cancel', 'cancel'], ['/api/github/discover', 'discover'], ['/api/github/select', 'select'],
  ['/api/github/refresh', 'refresh'], ['/api/github/import', 'importIssues'], ['/api/github/resolve', 'resolve'],
  ['/api/github/issue-state', 'issueState'], ['/api/github/unlink', 'unlink'], ['/api/github/clear-facts', 'clearFacts'],
  ['/api/github/disconnect', 'disconnect'],
  ['/api/github/publish-preview', 'publishPreview'], ['/api/github/publish-confirm', 'publishConfirm'],
  ['/api/github/preview-invalidate', 'previewInvalidate'],
  ['/api/github/reconcile-preview', 'reconcilePreview'], ['/api/github/reconcile-confirm', 'reconcileConfirm'],
  ['/api/github/publication-retire-preview', 'publicationRetirePreview'],
  ['/api/github/publication-retire-confirm', 'publicationRetireConfirm'],
] as const);
type GithubRoute = typeof githubRoutes extends Map<infer Key, infer Method> ? { key: Key; method: Method } : never;

const apiMethods = new Map<string, 'GET' | 'POST'>([
  ['/api/session', 'POST'], ['/api/board', 'GET'], ['/api/initialize', 'POST'],
  ['/api/change', 'POST'], ['/api/review', 'POST'], ['/api/export', 'POST'], ['/api/backup', 'POST'],
  ['/api/public-report', 'POST'],
  ['/api/recovery', 'GET'], ['/api/quit', 'POST'],
  ...[...githubRoutes.keys()].map((route) => [route, 'POST'] as const),
]);

const failureStatus: Record<Failure['error']['code'], number> = {
  INVALID_INPUT: 400, LIMIT_REACHED: 413, NOT_INITIALIZED: 409, ALREADY_EXISTS: 409,
  REVISION_CONFLICT: 409, BOARD_BUSY: 423, UNSUPPORTED_VERSION: 400, RECOVERY_REQUIRED: 503,
  IO_NOT_COMMITTED: 500, IO_OUTCOME_UNKNOWN: 500, CLOSED: 503,
};

type Host = { origin: string; launchUrl: string; closedPromise: Promise<void>; stop: () => Promise<void> };
type BoardState = 'UNINITIALIZED' | 'READY' | 'RECOVERY_ONLY';
type Body = { value: unknown; bytes: number };

class BodyError extends Error {
  readonly status: number;
  constructor(status: number) {
    super('Request body refused');
    this.status = status;
  }
}

function header(req: IncomingMessage, name: string): string | null | undefined {
  const values = req.headersDistinct[name];
  if (!values) return undefined;
  return values.length === 1 ? values[0] : null;
}

function matches(value: unknown, expected: string | undefined): boolean {
  if (!expected || typeof value !== 'string' || value.length !== expected.length ||
      !/^[a-z0-9_-]{43}$/i.test(value)) return false;
  return timingSafeEqual(Buffer.from(value, 'ascii'), Buffer.from(expected, 'ascii'));
}

function objectWith(value: unknown, ...keys: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function reply(res: ServerResponse, status: number, body: object): void {
  if (res.destroyed || res.writableEnded) return;
  const bytes = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': bytes.length });
  res.end(bytes);
}

function refuse(res: ServerResponse, status: number, code: string, message: string): void {
  reply(res, status, { ok: false, error: { code, message } });
}

function closeResponse(req: IncomingMessage, res: ServerResponse): void {
  req.pause();
  if (!res.headersSent) res.setHeader('Connection', 'close');
}

function readJson(req: IncomingMessage, limit: number): Promise<Body> {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks: Buffer[] = [];
    function clear() {
      req.removeListener('data', data);
      req.removeListener('end', end);
      req.removeListener('error', interrupted);
      req.removeListener('close', interrupted);
    }
    function interrupted() {
      clear();
      reject(new BodyError(400));
    }
    function data(chunk: Buffer) {
      if (chunk.length > limit - bytes) {
        req.pause();
        clear();
        reject(new BodyError(413));
        return;
      }
      bytes += chunk.length;
      chunks.push(chunk);
    }
    function end() {
      clear();
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes));
        resolve({ value: JSON.parse(text), bytes });
      } catch {
        reject(new BodyError(400));
      }
    }
    req.on('data', data);
    req.once('end', end);
    req.once('error', interrupted);
    req.once('close', interrupted);
  });
}

export async function startHost(root: string, options?: {
  githubConfig?: GithubAppConfig | null; githubDependencies?: GithubDependencies;
}): Promise<Host> {
  const assets = new Map<string, { bytes: Buffer; type: string }>(await Promise.all(publicFiles.map(async ([route, name, type]) =>
    [route, { bytes: await readFile(new URL('../web/' + name, import.meta.url)), type }] as const,
  )));
  const board = openBoard(root);
  const config = options?.githubConfig === undefined ? githubApp : options.githubConfig;
  let github: ReturnType<typeof createGithubConnection> | undefined;
  let githubClosure: Promise<void> | undefined;
  const githubSession = randomBytes(32).toString('base64url');
  let boardState: BoardState;
  let recoveryFailure: Failure | undefined;
  try {
    const initial = board.read();
    if ('error' in initial && initial.error.code !== 'RECOVERY_REQUIRED' && initial.error.code !== 'IO_OUTCOME_UNKNOWN') {
      throw new Error('The selected board could not be opened.');
    }
    if ('error' in initial && initial.error.code === 'RECOVERY_REQUIRED') {
      boardState = 'RECOVERY_ONLY';
      recoveryFailure = initial;
    } else {
      boardState = 'initialized' in initial && !initial.initialized ? 'UNINITIALIZED' : 'READY';
    }
    await access(root, constants.W_OK);
  } catch {
    board.close();
    throw new Error('The selected board directory is unavailable or unwritable.');
  }

  let origin: string;
  let expectedHost: string;
  let code: string | undefined;
  let token: string | undefined;
  let expires: number;
  let stopping = false;
  let listenerCloseObserved = false;
  let listenerCloseError: Error | undefined;
  let stopFinalized = false;
  let active = 0;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let stopTimer: ReturnType<typeof setTimeout> | undefined;
  const sockets = new Set<Socket>();
  let settled!: () => void;
  let failed!: (error: Error) => void;
  const closedPromise = new Promise<void>((resolve, reject) => { settled = resolve; failed = reject; });
  void closedPromise.catch(() => {});

  function finishStopIfReady(): void {
    if (!stopping || !listenerCloseObserved || sockets.size !== 0 || stopFinalized) return;
    stopFinalized = true;
    clearTimeout(stopTimer);

    void (async () => {
      let githubClosed = true, boardClosed = false;
      try { await githubClosure; } catch { githubClosed = false; }
      try {
        const result = board.close();
        boardClosed = 'closed' in result && result.closed === true;
      } catch { /* A thrown close leaves Board closure unconfirmed. */ }
      if (listenerCloseError || !githubClosed || !boardClosed) failed(new Error('Host closure could not be confirmed.'));
      else settled();
    })();
  }

  function closeGithub() {
    if (!githubClosure && github) {
      githubClosure = github.close();
      void githubClosure.catch(() => {});
    }
  }

  function beginStop(): void {
    if (stopping) return;
    stopping = true;
    code = undefined;
    token = undefined;
    closeGithub();
    clearTimeout(expiryTimer);
    stopTimer = setTimeout(() => {
      for (const socket of sockets) socket.destroy();
    }, stopGrace);
    server.close((error) => {
      listenerCloseObserved = true;
      listenerCloseError = error;
      finishStopIfReady();
    });
    server.closeIdleConnections();
  }

  function sendBoard(res: ServerResponse, result: object | Failure): void {
    if ('error' in result) {
      const error = result as Failure;
      if (error.error.code === 'RECOVERY_REQUIRED') {
        boardState = 'RECOVERY_ONLY';
        recoveryFailure = { ...error, recoveryAvailable: error.recoveryAvailable === true };
        closeGithub();
      }
      reply(res, failureStatus[error.error.code], { ok: false, ...error });
      return;
    }
    if ('initialized' in result && result.initialized) boardState = 'READY';
    if ('committed' in result && result.committed) github?.invalidatePublicationVersion();
    reply(res, 200, { ok: true, ...result });
  }

  function authorized(req: IncomingMessage): boolean {
    const value = header(req, 'authorization');
    return typeof value === 'string' && value.startsWith('Bearer ') && matches(value.slice(7), token);
  }

  function githubCommand(res: ServerResponse, method: GithubRoute['method'], body: unknown): void {
    try {
      if (method === 'overview' && !objectWith(body)) {
        refuse(res, 400, 'INVALID_INPUT', 'Send an empty object for GitHub overview.');
        return;
      }
      const current = boardState === 'RECOVERY_ONLY' ? recoveryFailure! : board.read();
      if ('error' in current || !current.initialized) {
        if ('error' in current && current.error.code === 'RECOVERY_REQUIRED') {
          boardState = 'RECOVERY_ONLY';
          recoveryFailure = current;
          closeGithub();
        }
        if (method === 'overview' && (!('error' in current) || current.error.code === 'RECOVERY_REQUIRED')) {
          reply(res, 200, { ok: true, configured: config !== null,
            boardState: 'error' in current ? 'RECOVERY_ONLY' : 'UNINITIALIZED', credentialState: 'unchecked' });
        } else if ('error' in current) sendBoard(res, current);
        else refuse(res, 409, 'NOT_INITIALIZED', 'Initialize a board first.');
        return;
      }
      if (!github && method === 'overview') {
        reply(res, 200, { ok: true, ...githubOverview(current, config), credentialState: 'unchecked', operation: null });
        return;
      }
      if (!github) {
        let canonicalRoot: string;
        try {
          const resolved = normalize(realpathSync.native(root));
          canonicalRoot = resolved.length > parse(resolved).root.length ? resolved.replace(/[\\/]+$/, '') : resolved;
        } catch {
          refuse(res, 503, 'CREDENTIAL_UNAVAILABLE', 'The selected board location could not be verified.');
          return;
        }
        github = createGithubConnection(board, canonicalRoot, config, options?.githubDependencies);
      }
      const result = github[method](githubSession, body);
      reply(res, ['start', 'discover', 'select', 'refresh', 'publishPreview', 'publishConfirm', 'reconcilePreview'].includes(method)
        ? 202 : 200, { ok: true, ...result });
    } catch (error) {
      const result = githubErrorResponse(error);
      const code = result.error.code;
      if (Object.hasOwn(failureStatus, code)) sendBoard(res, result as Failure);
      else reply(res, githubHttpStatus(code), { ok: false, ...result });
    }
  }

  function available(res: ServerResponse): boolean {
    if (!stopping) return true;
    refuse(res, 503, 'STOPPING', 'Shutdown requested.');
    return false;
  }

  async function route(req: IncomingMessage, res: ServerResponse, expectation: 'continue' | 'unsupported' | undefined) {
    const path = req.url ?? '';
    const asset = assets.get(path);
    const method = asset ? 'GET' : apiMethods.get(path);
    function reject(status: number, name: string, message: string) {
      closeResponse(req, res);
      refuse(res, status, name, message);
    }
    if (req.socket.remoteAddress !== bindAddress || header(req, 'host') !== expectedHost) {
      reject(403, 'HOST_REFUSED', 'This request must use the local application address.');
      return;
    }
    if (!method) {
      reject(404, 'NOT_FOUND', 'This route is unavailable.');
      return;
    }
    if (req.method !== method) {
      res.setHeader('Allow', method);
      reject(405, 'METHOD_REFUSED', 'This route does not accept the requested method.');
      return;
    }
    if (expectation === 'unsupported') {
      reject(417, 'EXPECTATION_REFUSED', 'This request expectation is unsupported.');
      return;
    }
    if (!available(res)) return;
    if (asset) {
      res.writeHead(200, { 'Content-Type': asset.type, 'Content-Length': asset.bytes.length });
      res.end(asset.bytes);
      return;
    }

    const caller = header(req, 'origin');
    if ((method === 'POST' || caller !== undefined) && caller !== origin) {
      reject(403, 'ORIGIN_REFUSED', 'This request must come from the application origin.');
      return;
    }
    if (path !== '/api/session' && !authorized(req)) {
      reject(401, 'SESSION_REQUIRED', 'Open the existing Glance tab or restart the host.');
      return;
    }
    if (method === 'GET') {
      if (path === '/api/board') sendBoard(res, recoveryFailure ?? board.read());
      else sendBoard(res, board.recoverySnapshot());
      return;
    }

    const type = header(req, 'content-type');
    if (typeof type !== 'string' || !/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i.test(type)) {
      reject(415, 'MEDIA_TYPE_REFUSED', 'Send a UTF-8 JSON request.');
      return;
    }
    const limit = path === '/api/initialize' ? importLimit : commandLimit;
    const declared = header(req, 'content-length');
    if (typeof declared === 'string' && Number(declared) > limit) {
      reject(413, 'LIMIT_REACHED', 'The request exceeds its byte limit.');
      return;
    }
    if (expectation === 'continue') res.writeContinue();
    let body: Body;
    try {
      body = await readJson(req, limit);
    } catch (error) {
      const status = error instanceof BodyError ? error.status : 400;
      reject(status, status === 413 ? 'LIMIT_REACHED' : 'INVALID_INPUT',
        status === 413 ? 'The request exceeds its byte limit.' : 'Send a complete JSON body.');
      return;
    }
    if (res.destroyed || res.writableEnded || !available(res)) return;
    if (path === '/api/session') {
      if (!objectWith(body.value, 'launchCode') || typeof body.value.launchCode !== 'string') {
        reject(400, 'INVALID_INPUT', 'Send only the launch code.');
        return;
      }
      if (!matches(body.value.launchCode, code) || performance.now() >= expires) {
        reject(401, 'LAUNCH_REFUSED', 'This launch code is invalid, expired or already used.');
        if (code && performance.now() >= expires) beginStop();
        return;
      }
      token = randomBytes(32).toString('base64url');
      code = undefined;
      clearTimeout(expiryTimer);
      reply(res, 200, { ok: true, token });
      return;
    }

    // A request admitted before Quit or token revocation cannot enter Board after reading its body.
    if (!authorized(req)) {
      reject(401, 'SESSION_REQUIRED', 'Open the existing Glance tab or restart the host.');
      return;
    }
    if (path === '/api/quit') {
      if (!objectWith(body.value)) {
        reject(400, 'INVALID_INPUT', 'Quit requires an empty JSON object.');
        return;
      }
      res.setHeader('Connection', 'close');
      beginStop();
      reply(res, 202, { ok: true, state: 'stopping' });
      return;
    }
    const githubMethod = githubRoutes.get(path as GithubRoute['key']);
    if (githubMethod) {
      githubCommand(res, githubMethod, body.value);
      return;
    }
    if (boardState === 'RECOVERY_ONLY') {
      sendBoard(res, recoveryFailure!);
      return;
    }

    switch (path) {
      case '/api/initialize': {
        const importRequest = typeof body.value === 'object' && body.value !== null &&
          'kind' in body.value && body.value.kind === 'import';
        if (!importRequest && body.bytes > commandLimit) {
          reject(413, 'LIMIT_REACHED', 'The request exceeds its byte limit.');
          return;
        }
        sendBoard(res, board.initialize(body.value));
        break;
      }
      case '/api/change':
        sendBoard(res, board.change(body.value));
        break;
      case '/api/review':
        sendBoard(res, board.review(body.value));
        break;
      case '/api/public-report':
        sendBoard(res, board.preparePublicReport(body.value));
        break;
      case '/api/export':
      case '/api/backup':
        if (!objectWith(body.value, 'expectedVersion')) {
          reject(400, 'INVALID_INPUT', 'Send only the expected version.');
        } else {
          sendBoard(res, path === '/api/backup' ? board.exportCurrentBackup(body.value.expectedVersion)
            : board.exportSnapshot(body.value.expectedVersion));
        }
        break;
    }
  }

  function dispatch(req: IncomingMessage, res: ServerResponse, expectation?: 'continue' | 'unsupported') {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', hostedCsp);
    req.on('error', () => {});
    res.on('error', () => req.socket.destroy());
    if (active >= maxRequests) {
      closeResponse(req, res);
      refuse(res, 429, 'LIMIT_REACHED', 'Too many active requests.');
      return;
    }
    active++;
    let pending = true;
    const timeout = setTimeout(() => {
      if (res.headersSent) req.socket.destroy();
      else {
        closeResponse(req, res);
        refuse(res, 408, 'REQUEST_TIMEOUT', 'The request timed out.');
      }
    }, requestTimeout);
    function release() {
      if (!pending) return;
      pending = false;
      active--;
      clearTimeout(timeout);
    }
    res.once('finish', release);
    res.once('close', release);
    res.once('error', release);
    req.once('aborted', release);
    void route(req, res, expectation).catch(() => {
      if (res.headersSent) req.socket.destroy();
      else {
        closeResponse(req, res);
        refuse(res, 500, 'IO_OUTCOME_UNKNOWN', 'Read the board and compare before submitting another change.');
      }
    });
  }

  const server = createServer({
    maxHeaderSize: 16 * 1024, headersTimeout: requestTimeout, requestTimeout,
    keepAliveTimeout: requestTimeout, connectionsCheckingInterval: 250,
  }, dispatch);
  server.maxHeadersCount = 0;
  server.on('checkContinue', (req, res) => dispatch(req, res, 'continue'));
  server.on('checkExpectation', (req, res) => dispatch(req, res, 'unsupported'));
  server.on('connection', (socket) => {
    if (stopping || sockets.size >= maxSockets) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.setTimeout(requestTimeout, () => socket.destroy());
    socket.once('close', () => {
      sockets.delete(socket);
      finishStopIfReady();
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: bindAddress, port: 0, exclusive: true }, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
  } catch {
    board.close();
    throw new Error('The local host could not listen.');
  }
  const address = server.address();
  if (address === null || typeof address === 'string') {
    beginStop();
    await closedPromise;
    throw new Error('The local listener did not have a TCP address.');
  }
  expectedHost = bindAddress + ':' + address.port;
  origin = 'http://' + expectedHost;
  code = randomBytes(32).toString('base64url');
  expires = performance.now() + launchLifetime;
  expiryTimer = setTimeout(beginStop, launchLifetime);
  server.on('error', beginStop);
  return {
    origin,
    launchUrl: origin + '/#launch=' + code,
    closedPromise,
    stop: () => { beginStop(); return closedPromise; },
  };
}
