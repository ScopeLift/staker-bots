import { MONITOR_CONSTANTS } from './constants';
import { EventType } from './constants';

export class MonitorError extends Error {
  constructor(
    message: string,
    public readonly context: Record<string, unknown>,
    public readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = 'MonitorError';
  }
}

export class EventProcessingError extends MonitorError {
  constructor(
    eventType: EventType,
    error: Error,
    context: Record<string, unknown>,
  ) {
    super(
      `Failed to process ${eventType} event: ${error.message}`,
      context,
      true, // Most event processing errors are retryable
    );
    this.name = 'EventProcessingError';
  }
}

export class DatabaseError extends MonitorError {
  constructor(
    operation: string,
    error: Error,
    context: Record<string, unknown>,
  ) {
    super(
      `Database ${operation} failed: ${error.message}`,
      context,
      true, // Database errors are generally retryable
    );
    this.name = 'DatabaseError';
  }
}

export class DepositNotFoundError extends MonitorError {
  constructor(depositId: string) {
    super(
      MONITOR_CONSTANTS.ERRORS.DEPOSIT_NOT_FOUND,
      { depositId },
      false, // Non-existent deposits are not retryable
    );
    this.name = 'DepositNotFoundError';
  }
}
