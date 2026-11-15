
import { randomUUID } from 'node:crypto';
import type { Snapshot } from './board.ts';

export function sampleSnapshot(now: string): Snapshot {
  const milestoneId = 'm_' + randomUUID();
  const workstreamId = 'w_' + randomUUID();
  const firstTaskId = 't_' + randomUUID();
  const secondTaskId = 't_' + randomUUID();
  const evidenceId = 'e_' + randomUUID();
  return {
    schemaVersion: 2,
    boardId: 'b_' + randomUUID(),
    generation: randomUUID(),
    revision: 1,
    updatedAt: now,
    project: {
      name: 'Sample delivery board',
      goal: 'Prepare a small release with clear evidence for each step.',
      stage: 'Plan',
      focusTaskId: firstTaskId,
      nextActions: ['Review the example goal and edit a task.', 'Save a change and reopen the board.'],
    },
    milestones: [{ id: milestoneId, title: 'First usable board' }],
    workstreams: [{ id: workstreamId, title: 'Local workflow' }],
    tasks: [
      {
        id: firstTaskId,
        title: 'Define the local workflow',
        description: 'This synthetic task illustrates a goal, criterion and evidence reference.',
        owner: 'Example owner', priority: 'P1', status: 'In progress',
        milestoneId, workstreamId, prerequisites: [],
        criteria: [{ id: 'c_' + randomUUID(), requirement: 'The saved goal appears after reopening.', evidenceIds: [evidenceId] }],
        blockers: [], evidenceIds: [evidenceId],
      },
      {
        id: secondTaskId,
        title: 'Review an offline export',
        description: 'Compare the export revision with the saved board.',
        owner: 'Example reviewer', priority: 'P1', status: 'Planned',
        milestoneId, workstreamId, prerequisites: [firstTaskId],
        criteria: [{ id: 'c_' + randomUUID(), requirement: 'All export formats identify the same saved revision.', evidenceIds: [] }],
        blockers: [], evidenceIds: [],
      },
    ],
    evidence: [{
      id: evidenceId, title: 'Example reopen check', scope: 'local', outcome: 'not-run',
      location: 'examples/reopen-notes.md', recordedAt: now, supersedesId: null,
    }],
    reviews: [],
    reviewArchive: null,
  };
}
