/**
 * Base error class for all application errors
 */
export class BaseError extends Error {
  constructor(
    message: string,
    public readonly context: Record<string, unknown>,
    public readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

// -------- Monitor Errors --------

export class MonitorError extends BaseError {
  constructor(
    message: string,
    context: Record<string, unknown>,
    retryable: boolean = false,
  ) {
    super(message, context, retryable);
    this.name = "MonitorError";
  }
}

export class EventProcessingError extends MonitorError {
  constructor(
    eventType: string,
    error: Error,
    context: Record<string, unknown>,
  ) {
    super(
      `Failed to process ${eventType} event: ${error.message}`,
      context,
      true, // Most event processing errors are retryable
    );
    this.name = "EventProcessingError";
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
    this.name = "DatabaseError";
  }
}

export class DepositNotFoundError extends MonitorError {
  constructor(depositId: string) {
    super(
      "Deposit not found",
      { depositId },
      false, // Non-existent deposits are not retryable
    );
    this.name = "DepositNotFoundError";
  }
}

// -------- Executor Errors --------

export class ExecutorError extends Error {
  constructor(
    message: string,
    public readonly details: Record<string, unknown> = {},
    public readonly isRetryable: boolean = true,
  ) {
    super(message);
    this.name = 'ExecutorError';
  }
}

export class TransactionExecutionError extends ExecutorError {
  constructor(
    transactionId: string,
    error: Error,
    context: Record<string, unknown>,
  ) {
    super(
      `Failed to execute transaction ${transactionId}: ${error.message}`,
      context,
      true, // Most transaction errors are retryable
    );
    this.name = "TransactionExecutionError";
  }
}

export class GasEstimationError extends Error {
  constructor(message: string, public readonly details?: unknown) {
    super(message);
    this.name = 'GasEstimationError';
  }
}

export class ContractMethodError extends Error {
  constructor(methodName: string) {
    super(`Contract method ${methodName} not found or invalid`);
    this.name = 'ContractMethodError';
  }
}

export class QueueOperationError extends ExecutorError {
  constructor(
    operation: string,
    error: Error,
    context: Record<string, unknown>,
  ) {
    super(
      `Queue operation ${operation} failed: ${error.message}`,
      context,
      true, // Queue operation errors are generally retryable
    );
    this.name = "QueueOperationError";
  }
}

export class TransactionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransactionValidationError';
  }
}

export class InsufficientBalanceError extends Error {
  constructor(currentBalance: bigint, requiredBalance: bigint) {
    super(
      `Insufficient balance: ${currentBalance.toString()} < ${requiredBalance.toString()}`,
    );
    this.name = 'InsufficientBalanceError';
  }
}

export class TransactionReceiptError extends ExecutorError {
  constructor(transactionHash: string, context: Record<string, unknown>) {
    super(
      `Failed to get valid transaction receipt for ${transactionHash}`,
      context,
      true, // Receipt errors might be temporary network issues
    );
    this.name = "TransactionReceiptError";
  }
}

// -------- Profitability Errors --------

export class ProfitabilityError extends BaseError {
  constructor(
    message: string,
    context: Record<string, unknown>,
    retryable: boolean = false,
  ) {
    super(message, context, retryable);
    this.name = "ProfitabilityError";
  }
}

export class ProfitabilityDepositNotFoundError extends ProfitabilityError {
  constructor(depositId: string) {
    super(
      `Deposit not found: ${depositId}`,
      { depositId },
      false, // Non-existent deposits are not retryable
    );
    this.name = "ProfitabilityDepositNotFoundError";
  }
}

export class InvalidDepositDataError extends ProfitabilityError {
  constructor(deposit: unknown) {
    super(
      "Invalid deposit data received",
      { deposit },
      false, // Data validation errors are not retryable
    );
    this.name = "InvalidDepositDataError";
  }
}

export class ProfitabilityGasEstimationError extends ProfitabilityError {
  constructor(error: Error, context: Record<string, unknown>) {
    super(
      `Profitability gas estimation failed: ${error.message}`,
      context,
      true, // Gas estimation errors are generally retryable
    );
    this.name = "ProfitabilityGasEstimationError";
  }
}

export class QueueProcessingError extends ProfitabilityError {
  constructor(error: Error, context: Record<string, unknown>) {
    super(
      `Queue processing failed: ${error.message}`,
      context,
      true, // Queue processing errors are generally retryable
    );
    this.name = "QueueProcessingError";
  }
}

// Utility functions for error handling
export function isBaseError(error: unknown): error is BaseError {
  return error instanceof BaseError;
}

export function createError(
  error: unknown,
  context: Record<string, unknown> = {},
): BaseError {
  if (isBaseError(error)) return error;

  const message = error instanceof Error ? error.message : String(error);
  return new BaseError(message, context, false);
}

export class SimulationError extends Error {
  constructor(message: string, public readonly details?: unknown) {
    super(message);
    this.name = 'SimulationError';
  }
}

export class TenderlyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenderlyConfigError';
  }
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}
