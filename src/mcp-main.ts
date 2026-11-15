import { createWriteStream, write, writev } from 'node:fs';
import type { Readable, Writable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { isJSONRPCNotification, isJSONRPCRequest } from '@modelcontextprotocol/server';
import type { JSONRPCMessage, RequestId, Transport } from '@modelcontextprotocol/server';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import type { StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import { openBoard, openBoardReader } from './board.ts';
import type { BoardReader } from './board.ts';
import { createGlanceMcpServer } from './mcp.ts';

const maxInputBufferBytes = 65_536;
const maxRequests = 8;
const maxRequestBytes = 131_072;
const maxMessagesPerSecond = 32;
const maxFrameBytes = 524_288;
const maxPendingSendBytes = 1_048_576;
const deadlineMs = 2_000;
let terminationAttempted = false;

type TransportFailure = 'INPUT_RATE_LIMIT' | 'INPUT_REQUEST_LIMIT' | 'INPUT_BYTE_LIMIT' | 'DUPLICATE_REQUEST' |
  'CANCELLED_REQUEST' | 'OUTPUT_FRAME_LIMIT' | 'OUTPUT_PENDING_LIMIT' | 'OUTPUT_STALL' |
  'OUTPUT_SEND_FAILED' | 'PROTOCOL_ERROR';
type ShutdownFailure = TransportFailure | 'INVALID_ARGUMENTS' | 'PIPE_ERROR' | 'CONSOLE_INTERRUPT' |
  'READER_CLOSE_FAILED' | 'TRANSPORT_CLOSE_FAILED';

function frameBytes(message: JSONRPCMessage): number {
  return Buffer.byteLength(JSON.stringify(message), 'utf8') + 1;
}

function cancellationId(message: JSONRPCMessage): RequestId | undefined {
  if (!isJSONRPCNotification(message) || message.method !== 'notifications/cancelled') return undefined;
  const id = message.params?.requestId;
  const reason = message.params?.reason;
  if (reason !== undefined && typeof reason !== 'string') return undefined;
  return typeof id === 'string' || (typeof id === 'number' && Number.isInteger(id)) ? id : undefined;
}

export function createBoundedStdioTransport(
  input: Readable,
  output: Writable,
  onFailure: (code: TransportFailure) => void,
): Transport {
  if (output.writableHighWaterMark !== 1) throw new Error('MCP output requires highWaterMark 1.');
  const delegate = new StdioServerTransport(input, output, { maxBufferSize: maxInputBufferBytes });
  const pending = new Map<RequestId, number>();
  const abortSends = new Set<(error: Error) => void>();
  let accepting = true;
  let started = false;
  let carry: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let closing: Promise<void> | undefined;
  let failure: TransportFailure | undefined;
  let requestBytes = 0;
  let sendBytes = 0;
  let bucket = -1;
  let messages = 0;

  function fail(code: TransportFailure): Error {
    const error = new Error(code);
    if (!failure) {
      accepting = false;
      failure = code;
      onFailure(code);
      void transport.close().catch(() => {});
    }
    return error;
  }

  function observeSyntax(chunk: Buffer): void {
    if (!accepting) return;
    if (carry.length + chunk.length > maxInputBufferBytes) {
      fail('PROTOCOL_ERROR');
      return;
    }

    const bytes = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    let start = 0;
    for (let end = bytes.indexOf(0x0a, start); end !== -1; end = bytes.indexOf(0x0a, start)) {
      try {
        JSON.parse(bytes.toString('utf8', start, end).replace(/\r$/, ''));
      } catch {
        // The SDK still receives this chunk, but the failure latch blocks its decoded messages.
        fail('PROTOCOL_ERROR');
        return;
      }
      start = end + 1;
    }
    carry = Buffer.from(bytes.subarray(start));
  }

  function receive(message: JSONRPCMessage): void {
    if (!accepting) return;
    const second = Math.floor(performance.now() / 1000);
    if (bucket !== second) {
      bucket = second;
      messages = 0;
    }
    if (++messages > maxMessagesPerSecond) {
      fail('INPUT_RATE_LIMIT');
      return;
    }
    if (isJSONRPCRequest(message)) {
      if (pending.has(message.id)) {
        fail('DUPLICATE_REQUEST');
        return;
      }
      if (pending.size >= maxRequests) {
        fail('INPUT_REQUEST_LIMIT');
        return;
      }
      const bytes = frameBytes(message);
      if (requestBytes + bytes > maxRequestBytes) {
        fail('INPUT_BYTE_LIMIT');
        return;
      }
      pending.set(message.id, bytes);
      requestBytes += bytes;
    }
    const cancelled = cancellationId(message);
    if (cancelled !== undefined && pending.has(cancelled)) {
      fail('CANCELLED_REQUEST');
      return;
    }
    transport.onmessage?.(message);
  }

  const transport: Transport = {
    async start() {
      if (!accepting) throw new Error('MCP transport is closed.');
      if (started) throw new Error('MCP transport already started.');
      started = true;
      try {
        input.prependListener('data', observeSyntax);
        await delegate.start();
      } catch (error) {
        await transport.close().catch(() => {});
        throw error;
      }
    },
    async send(message) {
      if (!accepting) throw new Error('MCP connection is closing.');
      const bytes = frameBytes(message);
      if (bytes > maxFrameBytes) throw fail('OUTPUT_FRAME_LIMIT');
      if (sendBytes + bytes > maxPendingSendBytes) throw fail('OUTPUT_PENDING_LIMIT');

      sendBytes += bytes;
      let abort!: (error: Error) => void;
      const interrupted = new Promise<never>((_, reject) => { abort = reject; });
      abortSends.add(abort);
      const timer = setTimeout(() => abort(fail('OUTPUT_STALL')), deadlineMs);
      try {
        await Promise.race([interrupted, delegate.send(message)]);
        if (!accepting) throw new Error('MCP connection is closing.');
        if ('id' in message && message.id != null && ('result' in message || 'error' in message)) {
          const charge = pending.get(message.id);
          if (charge !== undefined) {
            pending.delete(message.id);
            requestBytes -= charge;
          }
        }
      } catch (error) {
        if (accepting) throw fail('OUTPUT_SEND_FAILED');
        throw error;
      } finally {
        clearTimeout(timer);
        abortSends.delete(abort);
        sendBytes -= bytes;
      }
    },
    close() {
      if (!closing) {
        accepting = false;
        input.off('data', observeSyntax);
        carry = Buffer.alloc(0);
        pending.clear();
        requestBytes = 0;
        for (const abort of abortSends) abort(new Error(failure ?? 'MCP connection is closing.'));
        closing = Promise.resolve().then(() => delegate.close()).finally(() => transport.onclose?.());
      }
      return closing;
    },
  };
  delegate.onmessage = receive;
  delegate.onerror = (error) => {
    if (!accepting) return;
    fail('PROTOCOL_ERROR');
    transport.onerror?.(error);
  };
  delegate.onclose = () => { if (!closing) void transport.close().catch(() => {}); };
  return transport;
}

function terminateAtDeadline(): void {
  process.exitCode = 1;
  if (terminationAttempted) return;
  terminationAttempted = true;

  if (process.platform === 'win32') {
    try {
      process.kill(process.pid, 'SIGKILL');
    } catch {
      // Keep the failure status and let any cleanup already in progress continue.
    }
    return;
  }

  process.exit(1);
}

function diagnostic(code: ShutdownFailure): Promise<void> {
  const stderr = createWriteStream('', { fd: 2, autoClose: false });
  const done = finished(stderr, { cleanup: true }).catch(() => {});
  stderr.end('KFG_MCP ' + code + '\n');
  return done;
}

function selectLaunch(args: string[]): { root: string; allowWrites: boolean } | undefined {
  const root = args[1];
  const allowWrites = args.length === 3 && args[2] === '--allow-writes';
  if (process.platform !== 'win32' || (args.length !== 2 && !allowWrites) || args[0] !== '--root' ||
      !/^[a-z]:[\\/]/i.test(root) || root.slice(2).includes(':') || root.includes('\0') ||
      root.slice(3).split(/[\\/]/).some((part) => /[. ]$/.test(part))) return undefined;
  return { root, allowWrites };
}

function run(root: string, allowWrites: boolean): void {
  const input = process.stdin;
  const output = createWriteStream('', {
    fd: 1,
    autoClose: false,
    highWaterMark: 1,
    // Explicit destroy still invokes WriteStream's close hook. Keep fd 1 process-owned.
    fs: { write, writev, close: (_fd: number, done: (error: null) => void) => done(null) },
  });
  const outputDone = finished(output, { cleanup: true }).then(() => true, () => false);
  const readers = new Set<BoardReader>();
  let handle: StdioServerHandle | undefined;
  let shutdownDeadline: number | undefined;
  let shutdownTimer: NodeJS.Timeout | undefined;
  let failure: ShutdownFailure | undefined;
  let diagnosticDone: Promise<void> | undefined;

  function armShutdownDeadline(): void {
    if (shutdownDeadline === undefined || shutdownTimer !== undefined) return;
    shutdownTimer = setTimeout(terminateAtDeadline, Math.max(0, Math.ceil(shutdownDeadline - performance.now())));
  }

  function latch(code: ShutdownFailure): void {
    if (failure) return;
    failure = code;
    process.exitCode = 1;
    armShutdownDeadline();
    diagnosticDone = diagnostic(code);
    output.destroy(new Error('MCP output stopped.'));
  }

  function failed(code: ShutdownFailure): void {
    latch(code);
    shutdown();
  }

  const transport = createBoundedStdioTransport(input, output, failed);
  const closeTransport = transport.close.bind(transport);
  transport.close = async () => {
    try {
      await closeTransport();
    } finally {
      queueMicrotask(shutdown);
    }
  };

  function closeReader(reader: BoardReader): void {
    try {
      if ('closed' in reader.close()) {
        readers.delete(reader);
        return;
      }
    } catch {
      // The same failure is latched for returned and thrown close failures.
    }
    latch('READER_CLOSE_FAILED');
  }

  const onPipeError = () => failed('PIPE_ERROR');
  const onInterrupt = () => failed('CONSOLE_INTERRUPT');

  function shutdown(): void {
    if (shutdownDeadline !== undefined) return;
    shutdownDeadline = performance.now() + deadlineMs;
    armShutdownDeadline();
    input.pause();
    void cleanup().then(() => {
      if (!failure) {
        clearTimeout(shutdownTimer);
        shutdownTimer = undefined;
      }
    }, () => latch('TRANSPORT_CLOSE_FAILED'));
  }

  async function cleanup(): Promise<void> {
    try {
      await handle?.close();
    } catch {
      latch('TRANSPORT_CLOSE_FAILED');
    }
    try {
      await transport.close();
    } catch {
      latch('TRANSPORT_CLOSE_FAILED');
    }
    for (const reader of readers) closeReader(reader);
    if (!failure) output.end();
    if (!(await outputDone)) latch('PIPE_ERROR');
    await diagnosticDone;
    input.off('end', shutdown);
    input.off('close', shutdown);
    input.off('error', onPipeError);
    output.off('error', onPipeError);
    process.off('SIGINT', onInterrupt);
  }

  input.on('end', shutdown);
  input.on('close', shutdown);
  input.on('error', onPipeError);
  output.on('error', onPipeError);
  process.on('SIGINT', onInterrupt);
  try {
    handle = serveStdio(() => {
      const writer = allowWrites ? openBoard(root) : undefined;
      const reader = writer ?? openBoardReader(root);
      readers.add(reader);
      const server = createGlanceMcpServer(reader, writer?.change.bind(writer));
      server.server.onclose = () => closeReader(reader);
      return server;
    }, { transport, onerror: () => failed('PROTOCOL_ERROR'), maxSubscriptions: 0 });
  } catch {
    failed('PROTOCOL_ERROR');
  }
}

if (import.meta.main) {
  const launch = selectLaunch(process.argv.slice(2));
  if (launch === undefined) {
    process.exitCode = 1;
    const timer = setTimeout(terminateAtDeadline, deadlineMs);
    void diagnostic('INVALID_ARGUMENTS').then(() => clearTimeout(timer));
  } else {
    run(launch.root, launch.allowWrites);
  }
}
