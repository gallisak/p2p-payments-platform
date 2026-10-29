type OriginCallback = (err: Error | null, allow?: boolean) => void;

export function allowedOrigins(): string[] {
  return (process.env.CORS_ORIGINS ?? 'http://localhost:3000')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export function corsOrigin(origin: string | undefined, callback: OriginCallback): void {
  callback(null, !origin || allowedOrigins().includes(origin));
}
