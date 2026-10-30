export interface TokenClaims {
  sub?: string;
  email?: string;
  role?: string;
  exp?: number;
}

export function claimsOf(token: string): TokenClaims | null {
  try {
    const encoded = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(encoded)) as TokenClaims;
  } catch {
    return null;
  }
}

export function secondsUntilExpiry(token: string): number | undefined {
  const exp = claimsOf(token)?.exp;
  return typeof exp === 'number' ? Math.max(0, exp - Math.floor(Date.now() / 1000)) : undefined;
}
