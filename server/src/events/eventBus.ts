import { EventEmitter } from 'events';
import type { DeviceStatus } from '../routes/deviceStatus/deviceStatusSchema.js';
import type { ServerStatus } from '../routes/serverStatus/serverStatusSchema.js';
import type { Side } from '../db/schedulesSchema.js';
import type { Gesture } from '../db/settingsSchema.js';

// One in-process pub/sub bus. Channels are typed so emit/subscribe stay
// honest. The bus does not retain history: late subscribers do not see past
// events. Anything client-visible is also reachable via REST, so SSE/WS reads
// always have a fallback.

export interface JobEventPayload {
  jobName: string;
  status: 'started' | 'ok' | 'fail';
  message?: string;
}

export interface PresenceEventPayload {
  side: Side;
  present: boolean;
}

export interface TapEventPayload {
  side: Side;
  gesture: Gesture;
}

export interface ButtonEventPayload {
  side: Side;
  button: 'top' | 'middle' | 'bottom';
  clicks: number;
  source: 'record' | 'log';
}

export interface EventChannels {
  'device-status': DeviceStatus;
  'job-event': JobEventPayload;
  'service-health': Partial<ServerStatus>;
  presence: PresenceEventPayload;
  tap: TapEventPayload;
  button: ButtonEventPayload;
}

// eslint-disable-next-line @typescript-eslint/no-type-alias
export type EventChannel = keyof EventChannels;

export interface EventEnvelope<C extends EventChannel = EventChannel> {
  channel: C;
  payload: EventChannels[C];
  ts: string;
}

class EventBus {
  // eslint-disable-next-line no-use-before-define
  private static instance: EventBus;
  private emitter = new EventEmitter();
  private clients = 0;

  public static getInstance(): EventBus {
    if (!EventBus.instance) EventBus.instance = new EventBus();
    return EventBus.instance;
  }

  private constructor() {
    this.emitter.setMaxListeners(0);
  }

  public emit<C extends EventChannel>(channel: C, payload: EventChannels[C]): void {
    const env: EventEnvelope<C> = { channel, payload, ts: new Date().toISOString() };
    this.emitter.emit(channel, env);
    this.emitter.emit('*', env);
  }

  public subscribe<C extends EventChannel>(
    channel: C,
    listener: (env: EventEnvelope<C>) => void,
  ): () => void {
    this.emitter.on(channel, listener as (...args: unknown[]) => void);
    return () => this.emitter.off(channel, listener as (...args: unknown[]) => void);
  }

  public subscribeAll(listener: (env: EventEnvelope) => void): () => void {
    this.emitter.on('*', listener as (...args: unknown[]) => void);
    return () => this.emitter.off('*', listener as (...args: unknown[]) => void);
  }

  public registerClient(): void {
    this.clients += 1;
  }

  public unregisterClient(): void {
    this.clients = Math.max(0, this.clients - 1);
  }

  public get clientCount(): number {
    return this.clients;
  }
}

export default EventBus.getInstance();
