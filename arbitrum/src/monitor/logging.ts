/* eslint-disable no-console */
export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export class ConsoleLogger implements Logger {
  constructor(
    private level: 'debug' | 'info' | 'warn' | 'error',
    private options: { color?: string; prefix?: string } = {},
  ) {}

  private shouldLog(messageLevel: string): boolean {
    const levels = ['debug', 'info', 'warn', 'error'];
    return levels.indexOf(messageLevel) >= levels.indexOf(this.level);
  }

  private formatMessage(message: string): string {
    if (!this.options.color && !this.options.prefix) return message;
    const prefix = this.options.prefix ? `${this.options.prefix} ` : '';
    const colorStart = this.options.color || '';
    const colorEnd = this.options.color ? '\x1b[0m' : '';
    return `${colorStart}${prefix}${message}${colorEnd}`;
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    if (this.shouldLog('debug')) {
      console.debug(this.formatMessage(message), meta);
    }
  }

  info(message: string, meta?: Record<string, unknown>): void {
    if (this.shouldLog('info')) {
      console.info(this.formatMessage(message), meta);
    }
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    if (this.shouldLog('warn')) {
      console.warn(this.formatMessage(message), meta);
    }
  }

  error(message: string, meta?: Record<string, unknown>): void {
    if (this.shouldLog('error')) {
      console.error(this.formatMessage(message), meta);
    }
  }
}
