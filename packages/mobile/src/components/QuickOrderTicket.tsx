import React, { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { InstrumentMetadata, Money, OrderSide, OrderType } from '@trading/shared';
import { useTradingStore } from '../store/tradingStore.js';

interface Props {
  instrument: InstrumentMetadata;
}

export const QuickOrderTicket: React.FC<Props> = ({ instrument }) => {
  const [side, setSide] = useState<OrderSide>('BUY');
  const [orderType, setOrderType] = useState<OrderType>('MARKET');
  const [lots, setLots] = useState<number>(1);
  const [limitPrice, setLimitPrice] = useState<string>('');
  const [triggerPrice, setTriggerPrice] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);

  const placeOrder = useTradingStore((s) => s.placeOrder);
  const account = useTradingStore((s) => s.account);
  const quote = useTradingStore((s) => s.quotes[instrument.globalId]);

  const currentPrice = quote?.ltp ?? 0;
  const quantity = lots * instrument.lotSize; // Dynamic lot size resolution
  const contractValue = currentPrice * quantity;
  const marginRate = instrument.instrumentType === 'FUTIDX' ? 0.12 : 0.20;
  const requiredMargin = contractValue * marginRate;

  const handlePlaceOrder = async () => {
    if (!instrument.isTradable) {
      Alert.alert(
        'Non-Tradable Instrument',
        'Spot index benchmarks are non-tradable. Practice with listed Futures contracts instead.'
      );
      return;
    }

    setIsSubmitting(true);
    const idemKey = `rn-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

    const res = await placeOrder({
      globalInstrumentId: instrument.globalId,
      side,
      orderType,
      quantity,
      requestedPrice: orderType === 'LIMIT' ? parseFloat(limitPrice) : undefined,
      triggerPrice: orderType === 'STOP_MARKET' ? parseFloat(triggerPrice) : undefined,
      idempotencyKey: idemKey,
    });

    setIsSubmitting(false);

    if (res.success) {
      Alert.alert('Simulated Order Executed', `Filled ${side} ${quantity} ${instrument.symbol}`);
    } else {
      Alert.alert('Order Rejected', res.error || 'Failed to place order.');
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <View>
          <Text style={styles.symbolTitle}>{instrument.symbol}</Text>
          <Text style={styles.contractSub}>
            Lot Size: {instrument.lotSize} • Expiry: {instrument.expiry || 'N/A'}
          </Text>
        </View>
        <View style={styles.sideToggle}>
          <TouchableOpacity
            style={[styles.sideBtn, side === 'BUY' && styles.sideBtnBuy]}
            onPress={() => setSide('BUY')}
          >
            <Text style={[styles.sideText, side === 'BUY' && styles.textWhite]}>BUY</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.sideBtn, side === 'SELL' && styles.sideBtnSell]}
            onPress={() => setSide('SELL')}
          >
            <Text style={[styles.sideText, side === 'SELL' && styles.textWhite]}>SELL</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Lot Selector */}
      <View style={styles.controlRow}>
        <Text style={styles.label}>Lots ({instrument.lotSize} / lot):</Text>
        <View style={styles.lotCounter}>
          <TouchableOpacity
            style={styles.counterBtn}
            onPress={() => setLots(Math.max(1, lots - 1))}
          >
            <Text style={styles.counterBtnText}>-</Text>
          </TouchableOpacity>
          <Text style={styles.lotValue}>
            {lots} ({quantity} Qty)
          </Text>
          <TouchableOpacity style={styles.counterBtn} onPress={() => setLots(lots + 1)}>
            <Text style={styles.counterBtnText}>+</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Order Type Selector */}
      <View style={styles.typeRow}>
        {(['MARKET', 'LIMIT', 'STOP_MARKET'] as OrderType[]).map((t) => (
          <TouchableOpacity
            key={t}
            style={[styles.typeBtn, orderType === t && styles.typeBtnActive]}
            onPress={() => setOrderType(t)}
          >
            <Text style={[styles.typeText, orderType === t && styles.typeTextActive]}>
              {t.replace('_', ' ')}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Inputs if LIMIT or STOP */}
      {orderType === 'LIMIT' && (
        <View style={styles.inputRow}>
          <Text style={styles.inputLabel}>Limit Price:</Text>
          <TextInput
            style={styles.input}
            keyboardType="decimal-pad"
            placeholder={currentPrice.toString()}
            placeholderTextColor="#64748b"
            value={limitPrice}
            onChangeText={setLimitPrice}
          />
        </View>
      )}

      {orderType === 'STOP_MARKET' && (
        <View style={styles.inputRow}>
          <Text style={styles.inputLabel}>Trigger Price:</Text>
          <TextInput
            style={styles.input}
            keyboardType="decimal-pad"
            placeholder={(currentPrice * 0.995).toFixed(2)}
            placeholderTextColor="#64748b"
            value={triggerPrice}
            onChangeText={setTriggerPrice}
          />
        </View>
      )}

      {/* Margin Info */}
      <View style={styles.marginRow}>
        <Text style={styles.marginText}>
          Req. Margin: {Money.formatINR(Money.fromRupees(requiredMargin))}
        </Text>
        <Text style={styles.marginText}>
          Avail: {Money.formatINR(account ? BigInt(account.availableBalancePaise) : 0n)}
        </Text>
      </View>

      {/* Action Button */}
      <TouchableOpacity
        style={[styles.submitBtn, side === 'BUY' ? styles.bgGreen : styles.bgRed]}
        onPress={handlePlaceOrder}
        disabled={isSubmitting}
      >
        {isSubmitting ? (
          <ActivityIndicator color="white" />
        ) : (
          <Text style={styles.submitBtnText}>
            Simulate {side} {quantity} {instrument.symbol}
          </Text>
        )}
      </TouchableOpacity>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#1e293b',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 16,
    borderTopWidth: 1,
    borderTopColor: '#334155',
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  symbolTitle: {
    color: '#f8fafc',
    fontSize: 16,
    fontWeight: '700',
  },
  contractSub: {
    color: '#94a3b8',
    fontSize: 11,
    marginTop: 2,
  },
  sideToggle: {
    flexDirection: 'row',
    backgroundColor: '#0f172a',
    borderRadius: 8,
    padding: 2,
  },
  sideBtn: {
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: 6,
  },
  sideBtnBuy: { backgroundColor: '#10b981' },
  sideBtnSell: { backgroundColor: '#ef4444' },
  sideText: {
    color: '#94a3b8',
    fontSize: 12,
    fontWeight: '700',
  },
  textWhite: { color: '#ffffff' },
  controlRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  label: { color: '#cbd5e1', fontSize: 13, fontWeight: '500' },
  lotCounter: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#0f172a',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  counterBtn: {
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  counterBtnText: {
    color: '#38bdf8',
    fontSize: 18,
    fontWeight: '700',
  },
  lotValue: {
    color: '#f8fafc',
    fontSize: 13,
    fontWeight: '600',
    marginHorizontal: 8,
  },
  typeRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 10,
  },
  typeBtn: {
    flex: 1,
    backgroundColor: '#0f172a',
    paddingVertical: 6,
    alignItems: 'center',
    borderRadius: 6,
  },
  typeBtnActive: {
    backgroundColor: '#3b82f6',
  },
  typeText: { color: '#94a3b8', fontSize: 11, fontWeight: '600' },
  typeTextActive: { color: '#ffffff' },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  inputLabel: { color: '#cbd5e1', fontSize: 13 },
  input: {
    backgroundColor: '#0f172a',
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    color: '#ffffff',
    width: 140,
    textAlign: 'right',
  },
  marginRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  marginText: { color: '#94a3b8', fontSize: 11 },
  submitBtn: {
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  bgGreen: { backgroundColor: '#10b981' },
  bgRed: { backgroundColor: '#ef4444' },
  submitBtnText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '700',
  },
});
