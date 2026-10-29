export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerOptions {
  failureThreshold: number;
  openMs: number;
}

export class CircuitOpenError extends Error {
  constructor(readonly retryInMs: number) {
    super('Circuit breaker is open');
  }
}

export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private trialInFlight = false;
  private current: CircuitState = 'closed';

  constructor(
    private readonly options: CircuitBreakerOptions,
    private readonly now: () => number = Date.now,
  ) {}

  get state(): CircuitState {
    if (this.current === 'open' && this.now() - this.openedAt >= this.options.openMs) {
      this.current = 'half_open';
    }
    return this.current;
  }

  async exec<T>(fn: () => Promise<T>, countsAsFailure: (err: unknown) => boolean): Promise<T> {
    const state = this.state;
    if (state === 'open' || (state === 'half_open' && this.trialInFlight)) {
      throw new CircuitOpenError(this.retryInMs());
    }
    const trial = state === 'half_open';
    if (trial) {
      this.trialInFlight = true;
    }
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      if (countsAsFailure(err)) {
        this.onFailure(trial);
      } else {
        this.onSuccess();
      }
      throw err;
    } finally {
      if (trial) {
        this.trialInFlight = false;
      }
    }
  }

  private retryInMs(): number {
    if (this.current !== 'open') {
      return 0;
    }
    return Math.max(0, this.options.openMs - (this.now() - this.openedAt));
  }

  private onSuccess(): void {
    this.failures = 0;
    this.current = 'closed';
  }

  private onFailure(trial: boolean): void {
    this.failures += 1;
    if (trial || this.failures >= this.options.failureThreshold) {
      this.current = 'open';
      this.openedAt = this.now();
    }
  }
}
