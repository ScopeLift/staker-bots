import { ERROR_MESSAGES } from './constants';

export class ProfitabilityError extends Error {
  constructor(
    message: string,
    public readonly context: Record<string, unknown>,
    public readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = 'ProfitabilityError';
  }
}

export class DepositNotFoundError extends ProfitabilityError {
  constructor(depositId: string) {
    super(
      ERROR_MESSAGES.DEPOSIT_NOT_FOUND(depositId),
      { depositId },
      false, // Non-existent deposits are not retryable
    );
    this.name = 'DepositNotFoundError';
  }
}

export class InvalidDepositDataError extends ProfitabilityError {
  constructor(deposit: unknown) {
    super(
      'Invalid deposit data received',
      { deposit },
      false, // Invalid data is not retryable
    );
    this.name = 'InvalidDepositDataError';
  }
}

export class GasEstimationError extends ProfitabilityError {
  constructor(error: Error, context: Record<string, unknown>) {
    super(
      ERROR_MESSAGES.GAS_ESTIMATION_FAILED,
      { ...context, error: error.message },
      true, // Gas estimation errors are generally retryable
    );
    this.name = 'GasEstimationError';
  }
}

export class QueueProcessingError extends ProfitabilityError {
  constructor(error: Error, context: Record<string, unknown>) {
    super(
      ERROR_MESSAGES.QUEUE_PROCESSING_ERROR,
      { ...context, error: error.message },
      true, // Queue processing errors are generally retryable
    );
    this.name = 'QueueProcessingError';
  }
}
