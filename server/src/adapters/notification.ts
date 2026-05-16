export type Channel = 'email' | 'slack' | 'chatwork' | 'line_works' | 'messenger';

export interface SendPayload {
  subject?: string;
  body: string;
  raw?: unknown;
}

export interface SendResult {
  externalId?: string;
}

export interface NotificationAdapter {
  readonly channel: Channel;
  send(endpoint: string, payload: SendPayload): Promise<SendResult>;
}

export class NotImplementedNotificationAdapter implements NotificationAdapter {
  constructor(public readonly channel: Channel) {}
  async send(): Promise<SendResult> {
    throw new Error(
      `Notification adapter for channel "${this.channel}" not implemented yet (see spec 03)`,
    );
  }
}

export function getDefaultAdapters(): Record<Channel, NotificationAdapter> {
  return {
    email: new NotImplementedNotificationAdapter('email'),
    slack: new NotImplementedNotificationAdapter('slack'),
    chatwork: new NotImplementedNotificationAdapter('chatwork'),
    line_works: new NotImplementedNotificationAdapter('line_works'),
    messenger: new NotImplementedNotificationAdapter('messenger'),
  };
}
