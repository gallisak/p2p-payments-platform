'use client';

import { useFormState } from 'react-dom';
import { FormError } from './form-error';
import { SubmitButton } from './submit-button';
import { CreateResult, createSplitBill } from '@/app/(app)/split-bills/actions';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { CURRENCIES } from '@/lib/types';

const INITIAL: CreateResult = {};

export function SplitBillForm() {
  const [result, action] = useFormState(createSplitBill, INITIAL);
  return (
    <form action={action} className="grid gap-3">
      <div className="grid gap-1.5">
        <Label htmlFor="title">Title</Label>
        <Input id="title" name="title" maxLength={120} required />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="totalAmount">Amount</Label>
          <Input id="totalAmount" name="totalAmount" inputMode="decimal" required />
        </div>
        <div className="grid gap-1.5">
          <Label>Currency</Label>
          <Select name="currency" defaultValue={CURRENCIES[0]}>
            <SelectTrigger aria-label="Currency">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CURRENCIES.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="dueDate">Due date</Label>
        <Input id="dueDate" name="dueDate" type="date" required />
      </div>
      <div className="grid gap-1.5">
        <Label>Split</Label>
        <Select name="split" defaultValue="equal">
          <SelectTrigger aria-label="Split">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="equal">Equally</SelectItem>
            <SelectItem value="custom">Custom amounts</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="participants">Participants: one email per line, for custom amounts “email amount”</Label>
        <Textarea id="participants" name="participants" rows={4} required />
      </div>
      <div className="flex items-center gap-2">
        <Checkbox id="includeCreator" name="includeCreator" />
        <Label htmlFor="includeCreator">I pay my part too</Label>
      </div>
      <SubmitButton>Create bill</SubmitButton>
      {result.error && <FormError>{result.error}</FormError>}
    </form>
  );
}
