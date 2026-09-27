import type { AppDeps } from '../context';

export interface OutboxEvent {
  id: number;
  eventId: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: Date;
  attempts: number;
}

/** Outbox subscriber. MUST be idempotent (at-least-once delivery; use event.eventId for dedupe). */
export type OutboxHandler = (deps: AppDeps, event: OutboxEvent) => Promise<void>;

/** Periodic job. Runs at most once per `everySec` window cluster-wide (coordinated through the jobs table). */
export interface ScheduledJob {
  name: string;
  everySec: number;
  run: (deps: AppDeps) => Promise<Record<string, unknown> | void>;
}

/** Queue consumer for ad-hoc jobs enqueued with enqueueJob(). */
export type QueueHandler = (deps: AppDeps, payload: Record<string, unknown>) => Promise<Record<string, unknown> | void>;

export interface JobGroup {
  outbox?: Record<string, OutboxHandler[]>;
  scheduled?: ScheduledJob[];
  queues?: Record<string, QueueHandler>;
}
