type JwtSecretName = 'JWT_ACCESS_SECRET' | 'JWT_REFRESH_SECRET';

export function requireJwtSecret(name: JwtSecretName): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set`);
  }
  return value;
}
