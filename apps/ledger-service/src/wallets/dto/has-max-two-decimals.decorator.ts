import { ValidateBy, ValidationOptions, buildMessage } from 'class-validator';

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
