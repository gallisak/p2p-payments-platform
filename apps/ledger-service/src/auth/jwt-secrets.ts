type JwtSecretName = 'JWT_ACCESS_SECRET' | 'JWT_REFRESH_SECRET';

// Секрети JWT обов'язкові: запасне значення в коді загальновідоме, і з ним
// будь-хто може підписати собі валідний токен (зокрема з роллю admin).
export function requireJwtSecret(name: JwtSecretName): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set`);
  }
  return value;
}
