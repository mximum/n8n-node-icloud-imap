import type { ICredentialType, INodeProperties } from 'n8n-workflow';

export class ICloudMailImap implements ICredentialType {
  name = 'iCloudMailImap';
  displayName = 'iCloud Mail IMAP';
  documentationUrl = 'https://support.apple.com/en-us/102525';
  properties: INodeProperties[] = [
    {
      displayName: 'IMAP Username', name: 'user', type: 'string', default: '', required: true,
      placeholder: 'your-username or your-username@icloud.com',
      description: 'Your iCloud Mail username. Apple recommends the part before @; use the full iCloud Mail address if needed.',
    },
    {
      displayName: 'App-Specific Password', name: 'password', type: 'string',
      typeOptions: { password: true }, default: '', required: true,
      description: 'Generate at account.apple.com under Sign-In and Security → App-Specific Passwords',
    },
  ];
}
