import React, { useState } from 'react';
import {
  Alert,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useTradingStore } from '../store/tradingStore.js';
import { Money, SimulatedPosition, SimulatedOrder } from '@trading/shared';

export const OrdersPositionsScreen: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'POSITIONS' | 'ORDERS'>('POSITIONS');
  const positions = useTradingStore((s) => s.positions);
  const orders = useTradingStore((s) => s.orders);
  const squareOffPosition = useTradingStore((s) => s.squareOffPosition);

  const handleSquareOff = (globalInstrumentId: string) => {
    Alert.alert(
      'Confirm Square-Off',
      'Do you want to close this position at current simulated market price?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Square-Off',
          style: 'destructive',
          onPress: async () => {
            const res = await squareOffPosition(globalInstrumentId);
            if (!res.success) {
              Alert.alert('Error', res.error || 'Failed to square off');
            }
          },
        },
      ]
    );
  };

  const renderPosition = ({ item }: { item: SimulatedPosition }) => {
    const isLong = item.quantity > 0;
    const isClosed = item.quantity === 0;
    const unrealizedINR = Money.toRupees(BigInt(item.unrealizedPnlPaise));
    const realizedINR = Money.toRupees(BigInt(item.realizedPnlPaise));

    return (
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <Text style={styles.cardTitle}>{item.globalInstrumentId.split(':')[1]}</Text>
          <Text
            style={[
              styles.sideBadge,
              isClosed ? styles.bgGray : isLong ? styles.bgGreen : styles.bgRed,
            ]}
          >
            {isClosed ? 'CLOSED' : `${isLong ? 'LONG' : 'SHORT'} (${item.quantity})`}
          </Text>
        </View>

        <View style={styles.cardBody}>
          <View style={styles.bodyCol}>
            <Text style={styles.cardLabel}>Avg Entry</Text>
            <Text style={styles.cardVal}>₹{item.averageEntryPrice.toFixed(2)}</Text>
          </View>
          <View style={styles.bodyCol}>
            <Text style={styles.cardLabel}>Current LTP</Text>
            <Text style={styles.cardVal}>₹{item.currentPrice.toFixed(2)}</Text>
          </View>
          <View style={styles.bodyCol}>
            <Text style={styles.cardLabel}>Unrealized P&L</Text>
            <Text
              style={[
                styles.cardVal,
                unrealizedINR >= 0 ? styles.textGreen : styles.textRed,
              ]}
            >
              ₹{unrealizedINR.toFixed(2)}
            </Text>
          </View>
        </View>

        <View style={styles.cardFooter}>
          <Text style={styles.realizedText}>
            Realized P&L: ₹{realizedINR.toFixed(2)}
          </Text>
          {!isClosed && (
            <TouchableOpacity
              style={styles.sqOffBtn}
              onPress={() => handleSquareOff(item.globalInstrumentId)}
            >
              <Text style={styles.sqOffText}>Square-Off</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    );
  };

  const renderOrder = ({ item }: { item: SimulatedOrder }) => {
    return (
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <Text style={styles.cardTitle}>{item.globalInstrumentId.split(':')[1]}</Text>
          <Text
            style={[
              styles.statusBadge,
              item.status === 'EXECUTED'
                ? styles.bgGreen
                : item.status === 'PENDING'
                ? styles.bgAmber
                : styles.bgRed,
            ]}
          >
            {item.status}
          </Text>
        </View>
        <Text style={styles.orderSub}>
          {item.side} {item.quantity} Qty • Type: {item.orderType}
        </Text>
        <Text style={styles.orderSub}>
          Executed: ₹{item.executedPrice?.toFixed(2) || '---'} • Charges: ₹
          {Money.toRupees(BigInt(item.estimatedChargesPaise)).toFixed(2)}
        </Text>
      </View>
    );
  };

  return (
    <View style={styles.container}>
      <View style={styles.tabsRow}>
        <TouchableOpacity
          style={[styles.tab, activeTab === 'POSITIONS' && styles.activeTab]}
          onPress={() => setActiveTab('POSITIONS')}
        >
          <Text
            style={[styles.tabText, activeTab === 'POSITIONS' && styles.activeTabText]}
          >
            Positions ({positions.filter((p) => p.quantity !== 0).length})
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tab, activeTab === 'ORDERS' && styles.activeTab]}
          onPress={() => setActiveTab('ORDERS')}
        >
          <Text style={[styles.tabText, activeTab === 'ORDERS' && styles.activeTabText]}>
            Order Book ({orders.length})
          </Text>
        </TouchableOpacity>
      </View>

      {activeTab === 'POSITIONS' ? (
        <FlatList
          data={positions}
          keyExtractor={(p) => p.id}
          renderItem={renderPosition}
          contentContainerStyle={styles.listContent}
          ListEmptyComponent={
            <Text style={styles.emptyText}>No open positions.</Text>
          }
        />
      ) : (
        <FlatList
          data={orders}
          keyExtractor={(o) => o.id}
          renderItem={renderOrder}
          contentContainerStyle={styles.listContent}
          ListEmptyComponent={
            <Text style={styles.emptyText}>No orders recorded.</Text>
          }
        />
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a' },
  tabsRow: {
    flexDirection: 'row',
    backgroundColor: '#1e293b',
    borderBottomWidth: 1,
    borderBottomColor: '#334155',
  },
  tab: { flex: 1, paddingVertical: 12, alignItems: 'center' },
  activeTab: { borderBottomWidth: 2, borderBottomColor: '#38bdf8' },
  tabText: { color: '#94a3b8', fontSize: 13, fontWeight: '600' },
  activeTabText: { color: '#f8fafc' },
  listContent: { padding: 12 },
  card: {
    backgroundColor: '#1e293b',
    borderRadius: 8,
    padding: 12,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#334155',
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  cardTitle: { color: '#f8fafc', fontSize: 14, fontWeight: '700' },
  sideBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    color: '#ffffff',
    fontSize: 10,
    fontWeight: '700',
  },
  statusBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    color: '#ffffff',
    fontSize: 10,
    fontWeight: '700',
  },
  bgGreen: { backgroundColor: '#10b981' },
  bgRed: { backgroundColor: '#ef4444' },
  bgAmber: { backgroundColor: '#f59e0b' },
  bgGray: { backgroundColor: '#475569' },
  cardBody: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: '#334155',
  },
  bodyCol: { alignItems: 'flex-start' },
  cardLabel: { color: '#94a3b8', fontSize: 10 },
  cardVal: { color: '#f8fafc', fontSize: 13, fontWeight: '600', marginTop: 2 },
  textGreen: { color: '#10b981' },
  textRed: { color: '#ef4444' },
  cardFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 6,
  },
  realizedText: { color: '#94a3b8', fontSize: 11 },
  sqOffBtn: {
    backgroundColor: '#ef4444',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 4,
  },
  sqOffText: { color: '#ffffff', fontSize: 11, fontWeight: '700' },
  orderSub: { color: '#94a3b8', fontSize: 11, marginTop: 2 },
  emptyText: { color: '#64748b', textAlign: 'center', marginTop: 30 },
});
