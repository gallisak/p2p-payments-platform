export class LedgerRejectedError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class LedgerUnavailableError extends Error {
  constructor(
    message: string,
    readonly retryInMs = 0,
  ) {
    super(message);
  }
}
