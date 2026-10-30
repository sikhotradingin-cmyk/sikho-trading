export interface DisciplineConfig {
  maxDailyLossRupees: number; // e.g. 5,000
  maxDailyTrades: number; // e.g. 10
}

export interface DisciplineCheckResult {
  isAllowed: boolean;
  reason?: string;
  isRiskReducing: boolean;
  currentDayLossRupees: number;
  currentDayTradesCount: number;
}

export class DisciplineGuard {
  /**
   * Evaluates whether an incoming order satisfies trader discipline rules.
   * GUARANTEE: Never prevents a trader from reducing risk, squaring off a position,
   * or placing/maintaining protective stop-loss/target exit orders.
   */
  public static evaluateOrder(
    isNewOpeningOrder: boolean,
    currentDayRealizedLossRupees: number,
    currentDayTradesCount: number,
    config: DisciplineConfig = { maxDailyLossRupees: 5000, maxDailyTrades: 10 }
  ): DisciplineCheckResult {
    // Risk-reducing or closing orders are ALWAYS allowed
    if (!isNewOpeningOrder) {
      return {
        isAllowed: true,
        isRiskReducing: true,
        currentDayLossRupees: currentDayRealizedLossRupees,
        currentDayTradesCount: currentDayTradesCount,
      };
    }

    // 1. Check max daily loss limit
    if (currentDayRealizedLossRupees >= config.maxDailyLossRupees) {
      return {
        isAllowed: false,
        isRiskReducing: false,
        currentDayLossRupees: currentDayRealizedLossRupees,
        currentDayTradesCount: currentDayTradesCount,
        reason: `DISCIPLINE_LOCKOUT: Daily loss limit of ₹${config.maxDailyLossRupees.toLocaleString()} reached (Current realized loss: ₹${currentDayRealizedLossRupees.toLocaleString()}). New positions blocked for the remainder of the session to preserve capital.`,
      };
    }

    // 2. Check max daily trades count
    if (currentDayTradesCount >= config.maxDailyTrades) {
      return {
        isAllowed: false,
        isRiskReducing: false,
        currentDayLossRupees: currentDayRealizedLossRupees,
        currentDayTradesCount: currentDayTradesCount,
        reason: `DISCIPLINE_LOCKOUT: Maximum daily trade count of ${config.maxDailyTrades} trades reached. New positions blocked to prevent overtrading.`,
      };
    }

    return {
      isAllowed: true,
      isRiskReducing: false,
      currentDayLossRupees: currentDayRealizedLossRupees,
      currentDayTradesCount: currentDayTradesCount,
    };
  }

  /**
   * Generates descriptive, objective post-trade feedback.
   * Strictly avoids buy/sell advice or market predictions.
   */
  public static generatePostTradeAudit(
    netPnlRupees: number,
    stopLossPrice?: number,
    exitPrice?: number,
    plannedRiskRupees?: number
  ): string {
    const pnlDesc = netPnlRupees >= 0 ? `Profitable trade (+₹${netPnlRupees.toFixed(2)})` : `Loss trade (-₹${Math.abs(netPnlRupees).toFixed(2)})`;

    let slAudit = 'No Stop-Loss specified on entry.';
    if (stopLossPrice !== undefined && exitPrice !== undefined) {
      slAudit = `Planned Stop-Loss was ₹${stopLossPrice.toFixed(2)}; exit filled at ₹${exitPrice.toFixed(2)}.`;
    }

    let riskAudit = '';
    if (plannedRiskRupees !== undefined && plannedRiskRupees > 0) {
      const riskRatio = Math.abs(netPnlRupees) / plannedRiskRupees;
      riskAudit = ` Realized result was ${riskRatio.toFixed(2)}x of planned initial risk.`;
    }

    return `${pnlDesc}. ${slAudit}${riskAudit} Keep focusing on consistent execution rather than outcome variance.`;
  }
}

