import type { INodeProperties } from 'n8n-workflow';

export const mailboxProperty: INodeProperties = {
  displayName: 'Mailbox Name or ID', name: 'mailbox', type: 'options',
  typeOptions: { loadOptionsMethod: 'getMailboxes' }, default: 'INBOX', required: true,
  description: 'Choose a mailbox from the list, or specify its exact path using an expression',
};

export const readOptionFields: INodeProperties[] = [
  { displayName: 'Headers Only', name: 'headersOnly', type: 'boolean', default: false,
    description: 'Whether to return metadata and all message headers without downloading the body or attachments' },
  { displayName: 'Download Attachments', name: 'downloadAttachments', type: 'boolean', default: false,
    description: 'Whether to expose attachments as n8n binary properties named attachment_0, attachment_1, etc.' },
  { displayName: 'Maximum Message Size (MB)', name: 'maxMessageSizeMB', type: 'number', default: 25,
    typeOptions: { minValue: 1, maxValue: 100, numberPrecision: 0 },
    description: 'Larger messages return metadata with bodySkipped=true, so the trigger can continue' },
];

export const searchFields: INodeProperties[] = [
  { displayName: 'Unread Only', name: 'unreadOnly', type: 'boolean', default: false },
  { displayName: 'From Contains', name: 'from', type: 'string', default: '' },
  { displayName: 'To Contains', name: 'to', type: 'string', default: '' },
  { displayName: 'Subject Contains', name: 'subject', type: 'string', default: '' },
  { displayName: 'Text Contains', name: 'text', type: 'string', default: '' },
  { displayName: 'Received Since', name: 'since', type: 'dateTime', default: '',
    description: 'Inclusive date, using IMAP day precision' },
  { displayName: 'Received Before', name: 'before', type: 'dateTime', default: '',
    description: 'Exclusive date, using IMAP day precision' },
];

export function readOptions(value: Record<string, unknown>) {
  const size = Number(value.maxMessageSizeMB ?? 25);
  if (!Number.isFinite(size) || size < 1 || size > 100) throw new Error('Maximum message size must be between 1 and 100 MB.');
  return { headersOnly: Boolean(value.headersOnly), downloadAttachments: Boolean(value.downloadAttachments), maxMessageSizeMB: size };
}
