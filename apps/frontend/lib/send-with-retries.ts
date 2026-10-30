const RETRY_DELAYS_MS = [500, 1_500, 3_000];
const RETRYABLE = new Set([502, 503, 504]);

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function sendWithRetries(url: string, idempotencyKey: string, body: object): Promise<Response> {
  const attempt = () =>
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(body),
    });
  for (const delay of RETRY_DELAYS_MS) {
    try {
      const res = await attempt();
      if (!RETRYABLE.has(res.status)) {
        return res;
      }
    } catch {
    }
    await wait(delay);
  }
  return attempt();
}

export async function failureMessage(res: Response, fallback: string): Promise<string> {
  if (res.status === 429) {
    const seconds = res.headers.get('Retry-After');
    return seconds ? `Too many requests. Try again in ${seconds} s` : 'Too many requests. Try again later';
  }
  try {
    const { message } = (await res.json()) as { message?: string | string[] };
    return (Array.isArray(message) ? message.join('; ') : message) ?? fallback;
  } catch {
    return fallback;
  }
}
