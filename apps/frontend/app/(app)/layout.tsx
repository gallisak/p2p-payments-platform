import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { currentUser } from '@/lib/server-api';

const LINKS = [
  { href: '/dashboard', label: 'Overview' },
  { href: '/wallets', label: 'Wallets' },
];

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const user = currentUser();
  return (
    <>
      <header className="border-b bg-card">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
          <Link href="/dashboard" className="font-semibold">
            P2P Ledger
          </Link>
          <nav aria-label="Main" className="flex flex-1 flex-wrap items-center">
            {LINKS.map((link) => (
              <Button key={link.href} variant="ghost" size="sm" asChild>
                <Link href={link.href}>{link.label}</Link>
              </Button>
            ))}
          </nav>
          <span className="max-w-full truncate text-sm text-muted-foreground">{user?.email}</span>
          <form action="/api/auth/logout" method="post">
            <Button type="submit" variant="outline" size="sm">
              Sign out
            </Button>
          </form>
        </div>
      </header>
      <main className="mx-auto grid max-w-5xl gap-4 px-4 py-6">{children}</main>
    </>
  );
}
