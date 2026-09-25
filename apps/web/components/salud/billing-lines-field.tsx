'use client';

import {
  BILLING_DESCRIPTION_MAX,
  checkQuantityField,
  checkRequiredText,
  checkUnitPriceField,
  firstIssue,
  type BillingLine,
  type DraftIssue,
  type FieldCheck,
} from '@rizoma/contracts';
import { Button } from '@/components/ui/button';
import { FieldMessage, fieldStateProps } from '@/components/ui/field-feedback';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/**
 * Line editor shared by the quote and the invoice forms.
 *
 * Why one component for both: a quote line and an invoice line are the same
 * shape (`{description, quantity, unitPrice}`) and the same rule
 * (`parseLines` in `billing.service.ts`). Duplicating the editor would let the
 * two forms drift apart on the only thing they have to agree on.
 *
 * Two deliberate properties:
 *   - the draft keeps *strings*, because that is what a user types and what the
 *     live validation reads; the conversion to numbers happens once, at submit,
 *     and only after every field passed its check;
 *   - no total is computed here. The service prices a quote when `total` is
 *     omitted and always prices an invoice from the per-line IGV rule, so the
 *     form never has a number to disagree with the printed document about.
 */
export interface BillingLineDraft {
  readonly id: string;
  readonly description: string;
  readonly quantity: string;
  readonly unitPrice: string;
}

/** One empty line, ready for a form's initial state. */
export function newBillingLineDraft(seed?: Partial<Omit<BillingLineDraft, 'id'>>): BillingLineDraft {
  return {
    id: globalThis.crypto.randomUUID(),
    description: seed?.description ?? '',
    quantity: seed?.quantity ?? '1',
    unitPrice: seed?.unitPrice ?? '',
  };
}

/** Live check of one line description. */
export function lineDescriptionIssue(line: BillingLineDraft, index: number): FieldCheck {
  return checkRequiredText(`items[${index}].description`, line.description, BILLING_DESCRIPTION_MAX);
}

/** Live check of one line quantity. */
export function lineQuantityIssue(line: BillingLineDraft, index: number): FieldCheck {
  return checkQuantityField(`items[${index}].quantity`, line.quantity);
}

/** Live check of one line unit price. */
export function lineUnitPriceIssue(line: BillingLineDraft, index: number): FieldCheck {
  return checkUnitPriceField(`items[${index}].unitPrice`, line.unitPrice);
}

/** First blocking issue of the whole line list, or `null` when it is clean. */
export function firstLineIssue(lines: readonly BillingLineDraft[]): DraftIssue | null {
  return firstIssue(lineChecks(lines));
}

/** Every line check, keyed by field, for the form-level aggregation. */
export function lineChecks(
  lines: readonly BillingLineDraft[],
): Readonly<Record<string, FieldCheck>> {
  const checks: Record<string, FieldCheck> = {};
  lines.forEach((line, index) => {
    checks[`items[${index}].description`] = lineDescriptionIssue(line, index);
    checks[`items[${index}].quantity`] = lineQuantityIssue(line, index);
    checks[`items[${index}].unitPrice`] = lineUnitPriceIssue(line, index);
  });
  return checks;
}

/**
 * Converts the drafts into the `items` array of the request body. Only call it
 * after {@link firstLineIssue} returned `null`: a non-numeric draft would
 * otherwise travel as `NaN` and the API would refuse the whole document.
 */
export function toBillingLines(lines: readonly BillingLineDraft[]): BillingLine[] {
  return lines.map((line) => ({
    description: line.description.trim(),
    quantity: Number(line.quantity),
    unitPrice: Number(line.unitPrice),
  }));
}

export interface BillingLinesFieldProps {
  readonly lines: readonly BillingLineDraft[];
  readonly onChange: (lines: readonly BillingLineDraft[]) => void;
  /** Whether the per-field verdicts are shown (touched or submitted once). */
  readonly touched: boolean;
  readonly disabled?: boolean;
  readonly className?: string;
}

export function BillingLinesField({
  lines,
  onChange,
  touched,
  disabled = false,
  className,
}: BillingLinesFieldProps) {
  function replace(index: number, patch: Partial<BillingLineDraft>): void {
    onChange(lines.map((line, position) => (position === index ? { ...line, ...patch } : line)));
  }

  return (
    <div className={cn('flex flex-col gap-4', className)}>
      {lines.map((line, index) => {
        const description = lineDescriptionIssue(line, index);
        const quantity = lineQuantityIssue(line, index);
        const unitPrice = lineUnitPriceIssue(line, index);
        // The DOM ids are index-based and the React key is the draft's random
        // uuid: a random id would be regenerated during hydration and mismatch
        // the server markup, while a key never reaches the DOM.
        const domId = `line-${index}`;
        return (
          <div
            key={line.id}
            className="flex flex-col gap-3 rounded-md border border-border bg-secondary p-3.5"
          >
            <div className="flex items-center justify-between gap-3">
              <span className="text-[0.6875rem] font-medium tracking-[0.09em] text-muted-foreground uppercase">
                Línea {index + 1}
              </span>
              {lines.length > 1 ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={disabled}
                  onClick={() => onChange(lines.filter((_, position) => position !== index))}
                >
                  Quitar
                </Button>
              ) : null}
            </div>

            <div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_repeat(2,minmax(0,1fr))]">
              <div className="flex flex-col gap-1.5">
                <label htmlFor={`${domId}-description`} className="text-xs font-medium">
                  Descripción
                </label>
                <Input
                  id={`${domId}-description`}
                  value={line.description}
                  maxLength={BILLING_DESCRIPTION_MAX}
                  disabled={disabled}
                  placeholder="Consulta médica"
                  onChange={(event) => replace(index, { description: event.target.value })}
                  {...fieldStateProps(description, touched)}
                />
                <FieldMessage issue={description} touched={touched} />
              </div>

              <div className="flex flex-col gap-1.5">
                <label htmlFor={`${domId}-quantity`} className="text-xs font-medium">
                  Cantidad
                </label>
                <Input
                  id={`${domId}-quantity`}
                  inputMode="decimal"
                  value={line.quantity}
                  disabled={disabled}
                  onChange={(event) => replace(index, { quantity: event.target.value })}
                  {...fieldStateProps(quantity, touched)}
                />
                <FieldMessage issue={quantity} touched={touched} />
              </div>

              <div className="flex flex-col gap-1.5">
                <label htmlFor={`${domId}-unit-price`} className="text-xs font-medium">
                  Precio unitario
                </label>
                <Input
                  id={`${domId}-unit-price`}
                  inputMode="decimal"
                  value={line.unitPrice}
                  disabled={disabled}
                  placeholder="0.00"
                  onChange={(event) => replace(index, { unitPrice: event.target.value })}
                  {...fieldStateProps(unitPrice, touched)}
                />
                <FieldMessage issue={unitPrice} touched={touched} />
              </div>
            </div>
          </div>
        );
      })}

      <Button
        variant="outline"
        size="sm"
        className="self-start"
        disabled={disabled}
        onClick={() => onChange([...lines, newBillingLineDraft()])}
      >
        Añadir línea
      </Button>
    </div>
  );
}
