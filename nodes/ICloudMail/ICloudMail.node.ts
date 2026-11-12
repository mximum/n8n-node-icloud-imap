import { executionError } from './errors';
import type { IDataObject, IExecuteFunctions, INodeExecutionData, INodeType, INodeTypeDescription } from 'n8n-workflow';
import { buildSearch, createClient, credentialTest, disconnect, getMailboxes, moveMessage, parseUid, readMessage } from './imap';
import { mailboxProperty, readOptionFields, readOptions, searchFields } from './properties';

export class ICloudMail implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'iCloud Mail', name: 'iCloudMail', icon: 'file:icloudMail.svg',
    group: ['transform'], version: 1, subtitle: '={{$parameter["operation"]}}',
    description: 'Read, search and move iCloud Mail messages over IMAP',
    defaults: { name: 'iCloud Mail' }, inputs: ['main'], outputs: ['main'],
    credentials: [{ name: 'iCloudMailImap', required: true, testedBy: 'iCloudMailImapTest' }],
    properties: [
      { displayName: 'Operation', name: 'operation', type: 'options', noDataExpression: true, default: 'getMany',
        options: [
          { name: 'Get Many Messages', value: 'getMany', action: 'Get many messages', description: 'Search messages in a mailbox' },
          { name: 'Get Message', value: 'get', action: 'Get a message', description: 'Read one message by UID' },
          { name: 'List Mailboxes', value: 'listMailboxes', action: 'List mailboxes' },
          { name: 'Move Message', value: 'move', action: 'Move a message', description: 'Move one message to another mailbox' },
        ] },
      { ...mailboxProperty, displayOptions: { hide: { operation: ['listMailboxes'] } } },
      { displayName: 'Message UID', name: 'uid', type: 'string', default: '={{ $json.uid }}', required: true,
        displayOptions: { show: { operation: ['get', 'move'] } },
        description: 'The numeric IMAP UID returned by this node or its trigger' },
      { displayName: 'Source UIDVALIDITY', name: 'uidValidity', type: 'string', default: '={{ $json.uidValidity }}', required: true,
        displayOptions: { show: { operation: ['move'] } },
        description: 'Pass uidValidity from the message or trigger to guard against mailbox UID resets' },
      { displayName: 'Destination Mailbox Name or ID', name: 'destinationMailbox', type: 'options',
        typeOptions: { loadOptionsMethod: 'getMailboxes' }, default: '', required: true,
        displayOptions: { show: { operation: ['move'] } },
        description: 'Choose an existing destination mailbox, or specify its exact path using an expression' },
      { displayName: 'Limit', name: 'limit', type: 'number', default: 50,
        typeOptions: { minValue: 1, maxValue: 1000, numberPrecision: 0 },
        displayOptions: { show: { operation: ['getMany'] } }, description: 'Max number of results to return' },
      { displayName: 'Filters', name: 'filters', type: 'collection', placeholder: 'Add Filter', default: {},
        displayOptions: { show: { operation: ['getMany'] } }, options: searchFields },
      { displayName: 'Options', name: 'options', type: 'collection', placeholder: 'Add Option', default: {},
        displayOptions: { show: { operation: ['get', 'getMany'] } }, options: [
          ...readOptionFields,
          { displayName: 'Mark as Read', name: 'markAsRead', type: 'boolean', default: false,
            description: 'Whether to mark messages as read after they have been fetched successfully' },
        ] },
    ],
  };

  methods = { loadOptions: { getMailboxes }, credentialTest: { iCloudMailImapTest: credentialTest } };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const results: INodeExecutionData[] = [];
    const credentials = await this.getCredentials('iCloudMailImap');
    const inputs = this.getInputData();
    // Reuse one authenticated connection for this execution, never across workflows.
    let client: ReturnType<typeof createClient> | undefined;
    try {
      for (let index = 0; index < inputs.length; index++) {
        try {
          if (!client?.usable) {
            if (client) await disconnect(client);
            client = createClient(credentials);
            await client.connect();
          }
          const operation = this.getNodeParameter('operation', index) as string;
          if (operation === 'listMailboxes') {
            for (const box of await client.list()) results.push({
              json: { path: box.path, name: box.name, delimiter: box.delimiter,
                specialUse: box.specialUse ?? '', flags: [...box.flags], selectable: !box.flags.has('\\Noselect') },
              pairedItem: { item: index },
            });
            continue;
          }
          const mailbox = this.getNodeParameter('mailbox', index) as string;
          const lock = await client.getMailboxLock(mailbox, { readOnly: operation !== 'move' &&
            !Boolean((this.getNodeParameter('options', index, {}) as IDataObject).markAsRead) });
          try {
            if (operation === 'move') {
              const json = await moveMessage(client, parseUid(this.getNodeParameter('uid', index)),
                this.getNodeParameter('uidValidity', index), this.getNodeParameter('destinationMailbox', index) as string);
              results.push({ json, pairedItem: { item: index } });
            } else if (operation === 'get' || operation === 'getMany') {
              const options = this.getNodeParameter('options', index, {}) as IDataObject;
              const config = readOptions(options);
              let uids: number[];
              if (operation === 'get') uids = [parseUid(this.getNodeParameter('uid', index))];
              else {
                const limit = Number(this.getNodeParameter('limit', index));
                if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Limit must be between 1 and 1000.');
                const found = await client.searchWithFallback(buildSearch(this.getNodeParameter('filters', index, {}) as IDataObject));
                if (!Array.isArray(found)) throw new Error('IMAP server did not return a valid search result.');
                uids = found.sort((a, b) => b - a).slice(0, limit);
              }
              for (const uid of uids) {
                const message = await readMessage(this, client, uid, config);
                if (!message) {
                  if (operation === 'get') throw new Error(`Message UID ${uid} does not exist in ${mailbox}.`);
                  continue;
                }
                if (options.markAsRead) {
                  const marked = await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
                  if (!marked) throw new Error(`Could not mark UID ${uid} as read.`);
                  message.json.flags = [...new Set([...(message.json.flags as string[]), '\\Seen'])];
                }
                message.pairedItem = { item: index };
                results.push(message);
              }
            } else throw new Error(`Unsupported operation: ${operation}`);
          } finally { lock.release(); }
        } catch (error) {
          // Discard a connection after any failed item. Never retry a writing action.
          if (client) await disconnect(client);
          client = undefined;
          const cause = error instanceof Error ? error : new Error(String(error));
          if (!this.continueOnFail()) throw executionError(cause, index);
          results.push({ json: { error: cause.message }, pairedItem: { item: index } });
        }
      }
    } finally { if (client) await disconnect(client); }
    return [results];
  }
}
