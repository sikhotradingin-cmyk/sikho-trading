import React, { useEffect, useState } from 'react';
import {
  Alert,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useTradingStore } from '../store/tradingStore.js';
import { LedgerEntry, Money } from '@trading/shared';

export const AccountScreen: React.FC = () => {
  const account = useTradingStore((s) => s.account);
  const resetAccount = useTradingStore((s) => s.resetAccount);
  const apiBaseUrl = useTradingStore((s) => s.apiBaseUrl);
  const authToken = useTradingStore((s) => s.authToken);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);

  useEffect(() => {
    async function loadLedger() {
      if (!authToken) return;
      try {
        const res = await fetch(`${apiBaseUrl}/api/v1/account/ledger`, {
          headers: { Authorization: `Bearer ${authToken}` },
        });
        if (res.ok) {
          const data = await res.json();
          setLedger(data.ledger || []);
        }
      } catch {
        // ignore
      }
    }
    loadLedger();
  }, [authToken, account, apiBaseUrl]);

  const handleReset = () => {
    Alert.alert(
      'Reset Virtual Capital',
      'This will reset your cash balance to ₹100,000.00. Your complete historical transaction audit ledger will be preserved.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reset to ₹100,000',
          style: 'destructive',
          onPress: async () => {
            const res = await resetAccount();
            if (res.success) {
              Alert.alert('Reset Complete', 'Virtual balance restored to ₹100,000.00.');
            } else {
              Alert.alert('Reset Failed', res.error || 'Cannot reset account.');
            }
          },
        },
      ]
    );
  };

  const renderLedger = ({ item }: { item: LedgerEntry }) => {
    const amountINR = Money.toRupees(BigInt(item.amountPaise));
    const balanceAfterINR = Money.toRupees(BigInt(item.balanceAfterPaise));

    return (
      <View style={styles.ledgerRow}>
        <View style={styles.ledgerLeft}>
          <Text style={styles.ledgerType}>{item.entryType}</Text>
          <Text style={styles.ledgerNote}>{item.note}</Text>
          <Text style={styles.ledgerDate}>
            {new Date(item.timestamp).toLocaleTimeString()}
          </Text>
        </View>
        <View style={styles.ledgerRight}>
          <Text
            style={[
              styles.ledgerAmount,
              amountINR >= 0 ? styles.textGreen : styles.textRed,
            ]}
          >
            {amountINR >= 0 ? '+' : ''}₹{amountINR.toFixed(2)}
          </Text>
          <Text style={styles.balanceAfter}>Bal: ₹{balanceAfterINR.toFixed(2)}</Text>
        </View>
      </View>
    );
  };

  return (
    <View style={styles.container}>
      {/* Account Balance Card */}
      <View style={styles.balanceCard}>
        <Text style={styles.cardHeaderTitle}>Virtual Practice Account</Text>
        <Text style={styles.mainBalance}>
          {Money.formatINR(account ? BigInt(account.cashBalancePaise) : 0n)}
        </Text>
        <Text style={styles.balanceSub}>Total Virtual Cash Balance</Text>

        <View style={styles.statGrid}>
          <View style={styles.statCol}>
            <Text style={styles.statLabel}>Available Margin</Text>
            <Text style={styles.statVal}>
              {Money.formatINR(account ? BigInt(account.availableBalancePaise) : 0n)}
            </Text>
          </View>
          <View style={styles.statCol}>
            <Text style={styles.statLabel}>Locked Margin</Text>
            <Text style={styles.statVal}>
              {Money.formatINR(account ? BigInt(account.lockedMarginPaise) : 0n)}
            </Text>
          </View>
          <View style={styles.statCol}>
            <Text style={styles.statLabel}>Tier</Text>
            <Text style={styles.statVal}>{account?.tier || 'FREE'}</Text>
          </View>
        </View>

        <TouchableOpacity style={styles.resetBtn} onPress={handleReset}>
          <Text style={styles.resetBtnText}>Reset Capital to ₹100,000</Text>
        </TouchableOpacity>
      </View>

      {/* Audit Ledger Section */}
      <View style={styles.ledgerHeader}>
        <Text style={styles.ledgerHeaderTitle}>Audit Transaction Ledger</Text>
        <Text style={styles.ledgerHeaderSub}>
          (Capital Resets & Trading Returns Preserved)
        </Text>
      </View>

      <FlatList
        data={ledger}
        keyExtractor={(l) => l.id}
        renderItem={renderLedger}
        contentContainerStyle={styles.ledgerList}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a' },
  balanceCard: {
    backgroundColor: '#1e293b',
    margin: 16,
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: '#334155',
  },
  cardHeaderTitle: { color: '#94a3b8', fontSize: 12, fontWeight: '600' },
  mainBalance: {
    color: '#38bdf8',
    fontSize: 26,
    fontWeight: '800',
    marginTop: 4,
  },
  balanceSub: { color: '#64748b', fontSize: 11, marginTop: 2 },
  statGrid: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 16,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#334155',
  },
  statCol: { alignItems: 'flex-start' },
  statLabel: { color: '#94a3b8', fontSize: 11 },
  statVal: { color: '#f8fafc', fontSize: 13, fontWeight: '700', marginTop: 2 },
  resetBtn: {
    marginTop: 16,
    backgroundColor: 'rgba(239, 68, 68, 0.2)',
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.5)',
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
  },
  resetBtnText: { color: '#f87171', fontSize: 12, fontWeight: '700' },
  ledgerHeader: {
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  ledgerHeaderTitle: { color: '#f8fafc', fontSize: 14, fontWeight: '700' },
  ledgerHeaderSub: { color: '#64748b', fontSize: 10, marginTop: 2 },
  ledgerList: { paddingHorizontal: 16, paddingBottom: 20 },
  ledgerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 10,
  },
  ledgerLeft: { flex: 1, paddingRight: 8 },
  ledgerType: { color: '#f8fafc', fontSize: 12, fontWeight: '700' },
  ledgerNote: { color: '#94a3b8', fontSize: 11, marginTop: 2 },
  ledgerDate: { color: '#64748b', fontSize: 10, marginTop: 2 },
  ledgerRight: { alignItems: 'flex-end' },
  ledgerAmount: { fontSize: 13, fontWeight: '700' },
  balanceAfter: { color: '#64748b', fontSize: 10, marginTop: 2 },
  textGreen: { color: '#10b981' },
  textRed: { color: '#ef4444' },
  separator: { height: 1, backgroundColor: '#1e293b' },
});
