/**
 * Base error class for executor-related errors
 */
export class ExecutorError extends Error {
  constructor(
    message: string,
    public readonly context: Record<string, unknown>,
    public readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = 'ExecutorError';
  }
}

/**
 * Error thrown when transaction execution fails
 */
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
    this.name = 'TransactionExecutionError';
  }
}

/**
 * Error thrown when gas estimation fails
 */
export class GasEstimationError extends ExecutorError {
  constructor(error: Error, context: Record<string, unknown>) {
    super(
      `Gas estimation failed: ${error.message}`,
      context,
      true, // Gas estimation errors are generally retryable
    );
    this.name = 'GasEstimationError';
  }
}

/**
 * Error thrown when contract method validation fails
 */
export class ContractMethodError extends ExecutorError {
  constructor(methodName: string) {
    super(
      `Contract method ${methodName} not found or invalid`,
      { methodName },
      false, // Contract method errors are not retryable
    );
    this.name = 'ContractMethodError';
  }
}

/**
 * Error thrown when transaction queue operations fail
 */
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
    this.name = 'QueueOperationError';
  }
}

/**
 * Error thrown when transaction validation fails
 */
export class TransactionValidationError extends ExecutorError {
  constructor(reason: string, context: Record<string, unknown>) {
    super(
      `Transaction validation failed: ${reason}`,
      context,
      false, // Validation errors are not retryable
    );
    this.name = 'TransactionValidationError';
  }
}

/**
 * Error thrown when wallet/relayer balance is insufficient
 */
export class InsufficientBalanceError extends ExecutorError {
  constructor(currentBalance: bigint, requiredBalance: bigint) {
    super(
      'Insufficient balance for transaction',
      {
        currentBalance: currentBalance.toString(),
        requiredBalance: requiredBalance.toString(),
      },
      true, // Balance errors are retryable once funds are added
    );
    this.name = 'InsufficientBalanceError';
  }
}

/**
 * Error thrown when transaction receipt is invalid or missing
 */
export class TransactionReceiptError extends ExecutorError {
  constructor(transactionHash: string, context: Record<string, unknown>) {
    super(
      `Failed to get valid transaction receipt for ${transactionHash}`,
      context,
      true, // Receipt errors might be temporary network issues
    );
    this.name = 'TransactionReceiptError';
  }
}

/**
 * Type guard for ExecutorError
 */
export function isExecutorError(error: unknown): error is ExecutorError {
  return error instanceof ExecutorError;
}

/**
 * Creates an appropriate executor error based on the error type and context
 */
export function createExecutorError(
  error: unknown,
  context: Record<string, unknown> = {},
): ExecutorError {
  if (isExecutorError(error)) return error;

  const baseMessage = error instanceof Error ? error.message : String(error);
  const baseError = error instanceof Error ? error : new Error(baseMessage);

  // Determine error type based on context and message
  if (context.transactionId) {
    return new TransactionExecutionError(
      context.transactionId as string,
      baseError,
      context,
    );
  }

  if (baseMessage.includes('gas')) {
    return new GasEstimationError(baseError, context);
  }

  if (baseMessage.includes('method')) {
    return new ContractMethodError((context.methodName as string) || 'unknown');
  }

  if (baseMessage.includes('balance')) {
    return new InsufficientBalanceError(
      BigInt((context.currentBalance as string) || '0'),
      BigInt((context.requiredBalance as string) || '0'),
    );
  }

  if (baseMessage.includes('receipt')) {
    return new TransactionReceiptError(
      (context.transactionHash as string) || 'unknown',
      context,
    );
  }

  // Default to base executor error
  return new ExecutorError(baseMessage, context, false);
}
