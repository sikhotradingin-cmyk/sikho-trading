import React from 'react';
import { FlatList, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useTradingStore } from '../store/tradingStore.js';
import { FeedHealthBadge } from '../components/FeedHealthBadge.js';
import { InstrumentMetadata } from '@trading/shared';

interface Props {
  onSelectInstrument: (inst: InstrumentMetadata) => void;
}

export const WatchlistScreen: React.FC<Props> = ({ onSelectInstrument }) => {
  const instruments = useTradingStore((s) => s.instruments);
  const quotes = useTradingStore((s) => s.quotes);

  const renderItem = ({ item }: { item: InstrumentMetadata }) => {
    const quote = quotes[item.globalId];
    const ltp = quote ? quote.ltp.toFixed(2) : '---';
    const isSpot = item.instrumentType === 'INDEX_SPOT';

    return (
      <TouchableOpacity
        style={styles.itemRow}
        onPress={() => onSelectInstrument(item)}
      >
        <View style={styles.leftCol}>
          <View style={styles.titleRow}>
            <Text style={styles.symbolText}>{item.symbol}</Text>
            {isSpot && <Text style={styles.spotTag}>SPOT REFERENCE</Text>}
          </View>
          <Text style={styles.nameText}>{item.name}</Text>
          <Text style={styles.lotText}>
            Lot Size: {item.lotSize} • {item.exchange}
          </Text>
        </View>
        <View style={styles.rightCol}>
          <Text style={styles.priceText}>₹{ltp}</Text>
          <Text style={styles.changeText}>
            {quote ? '+0.45%' : '--'}
          </Text>
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <View style={styles.container}>
      <FeedHealthBadge />
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Indian Markets Watchlist</Text>
      </View>
      <FlatList
        data={instruments}
        keyExtractor={(i) => i.globalId}
        renderItem={renderItem}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a' },
  header: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b',
  },
  headerTitle: { color: '#f8fafc', fontSize: 16, fontWeight: '700' },
  itemRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  leftCol: { flex: 1 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  symbolText: { color: '#f8fafc', fontSize: 15, fontWeight: '700' },
  spotTag: {
    fontSize: 9,
    backgroundColor: '#334155',
    color: '#94a3b8',
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 3,
    fontWeight: '700',
  },
  nameText: { color: '#94a3b8', fontSize: 12, marginTop: 2 },
  lotText: { color: '#64748b', fontSize: 11, marginTop: 2 },
  rightCol: { alignItems: 'flex-end' },
  priceText: { color: '#f8fafc', fontSize: 15, fontWeight: '700' },
  changeText: { color: '#10b981', fontSize: 12, marginTop: 2, fontWeight: '600' },
  separator: { height: 1, backgroundColor: '#1e293b' },
});
