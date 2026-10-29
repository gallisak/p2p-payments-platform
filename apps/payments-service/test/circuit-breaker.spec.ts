import { CircuitBreaker, CircuitOpenError } from '../src/ledger/circuit-breaker';

describe('CircuitBreaker', () => {
  let now = 0;
  const breaker = () => new CircuitBreaker({ failureThreshold: 3, openMs: 1_000 }, () => now);
  const fail = () => Promise.reject(new Error('down'));
  const ok = () => Promise.resolve('ok');
  const always = () => true;

  beforeEach(() => {
    now = 0;
  });

  async function trip(b: CircuitBreaker) {
    for (let i = 0; i < 3; i++) {
      await expect(b.exec(fail, always)).rejects.toThrow('down');
    }
  }

  it('opens after consecutive failures and fails fast while open', async () => {
    const b = breaker();
    await trip(b);
    expect(b.state).toBe('open');

    const call = jest.fn(ok);
    now = 400;
    const err = await b.exec(call, always).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CircuitOpenError);
    expect((err as CircuitOpenError).retryInMs).toBe(600);
    expect(call).not.toHaveBeenCalled();
  });

  it('resets the failure count after a success', async () => {
    const b = breaker();
    await expect(b.exec(fail, always)).rejects.toThrow();
    await expect(b.exec(fail, always)).rejects.toThrow();
    await b.exec(ok, always);
    await expect(b.exec(fail, always)).rejects.toThrow();

    expect(b.state).toBe('closed');
  });

  it('does not count failures that the caller does not treat as outages', async () => {
    const b = breaker();
    for (let i = 0; i < 5; i++) {
      await expect(b.exec(fail, () => false)).rejects.toThrow('down');
    }
    expect(b.state).toBe('closed');
  });

  it('lets a single trial call through after the open period and closes on success', async () => {
    const b = breaker();
    await trip(b);
    now = 1_000;
    expect(b.state).toBe('half_open');

    let finish: (v: string) => void = () => undefined;
    const trial = b.exec(() => new Promise<string>((resolve) => (finish = resolve)), always);
    await expect(b.exec(ok, always)).rejects.toBeInstanceOf(CircuitOpenError);
    finish('ok');

    await expect(trial).resolves.toBe('ok');
    expect(b.state).toBe('closed');
  });

  it('reopens when the trial call fails', async () => {
    const b = breaker();
    await trip(b);
    now = 1_500;

    await expect(b.exec(fail, always)).rejects.toThrow('down');

    expect(b.state).toBe('open');
    now = 2_000;
    expect(b.state).toBe('open');
    now = 2_500;
    expect(b.state).toBe('half_open');
  });
});
