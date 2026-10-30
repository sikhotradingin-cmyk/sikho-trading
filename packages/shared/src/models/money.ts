/**
 * High-precision monetary arithmetic based on integer Paise (1 INR = 100 Paise).
 * Eliminates IEEE-754 floating-point rounding errors in financial balances and ledgers.
 */

export type Paise = bigint;

export class Money {
  /**
   * Convert an INR decimal number or string to integer Paise.
   * e.g., 24500.50 -> 2450050n
   */
  public static fromRupees(rupees: number | string): Paise {
    if (typeof rupees === 'number') {
      if (!Number.isFinite(rupees)) {
        throw new Error(`Invalid non-finite rupees value: ${rupees}`);
      }
      // Fixed to 2 decimal places to eliminate float inaccuracy before parsing
      const fixedStr = rupees.toFixed(2);
      return this.fromRupeesString(fixedStr);
    }
    return this.fromRupeesString(rupees);
  }

  private static fromRupeesString(val: string): Paise {
    const trimmed = val.trim();
    const parts = trimmed.split('.');
    if (parts.length > 2) {
      throw new Error(`Invalid rupee format: ${val}`);
    }
    const whole = BigInt(parts[0] || '0');
    let fraction = 0n;
    if (parts.length === 2) {
      const fracStr = (parts[1] + '00').slice(0, 2);
      fraction = BigInt(fracStr);
    }
    const isNegative = trimmed.startsWith('-');
    if (isNegative && whole === 0n) {
      return -fraction;
    }
    return isNegative ? whole * 100n - fraction : whole * 100n + fraction;
  }

  /**
   * Convert integer Paise back to an INR float (for display only).
   */
  public static toRupees(paise: Paise): number {
    return Number(paise) / 100;
  }

  /**
   * Format integer Paise to an Indian currency display string (e.g., "₹1,00,000.00").
   */
  public static formatINR(paise: Paise): string {
    const sign = paise < 0n ? '-' : '';
    const abs = paise < 0n ? -paise : paise;
    const whole = (abs / 100n).toString();
    const fraction = (abs % 100n).toString().padStart(2, '0');

    // Indian numbering format: last 3 digits, then groups of 2
    let lastThree = whole.slice(-3);
    const otherNumbers = whole.slice(0, -3);
    if (otherNumbers !== '') {
      lastThree = ',' + lastThree;
    }
    const formattedWhole = otherNumbers.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + lastThree;

    return `${sign}₹${formattedWhole}.${fraction}`;
  }

  /**
   * Safe multiplication of integer paise with a decimal multiplier (e.g. quantity or fee percentage)
   * with explicit rounding mode (ROUND_HALF_UP).
   */
  public static multiply(paise: Paise, multiplier: number): Paise {
    // scale multiplier to 6 decimal places as integer
    const scale = 1_000_000n;
    const multInt = BigInt(Math.round(multiplier * 1_000_000));
    const raw = paise * multInt;
    // Round half up
    const remainder = raw % scale;
    const quotient = raw / scale;
    if (remainder >= scale / 2n) {
      return quotient + 1n;
    } else if (remainder <= -scale / 2n) {
      return quotient - 1n;
    }
    return quotient;
  }
}
