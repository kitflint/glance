import { startHost } from './host.ts';

const [flag, root] = process.argv.slice(2);
if (process.argv.length !== 4 || flag !== '--root' || !root || !/^[a-z]:[\\/]/i.test(root)) {
  console.error('Usage: npm start -- --root <absolute local Windows directory>');
  process.exitCode = 1;
} else {
  try {
    const host = await startHost(root);
    const stop = () => { void host.stop().catch(() => { process.exitCode = 1; }); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      console.log(process.stdout.isTTY ? host.launchUrl : host.origin);
      await host.closedPromise;
    } finally {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
    }
  } catch {
    console.error('Glance could not start or confirm shutdown.');
    process.exitCode = 1;
  }
}
