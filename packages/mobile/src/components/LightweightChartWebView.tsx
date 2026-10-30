import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { WebView, WebViewMessageEvent } from 'react-native-webview';
import { generateChartHtml } from '../chart/chartHtmlBundle.js';
import { useTradingStore } from '../store/tradingStore.js';
import { Candle } from '@trading/shared';

interface Props {
  globalInstrumentId: string;
}

export const LightweightChartWebView: React.FC<Props> = ({ globalInstrumentId }) => {
  const webViewRef = useRef<WebView>(null);
  const [isChartReady, setIsChartReady] = useState(false);
  const [isLoadingCandles, setIsLoadingCandles] = useState(true);

  const apiBaseUrl = useTradingStore((s) => s.apiBaseUrl);
  const selectedTimeframe = useTradingStore((s) => s.selectedTimeframe);
  const setTimeframe = useTradingStore((s) => s.setTimeframe);
  const addDrawing = useTradingStore((s) => s.addDrawing);
  const positions = useTradingStore((s) => s.positions);
  const latestQuote = useTradingStore((s) => s.quotes[globalInstrumentId]);

  const activePosition = positions.find(
    (p) => p.globalInstrumentId === globalInstrumentId && p.quantity !== 0
  );

  // 1. Fetch initial candles from backend
  useEffect(() => {
    let isMounted = true;
    async function loadCandles() {
      setIsLoadingCandles(true);
      try {
        const res = await fetch(
          `${apiBaseUrl}/api/v1/market-data/candles?globalId=${encodeURIComponent(
            globalInstrumentId
          )}&timeframe=${selectedTimeframe}&count=150`
        );
        if (res.ok) {
          const data = await res.json();
          if (isMounted && data.candles) {
            sendToChart('SET_CANDLES', { candles: data.candles });
          }
        }
      } catch (err) {
        console.error('Failed to load candles', err);
      } finally {
        if (isMounted) setIsLoadingCandles(false);
      }
    }

    if (isChartReady) {
      loadCandles();
    }

    return () => {
      isMounted = false;
    };
  }, [globalInstrumentId, selectedTimeframe, isChartReady, apiBaseUrl]);

  // 2. Stream incremental ticks to the chart
  useEffect(() => {
    if (!isChartReady || !latestQuote) return;
    const nowSec = Math.floor(latestQuote.receiveTimestamp / 1000);
    const minuteSec = Math.floor(nowSec / (selectedTimeframe === '5m' ? 300 : 60)) * (selectedTimeframe === '5m' ? 300 : 60);

    const candle: Candle = {
      time: minuteSec,
      open: latestQuote.open,
      high: latestQuote.high,
      low: latestQuote.low,
      close: latestQuote.ltp,
    };
    sendToChart('UPDATE_TICK', { candle });
  }, [latestQuote, isChartReady, selectedTimeframe]);

  // 3. Update position price overlays (Entry, SL, Target)
  useEffect(() => {
    if (!isChartReady) return;
    if (activePosition) {
      sendToChart('SET_OVERLAYS', {
        overlays: {
          entry: activePosition.averageEntryPrice,
          stopLoss: activePosition.stopLossPrice,
          target: activePosition.targetPrice,
        },
      });
    } else {
      sendToChart('SET_OVERLAYS', { overlays: null });
    }
  }, [activePosition, isChartReady]);

  const sendToChart = (type: string, payload: any) => {
    if (webViewRef.current) {
      const script = `window.postMessage(JSON.stringify(${JSON.stringify({ type, ...payload })}), '*'); true;`;
      webViewRef.current.injectJavaScript(script);
    }
  };

  const handleMessage = (event: WebViewMessageEvent) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);
      if (data.type === 'CHART_MOUNTED') {
        setIsChartReady(true);
      } else if (data.type === 'CHANGE_TIMEFRAME') {
        setTimeframe(data.payload.timeframe);
      } else if (data.type === 'DRAWING_CREATED') {
        addDrawing(globalInstrumentId, data.payload);
      }
    } catch {
      // ignore
    }
  };

  const RNWebView = WebView as any;

  return (
    <View style={styles.chartWrapper}>
      {isLoadingCandles && (
        <View style={styles.loadingOverlay}>
          <ActivityIndicator size="small" color="#3b82f6" />
          <Text style={styles.loadingText}>Loading Candles & Indicators...</Text>
        </View>
      )}
      <RNWebView
        ref={webViewRef}
        originWhitelist={['*']}
        source={{ html: generateChartHtml('dark') }}
        style={styles.webView}
        javaScriptEnabled={true}
        domStorageEnabled={true}
        onMessage={handleMessage}
        scrollEnabled={false}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  chartWrapper: {
    flex: 1,
    backgroundColor: '#0f172a',
    position: 'relative',
  },
  webView: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  loadingOverlay: {
    position: 'absolute',
    top: 50,
    left: 0,
    right: 0,
    zIndex: 20,
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 8,
  },
  loadingText: {
    color: '#94a3b8',
    fontSize: 12,
  },
});
