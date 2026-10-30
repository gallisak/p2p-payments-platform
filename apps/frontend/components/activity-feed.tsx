'use client';

import { useState } from 'react';
import { FormError } from './form-error';
import { useRealtime } from './realtime-provider';
import { Amount, Empty, Row, RowList } from './row-list';
import { Button } from '@/components/ui/button';
import { ACTIVITY_LABELS, activityAmount, activityDetail, formatTime } from '@/lib/activity-text';
import { ActivityItem, ActivityPage } from '@/lib/types';

interface Props {
  initial: ActivityPage;
  type?: string;
  pageable?: boolean;
}

export function ActivityFeed({ initial, type, pageable = false }: Props) {
  const { activity: live } = useRealtime();
  const [older, setOlder] = useState<ActivityItem[]>([]);
  const [cursor, setCursor] = useState(initial.nextCursor);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const merged = new Map(
    [...live.filter((a) => !type || a.type === type), ...initial.items, ...older].map((a) => [a.id, a]),
  );
  const items = [...merged.values()].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));

  async function loadMore() {
    if (!cursor) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams({ cursor, ...(type ? { type } : {}) });
      const res = await fetch(`/api/activity?${query}`, { cache: 'no-store' });
      if (!res.ok) {
        throw new Error();
      }
      const page = (await res.json()) as ActivityPage;
      setOlder((items) => [...items, ...page.items]);
      setCursor(page.nextCursor);
    } catch {
      setError('Could not load more. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  if (items.length === 0) {
    return <Empty>No events yet.</Empty>;
  }
  return (
    <>
      <RowList>
        {items.map((item) => (
          <Row key={item.id}>
            <span>
              {ACTIVITY_LABELS[item.type] ?? item.type}
              {activityDetail(item) && <span className="text-muted-foreground"> — {activityDetail(item)}</span>}
              <span className="block text-muted-foreground">{formatTime(item.occurredAt)}</span>
            </span>
            <Amount>{activityAmount(item)}</Amount>
          </Row>
        ))}
      </RowList>
      {pageable && cursor && (
        <Button variant="outline" size="sm" className="w-fit" onClick={loadMore} disabled={loading}>
          {loading ? 'Loading…' : 'Show more'}
        </Button>
      )}
      {error && <FormError>{error}</FormError>}
    </>
  );
}
