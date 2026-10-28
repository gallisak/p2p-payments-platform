import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { LedgerApiError, ledgerFetch } from '@/lib/api';
import { ACCESS_COOKIE } from '@/lib/session';

interface WalletView {
  id: string;
  currency: string;
  balance: string;
  held: string;
  blocked: boolean;
}

// Server Component: список гаманців вантажиться на сервері при рендері
// сторінки. Наступні оновлення балансу (після додавання переказів) мають
// приходити вже по WebSocket на клієнті — це ще не реалізовано, дивись ТЗ.
export default async function WalletsPage() {
  const token = cookies().get(ACCESS_COOKIE)?.value;
  if (!token) {
    redirect('/login');
  }

  let wallets: WalletView[] = [];
  let loadError: string | null = null;
  let unauthorized = false;

  try {
    wallets = await ledgerFetch('/wallets', {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (err) {
    if (err instanceof LedgerApiError && err.status === 401) {
      unauthorized = true;
    } else {
      loadError = 'Не вдалося завантажити гаманці. Спробуйте пізніше.';
    }
  }
  if (unauthorized) {
    redirect('/login');
  }

  return (
    <main style={{ maxWidth: 480, margin: '80px auto' }}>
      <h1>Мої гаманці</h1>
      {loadError && <p style={{ color: 'crimson' }}>{loadError}</p>}
      {!loadError && wallets.length === 0 && <p>Гаманців поки немає.</p>}
      <ul>
        {wallets.map((w) => (
          <li key={w.id}>
            {w.currency}: {w.balance}
            {w.held !== '0.00' && <> (зарезервовано {w.held})</>}
            {w.blocked && <strong style={{ color: 'crimson' }}> — заблоковано</strong>}
          </li>
        ))}
      </ul>
      <p style={{ color: '#666' }}>
        Форма переказу, split-рахунки та admin-екран ще не реалізовані —
        дивись ТЗ, розділ 4.2.
      </p>
      <form action="/api/auth/logout" method="post">
        <button type="submit">Вийти</button>
      </form>
    </main>
  );
}
