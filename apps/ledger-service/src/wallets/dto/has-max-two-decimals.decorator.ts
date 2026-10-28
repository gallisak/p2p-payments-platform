import { ValidateBy, ValidationOptions, buildMessage } from 'class-validator';

// Не більше 2 знаків після коми. Вбудований IsNumber({ maxDecimalPlaces })
// рахує знаки через toString().split('.') і падає з TypeError на числах в
// експоненційному записі (1e-7 → "1e-7"), що дає 500 замість 400.
// Ділення в JS округлюється коректно, тож для будь-якої суми з ≤ 2 знаками
// Math.round(v * 100) / 100 повертає те саме число, а для решти — інше.
export function hasMaxTwoDecimals(value: unknown): boolean {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Math.round(value * 100) / 100 === value
  );
}

export function HasMaxTwoDecimals(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return ValidateBy(
    {
      name: 'hasMaxTwoDecimals',
      validator: {
        validate: (value) => hasMaxTwoDecimals(value),
        defaultMessage: buildMessage(
          (eachPrefix) =>
            `${eachPrefix}$property must have at most 2 decimal places`,
          validationOptions,
        ),
      },
    },
    validationOptions,
  );
}
