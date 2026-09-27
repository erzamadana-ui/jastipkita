import type { JobGroup } from './types';

/** Background jobs for the "money" module group. OWNED by the money agent/team. */
export const moneyJobs: JobGroup = {
  outbox: {},
  scheduled: [],
  queues: {},
};
