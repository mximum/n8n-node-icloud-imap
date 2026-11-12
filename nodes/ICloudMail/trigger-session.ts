import type { Cursor } from './cursor';

interface Session { stop: () => void; cursor?: Cursor }
export interface TriggerLease {
  previousCursor?: Cursor;
  replaced: boolean;
  isOwner(): boolean;
  checkpoint(cursor: Cursor): void;
  release(): void;
}

// Active production listeners only. Scope by workflow + trigger node, never by account alone.
// This protects overlapping registrations in one n8n process; it is not a distributed lock.
const sessions = new Map<string, Session>();

export function claimTriggerSession(workflowId: string, nodeId: string, stop: () => void): TriggerLease {
  const key = JSON.stringify([workflowId, nodeId]);
  const previous = sessions.get(key);
  const inherited = previous?.cursor ? { ...previous.cursor } : undefined;
  const session: Session = { stop, cursor: inherited };
  // Publish the new owner first so cleanup of the old owner cannot release the new lease.
  sessions.set(key, session);
  previous?.stop();
  const isOwner = () => sessions.get(key) === session;
  return {
    previousCursor: inherited, replaced: Boolean(previous), isOwner,
    checkpoint(cursor) { if (isOwner()) session.cursor = { ...cursor }; },
    release() { if (isOwner()) sessions.delete(key); },
  };
}
