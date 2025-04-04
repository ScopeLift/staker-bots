import { GOVLST_CONSTANTS } from './constants';

// -------- Base Error Classes --------

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
    this.name = 'MonitorError';
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
      'Deposit not found',
      { depositId },
      false, // Non-existent deposits are not retryable
    );
    this.name = 'DepositNotFoundError';
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
    this.name = 'TransactionExecutionError';
  }
}

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

export class InsufficientBalanceError extends ExecutorError {
  constructor(currentBalance: bigint, requiredBalance: bigint) {
    super(
      'Insufficient gas balance for transaction, top up your wallet',
      {
        currentBalance: currentBalance.toString(),
        requiredBalance: requiredBalance.toString(),
      },
      true, // Balance errors are retryable once funds are added
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
    this.name = 'TransactionReceiptError';
  }
}

// Utility functions for Executor errors
export function isExecutorError(error: unknown): error is ExecutorError {
  return error instanceof ExecutorError;
}

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

// -------- Profitability Errors --------

export class ProfitabilityError extends BaseError {
  constructor(
    message: string,
    context: Record<string, unknown>,
    retryable: boolean = false,
  ) {
    super(message, context, retryable);
    this.name = 'ProfitabilityError';
  }
}

export class ProfitabilityDepositNotFoundError extends ProfitabilityError {
  constructor(depositId: string) {
    super(
      `Deposit not found: ${depositId}`,
      { depositId },
      false, // Non-existent deposits are not retryable
    );
    this.name = 'ProfitabilityDepositNotFoundError';
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

export class ProfitabilityGasEstimationError extends ProfitabilityError {
  constructor(error: Error, context: Record<string, unknown>) {
    super(
      'Gas estimation failed for profitability calculation',
      { ...context, error: error.message },
      true, // Gas estimation errors are generally retryable
    );
    this.name = 'ProfitabilityGasEstimationError';
  }
}

export class QueueProcessingError extends ProfitabilityError {
  constructor(error: Error, context: Record<string, unknown>) {
    super(
      'Queue processing error in profitability engine',
      { ...context, error: error.message },
      true, // Queue processing errors are generally retryable
    );
    this.name = 'QueueProcessingError';
  }
}

// -------- GovLst Errors --------

export class GovLstError extends BaseError {
  constructor(
    message: string,
    context: Record<string, unknown>,
    retryable: boolean = false,
  ) {
    super(message, context, retryable);
    this.name = 'GovLstError';
  }
}

export class RewardCalculationError extends GovLstError {
  constructor(error: Error, context: Record<string, unknown>) {
    super(
      `Failed to calculate rewards: ${error.message}`,
      context,
      true, // Most reward calculation errors are retryable
    );
    this.name = 'RewardCalculationError';
  }
}

export class ClaimExecutionError extends GovLstError {
  constructor(
    depositId: string,
    error: Error,
    context: Record<string, unknown>,
  ) {
    super(
      `Failed to execute claim for deposit ${depositId}: ${error.message}`,
      context,
      true, // Claim execution errors are generally retryable
    );
    this.name = 'ClaimExecutionError';
  }
}

export class BatchOptimizationError extends GovLstError {
  constructor(error: Error, context: Record<string, unknown>) {
    super(
      `Batch optimization failed: ${error.message}`,
      context,
      false, // Batch optimization errors are generally not retryable
    );
    this.name = 'BatchOptimizationError';
  }
}

// Error message constants
export const ERROR_MESSAGES = {
  MONITOR: {
    DEPOSIT_NOT_FOUND: 'Deposit not found',
    EVENT_PROCESSING_FAILED: 'Failed to process event',
    DATABASE_OPERATION_FAILED: 'Database operation failed',
  },
  EXECUTOR: {
    TRANSACTION_EXECUTION_FAILED: 'Transaction execution failed',
    GAS_ESTIMATION_FAILED: 'Gas estimation failed',
    CONTRACT_METHOD_INVALID: 'Contract method not found or invalid',
    QUEUE_OPERATION_FAILED: 'Queue operation failed',
    TRANSACTION_VALIDATION_FAILED: 'Transaction validation failed',
    INSUFFICIENT_BALANCE: 'Insufficient balance for transaction',
    TRANSACTION_RECEIPT_INVALID: 'Failed to get valid transaction receipt',
  },
  PROFITABILITY: {
    DEPOSIT_NOT_FOUND: (depositId: string) => `Deposit not found: ${depositId}`,
    INVALID_DEPOSIT_DATA: 'Invalid deposit data received',
    GAS_ESTIMATION_FAILED:
      'Gas estimation failed for profitability calculation',
    QUEUE_PROCESSING_ERROR: 'Queue processing error in profitability engine',
  },
  GOVLST: {
    REWARD_CALCULATION_FAILED: 'Failed to calculate rewards',
    CLAIM_EXECUTION_FAILED: 'Failed to execute claim',
    BATCH_OPTIMIZATION_FAILED: 'Batch optimization failed',
    INSUFFICIENT_EARNING_POWER: `Earning power is below minimum threshold of ${GOVLST_CONSTANTS.MIN_QUALIFYING_EARNING_POWER_BIPS_CAP} bips`,
  },
} as const;
