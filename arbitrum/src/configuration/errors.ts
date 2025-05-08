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

export class ExecutorError extends BaseError {
  constructor(
    message: string,
    context: Record<string, unknown>,
    retryable: boolean = false,
  ) {
    super(message, context, retryable);
    this.name = "ExecutorError";
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

export class GasEstimationError extends ExecutorError {
  constructor(error: Error, context: Record<string, unknown>) {
    super(
      `Gas estimation failed: ${error.message}`,
      context,
      true, // Gas estimation errors are generally retryable
    );
    this.name = "GasEstimationError";
  }
}

export class ContractMethodError extends ExecutorError {
  constructor(methodName: string) {
    super(
      `Contract method ${methodName} not found or invalid`,
      { methodName },
      false, // Contract method errors are not retryable
    );
    this.name = "ContractMethodError";
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

export class TransactionValidationError extends ExecutorError {
  constructor(reason: string, context: Record<string, unknown>) {
    super(
      `Transaction validation failed: ${reason}`,
      context,
      false, // Validation errors are not retryable
    );
    this.name = "TransactionValidationError";
  }
}

export class InsufficientBalanceError extends ExecutorError {
  constructor(currentBalance: bigint, requiredBalance: bigint) {
    super(
      "Insufficient gas balance for transaction, top up your wallet",
      {
        currentBalance: currentBalance.toString(),
        requiredBalance: requiredBalance.toString(),
      },
      true, // Balance errors are retryable once funds are added
    );
    this.name = "InsufficientBalanceError";
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
