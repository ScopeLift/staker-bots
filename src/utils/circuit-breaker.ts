import { ConsoleLogger } from '@/monitor/logging'
import { PRODUCTION_CONFIG } from '@/config'

interface CircuitBreakerState {
  isOpen: boolean
  failureCount: number
  lastFailureTime: number
  successCount: number
  totalAttempts: number
}

export class CircuitBreaker {
  private state: CircuitBreakerState
  private readonly logger: ConsoleLogger

  constructor() {
    this.state = {
      isOpen: false,
      failureCount: 0,
      lastFailureTime: 0,
      successCount: 0,
      totalAttempts: 0
    }
    this.logger = new ConsoleLogger('info', {
      color: '\x1b[35m', // Purple
      prefix: '[CircuitBreaker]'
    })
  }

  public async executeWithBreaker<T>(
    operation: () => Promise<T>,
    context: string
  ): Promise<T> {
    if (this.isCircuitOpen()) {
      throw new Error(`Circuit breaker is open for ${context}`)
    }

    try {
      const result = await operation()
      this.recordSuccess()
      return result
    } catch (error) {
      this.recordFailure()
      throw error
    }
  }

  private isCircuitOpen(): boolean {
    if (!this.state.isOpen) return false

    const cooldownElapsed =
      Date.now() - this.state.lastFailureTime > PRODUCTION_CONFIG.circuit_breaker.cooldownPeriod * 1000

    if (cooldownElapsed) {
      this.state.isOpen = false
      this.logger.info('Circuit breaker reset after cooldown')
      return false
    }

    return true
  }

  private recordSuccess(): void {
    this.state.successCount++
    this.state.totalAttempts++

    // Calculate success rate
    const successRate = this.state.successCount / this.state.totalAttempts

    if (successRate >= PRODUCTION_CONFIG.circuit_breaker.minSuccessRate) {
      this.state.isOpen = false
      this.logger.info('Circuit breaker closed due to improved success rate')
    }
  }

  private recordFailure(): void {
    this.state.failureCount++
    this.state.totalAttempts++
    this.state.lastFailureTime = Date.now()

    if (this.state.failureCount >= PRODUCTION_CONFIG.circuit_breaker.maxFailedTransactions) {
      this.state.isOpen = true
      this.logger.warn('Circuit breaker opened due to excessive failures', {
        failureCount: this.state.failureCount,
        totalAttempts: this.state.totalAttempts
      })
    }
  }

  public getState(): CircuitBreakerState {
    return { ...this.state }
  }

  public reset(): void {
    this.state = {
      isOpen: false,
      failureCount: 0,
      lastFailureTime: 0,
      successCount: 0,
      totalAttempts: 0
    }
    this.logger.info('Circuit breaker reset')
  }
}
