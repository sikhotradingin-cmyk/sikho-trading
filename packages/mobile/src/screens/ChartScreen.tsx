import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTradingStore } from '../store/tradingStore.js';
import { FeedHealthBadge } from '../components/FeedHealthBadge.js';
import { LightweightChartWebView } from '../components/LightweightChartWebView.js';
import { QuickOrderTicket } from '../components/QuickOrderTicket.js';

export const ChartScreen: React.FC = () => {
  const selectedInstrument = useTradingStore((s) => s.selectedInstrument);
  const quote = useTradingStore((s) =>
    selectedInstrument ? s.quotes[selectedInstrument.globalId] : undefined
  );

  if (!selectedInstrument) {
    return (
      <View style={styles.emptyContainer}>
        <Text style={styles.emptyText}>No instrument selected.</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <FeedHealthBadge />
      {/* Chart Header Bar */}
      <View style={styles.headerBar}>
        <View>
          <Text style={styles.title}>{selectedInstrument.symbol}</Text>
          <Text style={styles.subTitle}>
            {selectedInstrument.name}
            {selectedInstrument.expiry ? ` • Exp: ${selectedInstrument.expiry}` : ''}
          </Text>
        </View>
        <View style={styles.priceCol}>
          <Text style={styles.ltpText}>
            ₹{quote ? quote.ltp.toFixed(2) : '---'}
          </Text>
          <Text style={styles.spreadText}>
            Bid: ₹{quote?.bidPrice?.toFixed(2) || '--'} • Ask: ₹
            {quote?.askPrice?.toFixed(2) || '--'}
          </Text>
        </View>
      </View>

      {/* Embedded Lightweight Charts View */}
      <View style={styles.chartArea}>
        <LightweightChartWebView globalInstrumentId={selectedInstrument.globalId} />
      </View>

      {/* Floating Quick Order Ticket */}
      <QuickOrderTicket instrument={selectedInstrument} />
    </View>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a' },
  emptyContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#0f172a' },
  emptyText: { color: '#94a3b8' },
  headerBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: '#1e293b',
    borderBottomWidth: 1,
    borderBottomColor: '#334155',
  },
  title: { color: '#f8fafc', fontSize: 16, fontWeight: '700' },
  subTitle: { color: '#94a3b8', fontSize: 11, marginTop: 2 },
  priceCol: { alignItems: 'flex-end' },
  ltpText: { color: '#38bdf8', fontSize: 17, fontWeight: '800' },
  spreadText: { color: '#64748b', fontSize: 10, marginTop: 2 },
  chartArea: { flex: 1 },
});
