import { BaseError } from './errors';
import { DatabaseWrapper } from '@/database/DatabaseWrapper';
import { ErrorLog } from '@/database/interfaces/types';

/**
 * Error severity levels
 */
export enum ErrorSeverity {
  INFO = 'info',
  WARN = 'warn',
  ERROR = 'error',
  FATAL = 'fatal',
}

/**
 * Error logger configuration
 */
export type ErrorLoggerConfig = {
  serviceName: string;
  databaseWrapper?: DatabaseWrapper;
  consoleLog?: boolean;
};

/**
 * Error logger class for logging errors to the database
 */
export class ErrorLogger {
  private readonly serviceName: string;
  private readonly db?: DatabaseWrapper;
  private readonly consoleLog: boolean;

  constructor(config: ErrorLoggerConfig) {
    this.serviceName = config.serviceName;
    this.db = config.databaseWrapper;
    this.consoleLog = config.consoleLog ?? true;
  }

  /**
   * Recursively converts BigInt values to strings for JSON serialization
   */
  private serializeBigInts(obj: unknown): unknown {
    if (obj === null || obj === undefined) {
      return obj;
    }

    if (typeof obj === 'bigint') {
      return obj.toString();
    }

    if (Array.isArray(obj)) {
      return obj.map(item => this.serializeBigInts(item));
    }

    if (typeof obj === 'object') {
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(obj)) {
        result[key] = this.serializeBigInts(value);
      }
      return result;
    }

    return obj;
  }

  /**
   * Log an error to the database and optionally to the console
   */
  async logError(
    error: Error | BaseError | string,
    severity: ErrorSeverity = ErrorSeverity.ERROR,
    meta?: Record<string, unknown>,
  ): Promise<void> {
    try {
      const errorMessage = typeof error === 'string' ? error : error.message;
      const stackTrace = typeof error === 'string' ? undefined : error.stack;

      // Extract context if available (from BaseError)
      const context = error instanceof BaseError ? error.context : undefined;

      // Create error log object with BigInt serialization handling
      const errorLog: ErrorLog = {
        service_name: this.serviceName,
        error_message: errorMessage,
        stack_trace: stackTrace,
        severity,
        meta: this.serializeBigInts(meta) as Record<string, unknown> | undefined,
        context: this.serializeBigInts(context) as Record<string, unknown> | undefined,
      };

      // Log to console if enabled
      if (this.consoleLog) {
        console.error(`[${severity}] ${this.serviceName}: ${errorMessage}`, {
          stack: stackTrace,
          meta,
          context,
        });
      }

      // Log to database if available
      if (this.db) {
        await this.db.createErrorLog(errorLog);
      }
    } catch (logError) {
      // Fallback to console if logging to database fails
      console.error('Failed to log error to database:', logError);
      console.error('Original error:', error);
    }
  }

  /**
   * Log an info-level message
   */
  async info(message: string, meta?: Record<string, unknown>): Promise<void> {
    return this.logError(message, ErrorSeverity.INFO, meta);
  }

  /**
   * Log a warning-level message
   */
  async warn(
    message: string | Error,
    meta?: Record<string, unknown>,
  ): Promise<void> {
    return this.logError(message, ErrorSeverity.WARN, meta);
  }

  /**
   * Log an error-level message
   */
  async error(
    error: Error | string,
    meta?: Record<string, unknown>,
  ): Promise<void> {
    return this.logError(error, ErrorSeverity.ERROR, meta);
  }

  /**
   * Log a fatal-level message
   */
  async fatal(
    error: Error | string,
    meta?: Record<string, unknown>,
  ): Promise<void> {
    return this.logError(error, ErrorSeverity.FATAL, meta);
  }
}

/**
 * Create a simple error logger for a service
 */
export function createErrorLogger(
  serviceName: string,
  databaseWrapper?: DatabaseWrapper,
): ErrorLogger {
  return new ErrorLogger({
    serviceName,
    databaseWrapper,
    consoleLog: true,
  });
}
