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
 * SIMULATED EDUCATIONAL MARGIN RATES (SIMULATION ASSUMPTION):
 * Note: These are simplified educational simulation parameters for paper trading practice,
 * not official exchange SPAN/Exposure margin requirements.
 * - Index Futures: 12% of contract value (~8.3x leverage).
 * - Stock Futures: 20% of contract value (5x leverage).
 * - Equity Intraday: 20% of contract value (5x leverage).
 * - Equity Delivery: 100% full cash payment (1x cash delivery, no margin loan).
 * - Option Buy: 100% premium paid upfront.
 * - Option Sell (Short): 100% premium + 15% underlying strike notional collateral.
 */
export const SIMULATED_MARGIN_RATES = {
  FUTIDX: 0.12,
  FUTSTK: 0.20,
  FUTCOM: 0.05, // 5% educational margin for MCX Commodity Futures
  EQUITY_STOCK: 0.20,
  EQUITY_DELIVERY: 1.0,
  OPTION_BUY: 1.0,
  OPTION_SHORT_UNDERLYING: 0.15,
  INDEX_SPOT: 0.0, // Non-tradable
};

export const SIMULATION_ASSUMPTIONS_DISCLAIMER =
  'Simulation Assumption: Margins and charges are computed using fixed educational baseline models (e.g. 20% intraday equity, 12% index futures, 100% option premium, ~0.02% estimated transaction charges) for risk-free paper trading practice, and do not represent exchange SPAN or real broker tariff schedules.';

export interface OrderValidationOptions {
  existingPositionQuantity?: number;
  existingDeliveryHoldingQuantity?: number;
  underlyingPrice?: number;
}

export class OrderValidator {
  /**
   * Validate an incoming simulated order request against contract metadata,
   * account balances, and market tick rules.
   */
  public static validate(
    request: PlaceOrderRequest,
    instrument: InstrumentMetadata,
    availableBalancePaise: Paise,
    currentMarketPrice: number,
    options?: OrderValidationOptions
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

    const existingPosQty = options?.existingPositionQuantity ?? 0;
    const isRiskReducingExit =
      (existingPosQty > 0 && request.side === 'SELL' && request.quantity <= existingPosQty) ||
      (existingPosQty < 0 && request.side === 'BUY' && request.quantity <= Math.abs(existingPosQty));

    const productType =
      request.productType ||
      (instrument.instrumentType === 'EQUITY_STOCK' ? 'INTRADAY' : 'MARGIN');

    // Check Equity Delivery short-sell restriction
    if (instrument.instrumentType === 'EQUITY_STOCK' && productType === 'DELIVERY' && request.side === 'SELL') {
      const heldQty = options?.existingDeliveryHoldingQuantity ?? (existingPosQty > 0 ? existingPosQty : 0);
      if (heldQty < request.quantity) {
        return {
          isValid: false,
          errorCode: 'ERR_INSUFFICIENT_HOLDINGS',
          errorMessage: `Insufficient delivery holdings to sell ${request.quantity} shares of ${instrument.symbol} (Held: ${heldQty}). Switch to INTRADAY to short-sell intraday.`,
        };
      }
    }

    const quoteRatio =
      instrument.exchange === 'MCX' && instrument.priceQuoteMultiplier
        ? instrument.priceQuoteMultiplier / (instrument.lotSize || 1)
        : 1.0;
    const contractValueRupees = effectivePrice * quoteRatio * request.quantity;
    let requiredMarginRupees = 0;

    if (!isRiskReducingExit) {
      if (instrument.instrumentType === 'EQUITY_STOCK') {
        if (productType === 'DELIVERY') {
          requiredMarginRupees = contractValueRupees * SIMULATED_MARGIN_RATES.EQUITY_DELIVERY;
        } else {
          const rate = instrument.marginMultiplier ?? SIMULATED_MARGIN_RATES.EQUITY_STOCK;
          requiredMarginRupees = contractValueRupees * rate;
        }
      } else if (
        instrument.instrumentType === 'OPTIDX' ||
        instrument.instrumentType === 'OPTSTK' ||
        instrument.instrumentType === 'OPTCOM'
      ) {
        if (request.side === 'BUY') {
          // Option buyers pay 100% of premium
          requiredMarginRupees = contractValueRupees * SIMULATED_MARGIN_RATES.OPTION_BUY;
        } else {
          // Option writers (short) require premium + 15% of underlying notional
          const refUnderlyingPrice =
            options?.underlyingPrice || instrument.strikePrice || effectivePrice * 50;
          const underlyingNotional = refUnderlyingPrice * request.quantity * quoteRatio;
          requiredMarginRupees =
            contractValueRupees + underlyingNotional * SIMULATED_MARGIN_RATES.OPTION_SHORT_UNDERLYING;
        }
      } else if (instrument.instrumentType === 'FUTCOM') {
        const rate = instrument.marginMultiplier ?? SIMULATED_MARGIN_RATES.FUTCOM;
        requiredMarginRupees = contractValueRupees * rate;
      } else if (instrument.instrumentType === 'FUTSTK') {
        const rate = instrument.marginMultiplier ?? SIMULATED_MARGIN_RATES.FUTSTK;
        requiredMarginRupees = contractValueRupees * rate;
      } else {
        // FUTIDX
        const rate = instrument.marginMultiplier ?? SIMULATED_MARGIN_RATES.FUTIDX;
        requiredMarginRupees = contractValueRupees * rate;
      }
    }

    const requiredMarginPaise = Money.fromRupees(requiredMarginRupees);

    // 7. Estimated Simulation Transaction Charges (STT 0.0125%, Exchange 0.0019%, GST 18%, Stamp Duty 0.002%)
    // Total approx 0.02% of turnover
    const estimatedChargesRupees = Math.max(20, contractValueRupees * 0.0002);
    const estimatedChargesPaise = Money.fromRupees(estimatedChargesRupees);

    if (!isRiskReducingExit && availableBalancePaise < requiredMarginPaise + estimatedChargesPaise) {
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
