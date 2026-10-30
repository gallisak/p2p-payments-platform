'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  const router = useRouter();
  const [retrying, startRetry] = useTransition();

  function retry() {
    startRetry(() => {
      router.refresh();
      reset();
    });
  }

  return (
    <Alert variant="destructive">
      <AlertTitle>Something went wrong</AlertTitle>
      <AlertDescription className="grid gap-3">
        <p>The page could not be loaded. The service may be temporarily unavailable.</p>
        <Button variant="outline" size="sm" className="w-fit" onClick={retry} disabled={retrying}>
          Try again
        </Button>
      </AlertDescription>
    </Alert>
  );
}
