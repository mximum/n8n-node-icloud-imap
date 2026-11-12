import { executionError } from './errors';
import { randomUUID } from 'node:crypto';
import type { IDataObject, INodeType, INodeTypeDescription, ITriggerFunctions, ITriggerResponse } from 'n8n-workflow';
import { ImapConnectionError, MissingSearchResponseError, isRetryableConnectionError, type ImapClient } from './native/client';
import { createClient, credentialTest, getMailboxes, readMessage, selectedMailbox } from './imap';
import { mailboxProperty, readOptionFields, readOptions } from './properties';
import { newUids, selectCursor, type Cursor } from './cursor';
import { claimTriggerSession, type TriggerLease } from './trigger-session';
import { SuccessCheckpoint } from './success-checkpoint';

export class ICloudMailTrigger implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'iCloud Mail Trigger', name: 'iCloudMailTrigger', icon: 'file:icloudMail.svg',
    group: ['trigger'], version: 1, description: 'Start a workflow when a message arrives in an iCloud IMAP mailbox',
    defaults: { name: 'iCloud Mail Trigger' }, inputs: [], outputs: ['main'],
    credentials: [{ name: 'iCloudMailImap', required: true, testedBy: 'iCloudMailImapTest' }],
    properties: [
      mailboxProperty,
      { displayName: 'New mail is detected through IMAP IDLE with a periodic catch-up check. Reading does not mark messages as read. In test mode, send a new message after starting the listener.',
        name: 'notice', type: 'notice', default: '' },
      { displayName: 'Options', name: 'options', type: 'collection', placeholder: 'Add Option', default: {}, options: [
        ...readOptionFields,
        { displayName: 'Include Trigger Diagnostics', name: 'includeDiagnostics', type: 'boolean', default: false,
          description: 'Whether to include implementation version, listener session and process identity in triggerInfo for troubleshooting duplicate executions' },
        { displayName: 'Include Existing Messages on First Activation', name: 'includeExisting', type: 'boolean', default: false,
          description: 'Whether to process all existing messages if this mailbox has no saved cursor. Ignored during manual testing.' },
        { displayName: 'Resume After Successful Workflow', name: 'resumeAfterSuccess', type: 'boolean', default: false,
          description: 'Whether to process one mail at a time and save progress only after the workflow succeeds. Production only.' },
        { displayName: 'Catch Up From', name: 'catchUpFrom', type: 'dateTime', default: '',
          displayOptions: { show: { resumeAfterSuccess: [true] } },
          description: 'Optional first-start boundary, inclusive, using the IMAP server received timestamp. An existing success checkpoint takes precedence.' },
        { displayName: 'Retry Failed Workflow After (Seconds)', name: 'retryInterval', type: 'number', default: 30,
          typeOptions: { minValue: 1, maxValue: 300, numberPrecision: 0 },
          displayOptions: { show: { resumeAfterSuccess: [true] } },
          description: 'Initial retry delay after a failed workflow. Repeated failures increase the delay up to five minutes.' },
        { displayName: 'Batch Size', name: 'batchSize', type: 'number', default: 50,
          typeOptions: { minValue: 1, maxValue: 500, numberPrecision: 0 },
          description: 'Messages per catch-up batch. Each message starts one workflow execution.' },
        { displayName: 'Catch-Up Interval (Seconds)', name: 'catchUpInterval', type: 'number', default: 60,
          typeOptions: { minValue: 10, maxValue: 3600, numberPrecision: 0 },
          description: 'Periodic scan in addition to IDLE notifications; also works without server IDLE support' },
      ] },
    ],
  };

  methods = { loadOptions: { getMailboxes }, credentialTest: { iCloudMailImapTest: credentialTest } };

  async trigger(this: ITriggerFunctions): Promise<ITriggerResponse> {
    const mailbox = this.getNodeParameter('mailbox') as string;
    const options = this.getNodeParameter('options', {}) as IDataObject;
    const config = { ...readOptions(options), onParseError: 'metadata' as const };
    const batchSize = Number(options.batchSize ?? 50);
    const interval = Number(options.catchUpInterval ?? 60);
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) throw new Error('Batch size must be between 1 and 500.');
    if (!Number.isInteger(interval) || interval < 10 || interval > 3600) throw new Error('Catch-up interval must be between 10 and 3600 seconds.');
    const manual = this.getMode() === 'manual';
    const confirmSuccess = !manual && Boolean(options.resumeAfterSuccess);
    const retryInterval = Number(options.retryInterval ?? 30);
    const catchUpFrom = confirmSuccess && options.catchUpFrom ? Date.parse(String(options.catchUpFrom)) : undefined;
    if (catchUpFrom !== undefined && !Number.isFinite(new Date(catchUpFrom - 86_400_000).getTime())) throw new Error('Invalid Catch Up From date.');
    if (confirmSuccess && (!Number.isInteger(retryInterval) || retryInterval < 1 || retryInterval > 300)) throw new Error('Retry interval must be between 1 and 300 seconds.');
    const workflowId = this.getWorkflow().id;
    const nodeId = this.getNode().id;
    if (!manual && (!workflowId || !nodeId)) throw new Error('Production trigger requires a saved workflow ID and node ID.');
    const sessionId = randomUUID();
    const state = manual ? {} as IDataObject : this.getWorkflowStaticData('node');
    let credentials: IDataObject;
    let account: string;
    let cursor: Cursor | undefined;
    let recovery: SuccessCheckpoint | undefined;
    let recoveryUids: number[] = [];
    let skippedUid = 0;
    let watchedRun: Promise<boolean> | undefined;
    let retryDelay = retryInterval * 1_000;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let lease: TriggerLease | undefined;
    let active: ImapClient | undefined;
    let stopped = false;
    let connecting = false;
    let scanning: Promise<void> | undefined;
    let scanAgain = false;
    let reconnectDelay = 1_000;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let scanTimer: ReturnType<typeof setTimeout> | undefined;
    let sweepTimer: ReturnType<typeof setInterval> | undefined;

    const checkpoint = () => {
      if (!manual && !recovery && cursor && lease?.isOwner()) {
        state.cursor = { ...cursor };
        lease.checkpoint(cursor);
      }
    };
    const stop = () => {
      stopped = true;
      clearTimeout(reconnectTimer); clearTimeout(scanTimer); clearTimeout(retryTimer); clearInterval(sweepTimer);
      lease?.release();
      const client = active;
      active = undefined;
      client?.close();
    };
    const fatal = (error: unknown) => {
      if (stopped) return;
      stop();
      this.emitError(executionError(error));
    };
    const scheduleReconnect = (reason?: unknown) => {
      if (stopped || connecting || reconnectTimer) return;
      const code = (reason as NodeJS.ErrnoException | undefined)?.code;
      const detail = reason instanceof ImapConnectionError ? reason.message
        : typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(code) ? `IMAP transport error (${code}).`
        : 'IMAP session closed.';
      this.logger.warn(`iCloud Mail: ${detail} Reconnecting in ${reconnectDelay / 1_000}s.`);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        void open().then(requestScan).catch((error: unknown) => {
          if (stopped) return;
          if (!isRetryableConnectionError(error)) { fatal(error); return; }
          scheduleReconnect(error);
        });
      }, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 60_000);
    };

    const watchRun = (run: Promise<boolean>) => {
      if (run === watchedRun) return;
      watchedRun = run;
      void run.then((success) => {
        watchedRun = undefined;
        if (stopped) return;
        if (success) {
          retryDelay = retryInterval * 1_000;
          requestScan();
        } else {
          this.logger.warn(`iCloud Mail: workflow failed; retrying the unconfirmed mail after ${retryDelay / 1_000}s.`);
          retryTimer = setTimeout(() => { retryTimer = undefined; requestScan(); }, retryDelay);
          retryDelay = Math.min(retryDelay * 2, 300_000);
        }
      }, fatal);
    };

    const open = async () => {
      if (stopped) return;
      const client = createClient(credentials);
      connecting = true;
      active = client;
      client.on('error', () => { client.close(); });
      client.on('close', (reason?: Error) => {
        if (active !== client) return;
        active = undefined;
        recoveryUids = [];
        scheduleReconnect(reason);
      });
      client.on('exists', () => { if (active === client) requestScan(); });
      try {
        await client.connect();
        if (stopped) { client.close(); return; }
        const lock = await client.getMailboxLock(mailbox, { readOnly: true });
        try {
          if (stopped) return;
          if (active !== client || !client.usable) throw new ImapConnectionError('IMAP connection closed while opening the mailbox.');
          const box = selectedMailbox(client);
          const uidValidity = String(box.uidValidity);
          if (recovery) {
            const saved = recovery.read();
            if (saved && saved.uidValidity !== uidValidity) throw new Error(`Mailbox UIDVALIDITY changed. Review the checkpoint ${recovery.file} before resuming.`);
            if (!saved) {
              const initial = selectCursor(catchUpFrom === undefined ? cursor ?? state.cursor : undefined, account, mailbox,
                uidValidity, box.uidNext, catchUpFrom !== undefined || Boolean(options.includeExisting)).cursor;
              recovery.write({ uidValidity, lastUid: initial.lastUid, receivedSince: catchUpFrom });
            }
          } else {
            const selected = selectCursor(cursor ?? state.cursor, account, mailbox,
              uidValidity, box.uidNext, !manual && Boolean(options.includeExisting));
            cursor = selected.cursor;
            checkpoint();
            if (selected.reset) this.logger.warn('iCloud Mail: UIDVALIDITY changed; cursor reset to new arrivals.');
          }
        } finally { lock.release(); }
        if (active !== client || !client.usable) throw new ImapConnectionError('IMAP connection closed while opening the mailbox.');
      } catch (error) {
        if (active === client) active = undefined;
        client.close();
        throw error;
      } finally { connecting = false; }
    };

    const scan = async () => {
      const client = active;
      if (stopped || connecting || !client?.usable || retryTimer) return;
      const pending = recovery?.pending;
      if (pending) { watchRun(pending); return; }
      const position = recovery?.read();
      if (recovery && !position) throw new Error('iCloud Mail success checkpoint is missing.');
      const saved = position ?? cursor;
      if (!saved) return;
      let lock: Awaited<ReturnType<ImapClient['getMailboxLock']>> | undefined;
      try {
        lock = await client.getMailboxLock(mailbox, { readOnly: true });
        if (stopped || active !== client) return;
        await client.noop();
        const box = selectedMailbox(client);
        const checkValidity = () => {
          if (String(box.uidValidity) !== saved.uidValidity) {
            throw new Error(recovery ? `Mailbox UIDVALIDITY changed during a scan. Review the checkpoint ${recovery.file}.`
              : 'Mailbox UIDVALIDITY changed during a scan. Reactivate the trigger.');
          }
        };
        checkValidity();
        const after = Math.max(saved.lastUid, skippedUid);
        if (after === 4_294_967_295) return;
        const since = position?.receivedSince;
        let uids = recoveryUids.filter((uid) => uid > after);
        if (!uids.length) {
          // SEARCH SINCE is day-based and ignores time zones. Fetch metadata to enforce the exact boundary.
          let found: number[];
          try {
            found = await client.search({ uid: `${after + 1}:*`, deleted: false,
              ...(since === undefined ? {} : { since: new Date(since - 86_400_000) }),
            }, { uid: true });
          } catch (error) {
            if (!(error instanceof MissingSearchResponseError)) throw error;
            checkValidity();
            // FETCH can legitimately return no data. readMessage still enforces the exact date cutoff.
            found = await client.fetchUndeletedUidsAfter(after);
          }
          if (!Array.isArray(found)) throw new Error('IMAP server did not return a valid search result.');
          checkValidity();
          reconnectDelay = 1_000;
          uids = newUids(found, after, batchSize);
          if (recovery && active === client) recoveryUids = uids;
        }
        for (const uid of uids) {
          if (stopped || active !== client) return;
          const message = await readMessage(this, client, uid, { ...config, receivedSince: since });
          if (stopped || active !== client) return;
          checkValidity();
          if (message && options.includeDiagnostics) message.json.triggerInfo = {
            version: '0.3.3', sessionId, processId: process.pid,
            workflowId: workflowId ?? '', nodeId: nodeId ?? '', mode: manual ? 'manual' : 'production',
          };
          if (recovery && position) {
            if (!message) { skippedUid = uid; continue; }
            watchRun(recovery.dispatch(this, message, position, uid));
            return; // Release the IMAP lock while the workflow runs.
          }
          const previousUid = saved.lastUid;
          saved.lastUid = uid;
          // n8n may snapshot static data synchronously inside emit(). Commit first.
          checkpoint();
          try {
            if (message) this.emit([[message]]);
          } catch (error) {
            saved.lastUid = previousUid;
            checkpoint();
            throw error;
          }
          // A manual test emits one new arrival and leaves production static data untouched.
          if (message && manual) { stop(); return; }
        }
        if (uids.length === batchSize || (recovery && uids.length > 0)) scanAgain = true;
      } catch (error) {
        if (stopped || active !== client) return;
        if (isRetryableConnectionError(error)) { client.close(error instanceof Error ? error : undefined); return; }
        throw error;
      } finally { lock?.release(); }
    };

    function requestScan() {
      if (stopped) return;
      scanAgain = true;
      if (scanning || scanTimer) return;
      scanTimer = setTimeout(() => {
        scanTimer = undefined;
        scanning = (async () => {
          // Yield between batches so closeFunction and other nodes remain responsive.
          while (scanAgain && !stopped) {
            scanAgain = false;
            try { await scan(); }
            catch (error) {
              if (!active?.usable) {
                const old = active;
                active = undefined;
                old?.close();
                scheduleReconnect(error);
              } else fatal(error);
              break;
            }
            if (scanAgain) await new Promise<void>((resolve) => setImmediate(resolve));
          }
        })().finally(() => {
          scanning = undefined;
          if (scanAgain && !stopped) requestScan();
        });
      }, 0);
    }

    if (!manual) {
      lease = claimTriggerSession(workflowId!, nodeId!, stop);
      cursor = lease.previousCursor;
      if (lease.replaced) this.logger.warn('iCloud Mail: replaced an overlapping production listener for this workflow/node.');
    }
    try {
      // Reserve the session before awaiting credentials, so an older, slow activation
      // cannot overtake and replace a newer activation after its credentials resolve.
      credentials = await this.getCredentials('iCloudMailImap');
      account = `${this.getNode().credentials?.iCloudMailImap?.id ?? ''}:${String(credentials.user).trim()}`;
      if (confirmSuccess) recovery = new SuccessCheckpoint(workflowId!, nodeId!, account, mailbox);
      await open();
    }
    catch (error) {
      if (!stopped) {
        if (manual || !isRetryableConnectionError(error)) { stop(); throw executionError(error); }
        scheduleReconnect(error);
      }
    }
    if (!stopped) {
      sweepTimer = setInterval(requestScan, interval * 1000);
      requestScan();
    }
    return {
      closeFunction: async () => { stop(); await scanning; },
      manualTriggerFunction: async () => { requestScan(); },
    };
  }
}
