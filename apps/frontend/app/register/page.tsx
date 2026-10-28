'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { authErrorMessage } from '@/lib/auth-messages';

export default function RegisterPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        throw new Error(await authErrorMessage(res, 'Не вдалося зареєструватись'));
      }
      router.push('/wallets');
    } catch (err) {
      setError(
        err instanceof TypeError
          ? 'Немає зʼєднання з сервером'
          : (err as Error).message,
      );
    }
  }

  return (
    <main style={{ maxWidth: 360, margin: '80px auto' }}>
      <h1>Реєстрація</h1>
      <form onSubmit={onSubmit}>
        <input
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <br />
        <input
          type="password"
          placeholder="Пароль (мін. 8 символів)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <br />
        {error && <p style={{ color: 'crimson' }}>{error}</p>}
        <button type="submit">Зареєструватись</button>
      </form>
    </main>
  );
}
