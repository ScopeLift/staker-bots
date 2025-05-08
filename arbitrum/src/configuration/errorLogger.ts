/**
 * Interface for error logging services
 */
export interface ErrorLogger {
  /**
   * Log an error to the error logging service
   * @param error - The error object to log
   * @param metadata - Additional metadata to include with the error
   */
  error(error: Error, metadata: Record<string, unknown>): Promise<void>;
}

/**
 * Console implementation of ErrorLogger
 * Logs errors to the console with formatted output
 */
export class ConsoleErrorLogger implements ErrorLogger {
  constructor(
    private readonly options: {
      appName?: string;
      environment?: string;
    } = {},
  ) {}

  /**
   * Log an error to the console
   * @param error - The error object to log
   * @param metadata - Additional metadata to include with the error
   */
  async error(
    error: Error,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    console.error(
      `[ERROR] ${this.options.appName || "APP"}:${this.options.environment || "dev"}`,
      {
        name: error.name,
        message: error.message,
        stack: error.stack,
        ...metadata,
      },
    );
  }
}

/**
 * Factory function to create an appropriate error logger
 * @param options - Options for configuring the error logger
 * @returns An error logger instance
 */
export function createErrorLogger(
  options: {
    type?: "console";
    appName?: string;
    environment?: string;
  } = {},
): ErrorLogger {
  const { type = "console", appName, environment } = options;

  switch (type) {
    case "console":
    default:
      return new ConsoleErrorLogger({ appName, environment });
  }
}
