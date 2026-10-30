const MESSAGES: Record<string, string> = {
  invalid_input: 'Check your email and password (at least 8 characters)',
  invalid_credentials: 'Invalid email or password',
  email_taken: 'This email is already registered',
  too_many_attempts: 'Too many attempts. Try again in a minute',
  unavailable: 'The service is temporarily unavailable. Try again later',
};

export async function authErrorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const { error } = (await res.json()) as { error?: string };
    return error && Object.prototype.hasOwnProperty.call(MESSAGES, error)
      ? MESSAGES[error]
      : fallback;
  } catch {
    return fallback;
  }
}
