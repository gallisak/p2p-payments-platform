export function RowList({ children }: { children: React.ReactNode }) {
  return <ul className="divide-y">{children}</ul>;
}

export function Row({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 py-2 text-sm first:pt-0 last:pb-0 [overflow-wrap:anywhere]">
      {children}
    </li>
  );
}

export function Amount({ children }: { children: React.ReactNode }) {
  return <span className="font-semibold tabular-nums">{children}</span>;
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}
