import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTradingStore } from '../store/tradingStore.js';

export const FeedHealthBadge: React.FC = () => {
  const feedHealth = useTradingStore((s) => s.feedHealth);

  if (!feedHealth) return null;

  const isLive = feedHealth.status === 'LIVE';

  return (
    <View style={styles.container}>
      <View style={styles.topRow}>
        <View style={[styles.statusDot, isLive ? styles.dotGreen : styles.dotAmber]} />
        <Text style={styles.statusText}>
          {feedHealth.status} • {feedHealth.latencyMs}ms
        </Text>
      </View>
      <View style={styles.demoBanner}>
        <Text style={styles.demoBannerText}>{feedHealth.uiBannerLabel}</Text>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#0f172a',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b',
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 6,
  },
  dotGreen: { backgroundColor: '#10b981' },
  dotAmber: { backgroundColor: '#f59e0b' },
  statusText: {
    color: '#94a3b8',
    fontSize: 11,
    fontWeight: '600',
  },
  demoBanner: {
    backgroundColor: 'rgba(239, 68, 68, 0.15)',
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.4)',
    borderRadius: 4,
    paddingVertical: 2,
    paddingHorizontal: 6,
    marginTop: 4,
    alignItems: 'center',
  },
  demoBannerText: {
    color: '#f87171',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
});
