export interface IcfTelemetryEvent {
  severity: 'INFO' | 'WARN' | 'CRITICAL';
  eventType:
    | 'LOCAL_MODEL_FAILURE'
    | 'LIVE_INFERENCE_UNAVAILABLE'
    | 'WHICHLLM_DEGRADED_CASCADE'
    | 'MODEL_SWEEP_COMPLETE'
    | 'RATE_LIMIT_ADVANCEMENT';
  subsystem: 'TRM' | 'HELIX';
  modelName: string;
  failureStage?:
    | 'DISCOVERY'
    | 'PRE_FLIGHT_CHECK'
    | 'INFERENCE'
    | 'INFERENCE_DISPATCH'
    | 'CONTEXT_OVERFLOW'
    | 'OOM'
    | 'BENCHMARK_SWEEP';
  errorReason: string;
  fallbackTarget?: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface IcfTelemetryReporter {
  report(event: IcfTelemetryEvent): Promise<void> | void;
}

/**
 * In-memory telemetry reporter for unit testing and safe decoupled operation.
 */
export class InMemoryIcfReporter implements IcfTelemetryReporter {
  private readonly events: IcfTelemetryEvent[] = [];

  public report(event: IcfTelemetryEvent): void {
    this.events.push(event);
  }

  public getEvents(): readonly IcfTelemetryEvent[] {
    return this.events;
  }

  public clear(): void {
    this.events.length = 0;
  }

  public findEventsByType(type: IcfTelemetryEvent['eventType']): IcfTelemetryEvent[] {
    return this.events.filter((e) => e.eventType === type);
  }
}

/**
 * Default global telemetry reporter singleton.
 */
let activeReporter: IcfTelemetryReporter = new InMemoryIcfReporter();

export function setIcfTelemetryReporter(reporter: IcfTelemetryReporter): void {
  activeReporter = reporter;
}

export function getIcfTelemetryReporter(): IcfTelemetryReporter {
  return activeReporter;
}

export function reportIcfEvent(event: IcfTelemetryEvent): void {
  activeReporter.report(event);
}
