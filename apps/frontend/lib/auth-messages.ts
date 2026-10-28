const MESSAGES: Record<string, string> = {
  invalid_input: 'Перевірте email і пароль (пароль — від 8 символів)',
  invalid_credentials: 'Невірний email або пароль',
  email_taken: 'Цей email уже зареєстровано',
  too_many_attempts: 'Забагато спроб. Спробуйте за хвилину',
  unavailable: 'Сервіс тимчасово недоступний. Спробуйте пізніше',
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
