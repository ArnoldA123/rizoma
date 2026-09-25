import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Class-name merger used by every UI primitive (the `shadcn/ui` convention):
 * `clsx` for conditional composition, `tailwind-merge` so a caller-supplied
 * Tailwind class always wins over the component default instead of producing
 * two competing utilities.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
