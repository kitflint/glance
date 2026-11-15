
import { openBoard } from '../../src/board.ts';

const root = process.argv[2];
if (!root || !process.send) throw new Error('Store worker requires a root and IPC');

const board = openBoard(root);
const send = process.send.bind(process);
process.once('disconnect', () => board.close());
process.on('message', (message: { requestId: number; operation: 'read' | 'change' | 'close'; command?: unknown }) => {
  switch (message.operation) {
    case 'read':
      send({ requestId: message.requestId, result: board.read() });
      break;
    case 'change':
      send({ requestId: message.requestId, result: board.change(message.command) });
      break;
    case 'close':
      send({ requestId: message.requestId, result: board.close() }, undefined, undefined, (error) => {
        if (error) process.exitCode = 1;
        if (process.connected) process.disconnect();
      });
      break;
  }
});
