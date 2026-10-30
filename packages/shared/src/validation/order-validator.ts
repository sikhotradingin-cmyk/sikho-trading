import { InstrumentMetadata } from '../models/instrument.js';
import { PlaceOrderRequest } from '../models/order.js';
import { Money, Paise } from '../models/money.js';

export interface ValidationSuccess {
  isValid: true;
  requiredMarginPaise: Paise;
  estimatedChargesPaise: Paise;
}

export interface ValidationFailure {
  isValid: false;
  errorCode: string;
  errorMessage: string;
}

export type OrderValidationResult = ValidationSuccess | ValidationFailure;

/**
 * Default Intraday Simulation Margin Rates:
 * For Index Futures: 12% of contract value.
 * For Equities: 20% of value.
 */
export const SIMULATED_MARGIN_RATES = {
  FUTIDX: 0.12,
  EQUITY_STOCK: 0.20,
  INDEX_SPOT: 0.0, // Non-tradable
};

export class OrderValidator {
  /**
   * Validate an incoming simulated order request against contract metadata,
   * account balances, and market tick rules.
   */
  public static validate(
    request: PlaceOrderRequest,
    instrument: InstrumentMetadata,
    availableBalancePaise: Paise,
    currentMarketPrice: number
  ): OrderValidationResult {
    // 1. Non-tradable check (e.g. Spot Index prevention)
    if (!instrument.isTradable || instrument.instrumentType === 'INDEX_SPOT') {
      return {
        isValid: false,
        errorCode: 'ERR_SPOT_INDEX_NOT_TRADABLE',
        errorMessage: `Cannot place trade on ${instrument.symbol}. Spot indices are non-tradable reference benchmarks. Practice with listed Futures contracts instead.`,
      };
    }

    // 2. Expiry check
    if (instrument.expiry) {
      const expiryDate = new Date(instrument.expiry).getTime();
      const now = Date.now();
      if (now > expiryDate + 86400000) {
        return {
          isValid: false,
          errorCode: 'ERR_INSTRUMENT_EXPIRED',
          errorMessage: `Contract ${instrument.symbol} expired on ${instrument.expiry}. Select an active expiry.`,
        };
      }
    }

    // 3. Quantity and Lot Size check (Dynamic resolution, never assumed)
    if (request.quantity <= 0) {
      return {
        isValid: false,
        errorCode: 'ERR_INVALID_QUANTITY',
        errorMessage: `Order quantity must be positive. Received: ${request.quantity}`,
      };
    }

    if (request.quantity % instrument.lotSize !== 0) {
      return {
        isValid: false,
        errorCode: 'ERR_INVALID_LOT_MULTIPLE',
        errorMessage: `Quantity ${request.quantity} is not a valid multiple of contract lot size (${instrument.lotSize}). Required lot size: ${instrument.lotSize}.`,
      };
    }

    // 4. Tick Size validation
    const tick = instrument.tickSize || 0.05;
    if (request.requestedPrice !== undefined) {
      if (request.requestedPrice <= 0) {
        return {
          isValid: false,
          errorCode: 'ERR_INVALID_PRICE',
          errorMessage: 'Requested limit price must be strictly greater than zero.',
        };
      }
      if (!this.isAlignedToTick(request.requestedPrice, tick)) {
        return {
          isValid: false,
          errorCode: 'ERR_OFF_TICK_PRICE',
          errorMessage: `Price ${request.requestedPrice} does not align with instrument tick size ${tick}.`,
        };
      }
    }

    if (request.triggerPrice !== undefined) {
      if (request.triggerPrice <= 0) {
        return {
          isValid: false,
          errorCode: 'ERR_INVALID_TRIGGER_PRICE',
          errorMessage: 'Trigger price must be strictly greater than zero.',
        };
      }
      if (!this.isAlignedToTick(request.triggerPrice, tick)) {
        return {
          isValid: false,
          errorCode: 'ERR_OFF_TICK_PRICE',
          errorMessage: `Trigger price ${request.triggerPrice} does not align with instrument tick size ${tick}.`,
        };
      }
    }

    // 5. Order Type specifics
    if (request.orderType === 'LIMIT' && (request.requestedPrice === undefined || request.requestedPrice <= 0)) {
      return {
        isValid: false,
        errorCode: 'ERR_MISSING_LIMIT_PRICE',
        errorMessage: 'Limit orders require a valid requestedPrice.',
      };
    }

    if (request.orderType === 'STOP_MARKET' && (request.triggerPrice === undefined || request.triggerPrice <= 0)) {
      return {
        isValid: false,
        errorCode: 'ERR_MISSING_TRIGGER_PRICE',
        errorMessage: 'Stop-Market orders require a valid triggerPrice.',
      };
    }

    // 6. Margin Calculation & Balance Validation
    const effectivePrice = request.requestedPrice ?? currentMarketPrice;
    if (effectivePrice <= 0) {
      return {
        isValid: false,
        errorCode: 'ERR_NO_VALID_PRICE',
        errorMessage: 'Cannot evaluate margin: market price is zero or unavailable.',
      };
    }

    const contractValueRupees = effectivePrice * request.quantity;
    const marginRate =
      instrument.instrumentType === 'FUTIDX'
        ? SIMULATED_MARGIN_RATES.FUTIDX
        : SIMULATED_MARGIN_RATES.EQUITY_STOCK;

    const requiredMarginRupees = contractValueRupees * marginRate;
    const requiredMarginPaise = Money.fromRupees(requiredMarginRupees);

    // 7. Estimated Simulation Transaction Charges (STT 0.0125%, Exchange 0.0019%, GST 18%, Stamp Duty 0.002%)
    // Total approx 0.02% of turnover
    const estimatedChargesRupees = Math.max(20, contractValueRupees * 0.0002);
    const estimatedChargesPaise = Money.fromRupees(estimatedChargesRupees);

    if (availableBalancePaise < requiredMarginPaise + estimatedChargesPaise) {
      return {
        isValid: false,
        errorCode: 'ERR_INSUFFICIENT_MARGIN',
        errorMessage: `Insufficient margin. Required: ${Money.formatINR(requiredMarginPaise)}, Available: ${Money.formatINR(availableBalancePaise)}.`,
      };
    }

    return {
      isValid: true,
      requiredMarginPaise,
      estimatedChargesPaise,
    };
  }

  private static isAlignedToTick(price: number, tick: number): boolean {
    const ticks = price / tick;
    const rounded = Math.round(ticks);
    return Math.abs(ticks - rounded) < 1e-4;
  }
}
