'use client';

import { ConnectionStatus, useRealtime } from './realtime-provider';
import { Badge } from '@/components/ui/badge';

const VIEW: Record<ConnectionStatus, { text: string; className: string }> = {
  connecting: { text: 'Connecting…', className: 'text-muted-foreground' },
  online: { text: 'Online', className: 'text-success border-success' },
  offline: { text: 'Offline, reconnecting…', className: 'text-warning border-warning' },
};

export function ConnectionBadge() {
  const { status } = useRealtime();
  const { text, className } = VIEW[status];
  return (
    <Badge variant="outline" role="status" className={className}>
      {text}
    </Badge>
  );
}
