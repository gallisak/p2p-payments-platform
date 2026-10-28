export const MAX_OPERATION_AMOUNT = 1_000_000;

export const SUPPORTED_CURRENCIES = ['USD', 'EUR', 'UAH'] as const;

export type Currency = (typeof SUPPORTED_CURRENCIES)[number];
