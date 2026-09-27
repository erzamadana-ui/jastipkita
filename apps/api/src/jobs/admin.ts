import type { JobGroup } from './types';

/** Background jobs for the "admin" module group. OWNED by the admin agent/team. */
export const adminJobs: JobGroup = {
  outbox: {},
  scheduled: [],
  queues: {},
};
