export interface Cursor {
  account: string;
  mailbox: string;
  uidValidity: string;
  lastUid: number;
}

export function selectCursor(
  saved: unknown, account: string, mailbox: string, uidValidity: string,
  uidNext: number, includeExisting: boolean,
): { cursor: Cursor; reset: boolean } {
  const old = saved as Partial<Cursor> | undefined;
  const sameMailbox = old?.account === account && old?.mailbox === mailbox;
  const valid = sameMailbox && old.uidValidity === uidValidity &&
    Number.isSafeInteger(old.lastUid) && Number(old.lastUid) >= 0 && Number(old.lastUid) <= 4_294_967_295;
  // Only a UIDVALIDITY change invalidates UIDs. An inconsistent/derived UIDNEXT must
  // never rewind a checkpoint and replay an already emitted message on reconnect.
  if (valid) return { cursor: { ...old } as Cursor, reset: false };
  const reset = Boolean(sameMailbox && old.uidValidity !== uidValidity);
  return {
    cursor: { account, mailbox, uidValidity, lastUid: includeExisting && !reset ? 0 : Math.max(0, uidNext - 1) },
    reset,
  };
}

export function newUids(found: number[], lastUid: number, batchSize: number): number[] {
  // IMAP n:* can return the last existing UID even when it is smaller than n.
  return [...new Set(found)].filter((uid) => Number.isInteger(uid) && uid > lastUid && uid <= 4_294_967_295)
    .sort((a, b) => a - b).slice(0, batchSize);
}
