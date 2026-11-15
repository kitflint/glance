import { startHost } from '../../src/host.ts';

const root = process.argv[2];
if (process.argv.length !== 3 || !root || !process.send) throw new Error('Host fixture needs an owned root and IPC');
const send = process.send.bind(process);
try {
  const host = await startHost(root);
  const stop = () => { void host.stop().catch(() => { process.exitCode = 1; }); };
  process.once('disconnect', stop);
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  process.on('message', (message: unknown) => {
    if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'stop') stop();
  });
  send({ type: 'ready', origin: host.origin, launchUrl: host.launchUrl }, undefined, undefined, (error) => {
    if (error) { process.exitCode = 1; stop(); }
  });
  await host.closedPromise;
} catch {
  process.exitCode = 1;
} finally {
  if (process.connected) process.disconnect();
}
