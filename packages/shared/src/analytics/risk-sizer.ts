export interface PositionSizingResult {
  isFeasible: boolean;
  maxRiskRupees: number;
  perShareRisk: number;
  recommendedLots: number;
  recommendedQuantity: number;
  actualRiskRupees: number;
  contractValueRupees: number;
  requiredMarginEstimateRupees: number;
  message?: string;
}

export class RiskSizer {
  /**
   * Calculates mathematically disciplined position size rounded to exact contract lots.
   */
  public static calculateSize(
    accountBalanceRupees: number,
    riskPercentage: number,
    entryPrice: number,
    stopLossPrice: number,
    lotSize: number,
    marginRate: number = 0.12
  ): PositionSizingResult {
    if (accountBalanceRupees <= 0) {
      return {
        isFeasible: false,
        maxRiskRupees: 0,
        perShareRisk: 0,
        recommendedLots: 0,
        recommendedQuantity: 0,
        actualRiskRupees: 0,
        contractValueRupees: 0,
        requiredMarginEstimateRupees: 0,
        message: 'Account balance must be positive to size position.',
      };
    }

    const perShareRisk = Math.abs(entryPrice - stopLossPrice);
    if (perShareRisk <= 0) {
      return {
        isFeasible: false,
        maxRiskRupees: 0,
        perShareRisk: 0,
        recommendedLots: 0,
        recommendedQuantity: 0,
        actualRiskRupees: 0,
        contractValueRupees: 0,
        requiredMarginEstimateRupees: 0,
        message: 'Stop-Loss price must differ from entry price.',
      };
    }

    const maxRiskRupees = Number(((accountBalanceRupees * riskPercentage) / 100).toFixed(2));
    const rawQuantity = maxRiskRupees / perShareRisk;
    const recommendedLots = Math.max(1, Math.floor(rawQuantity / lotSize));
    const recommendedQuantity = recommendedLots * lotSize;
    const actualRiskRupees = Number((recommendedQuantity * perShareRisk).toFixed(2));
    const contractValueRupees = Number((entryPrice * recommendedQuantity).toFixed(2));
    const requiredMarginEstimateRupees = Number((contractValueRupees * marginRate).toFixed(2));

    const isFeasible = requiredMarginEstimateRupees <= accountBalanceRupees;

    return {
      isFeasible,
      maxRiskRupees,
      perShareRisk: Number(perShareRisk.toFixed(2)),
      recommendedLots,
      recommendedQuantity,
      actualRiskRupees,
      contractValueRupees,
      requiredMarginEstimateRupees,
      message: isFeasible
        ? `Sized to ${recommendedLots} lot(s) (${recommendedQuantity} qty) within ${riskPercentage}% risk tolerance.`
        : `Margin requirement (${requiredMarginEstimateRupees.toFixed(2)}) exceeds available capital.`,
    };
  }
}

