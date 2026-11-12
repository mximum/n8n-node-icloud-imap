import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { INodeExecutionData, IRun, ITriggerFunctions } from 'n8n-workflow';

interface Position {
  uidValidity: string;
  lastUid: number;
  receivedSince?: number;
  blockedUid?: number;
}

const inFlight = new Map<string, Promise<boolean>>();
const unpersisted = new Map<string, Position>();
const isUid = (value: unknown): value is number => typeof value === 'number' &&
  Number.isInteger(value) && value >= 0 && value <= 4_294_967_295;

export class SuccessCheckpoint {
  readonly file: string;

  constructor(workflowId: string, nodeId: string, account: string, mailbox: string) {
    const dataDir = resolve(process.env.N8N_USER_FOLDER || homedir(), '.n8n');
    const directory = process.env.ICLOUD_IMAP_CHECKPOINT_DIR || join(dataDir, 'icloud-imap-checkpoints');
    const key = createHash('sha256').update(JSON.stringify([workflowId, nodeId, account, mailbox])).digest('hex');
    this.file = resolve(directory, `${key}.json`);
  }

  get pending() { return inFlight.get(this.file); }

  read(): Position | undefined {
    // If writing a successful result failed, retry the write before any redispatch.
    const unsaved = unpersisted.get(this.file);
    if (unsaved) this.write(unsaved);
    let contents: string;
    try { contents = readFileSync(this.file, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new Error('Could not read the iCloud Mail success checkpoint.', { cause: error });
    }
    let position: Partial<Position> | null;
    try { position = JSON.parse(contents) as Partial<Position> | null; }
    catch (error) { throw new Error('Invalid iCloud Mail success checkpoint.', { cause: error }); }
    if (!position || typeof position.uidValidity !== 'string' || !/^[1-9]\d{0,9}$/.test(position.uidValidity) ||
      !isUid(Number(position.uidValidity)) || !isUid(position.lastUid) ||
      (position.receivedSince !== undefined && (!Number.isFinite(position.receivedSince) || !Number.isFinite(new Date(position.receivedSince).getTime()))) ||
      (position.blockedUid !== undefined && (!isUid(position.blockedUid) || position.blockedUid <= position.lastUid))) {
      throw new Error('Invalid iCloud Mail success checkpoint. Check the checkpoint file before reactivating.');
    }
    if (position.blockedUid !== undefined) {
      throw new Error(`Workflow outcome for mail UID ${position.blockedUid} is unresolved. Check the execution before resetting the checkpoint ${this.file}.`);
    }
    return position as Position;
  }

  write(position: Position): void {
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      const fd = openSync(temporary, 'wx', 0o600);
      try {
        writeFileSync(fd, JSON.stringify(position) + '\n', 'utf8');
        fsyncSync(fd);
      } finally { closeSync(fd); }
      renameSync(temporary, this.file);
      unpersisted.delete(this.file);
    } catch (error) {
      try { unlinkSync(temporary); } catch { /* The temporary file might not exist. */ }
      throw new Error('Could not save the iCloud Mail success checkpoint.', { cause: error });
    }
  }

  dispatch(context: ITriggerFunctions, message: INodeExecutionData, position: Position, uid: number): Promise<boolean> {
    const previous = this.pending;
    if (previous) return previous;
    let resolveRun!: (run: IRun | PromiseLike<IRun>) => void;
    let rejectRun!: (error: Error) => void;
    const promise = new Promise<IRun>((resolve, reject) => { resolveRun = resolve; rejectRun = reject; });
    const pending = promise.then((run) => {
      const status = run?.status;
      if (status === 'error' || status === 'canceled' || status === 'crashed') return false;
      const next = status === 'success' ? { ...position, lastUid: uid } : { ...position, blockedUid: uid };
      unpersisted.set(this.file, next);
      this.write(next);
      if (status !== 'success') throw new Error(`Workflow outcome for mail UID ${uid} is unresolved (${status ?? 'no result'}). Replay is paused at ${this.file}.`);
      return true;
    }, () => false).finally(() => { inFlight.delete(this.file); });
    inFlight.set(this.file, pending);
    try { context.emit([[message]], undefined, { promise, resolve: resolveRun, reject: rejectRun }); }
    catch (error) { rejectRun(error instanceof Error ? error : new Error(String(error))); }
    return pending;
  }
}
