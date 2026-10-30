import React, { useEffect, useState } from 'react';
import {
  SafeAreaView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useTradingStore } from './store/tradingStore.js';
import { WatchlistScreen } from './screens/WatchlistScreen.js';
import { ChartScreen } from './screens/ChartScreen.js';
import { OrdersPositionsScreen } from './screens/OrdersPositionsScreen.js';
import { AccountScreen } from './screens/AccountScreen.js';

export function App(): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<'WATCHLIST' | 'CHART' | 'TRADE' | 'ACCOUNT'>(
    'CHART'
  );
  const authToken = useTradingStore((s) => s.authToken);
  const loginDev = useTradingStore((s) => s.loginDev);
  const selectInstrument = useTradingStore((s) => s.selectInstrument);
  const wsUrl = useTradingStore((s) => s.wsUrl);
  const handleIncomingTick = useTradingStore((s) => s.handleIncomingTick);

  // 1. Auto-login in development mode
  useEffect(() => {
    loginDev('dev-trader-01');
  }, [loginDev]);

  // 2. Connect live WebSocket for real-time tick streaming
  useEffect(() => {
    if (!authToken) return;
    let ws: WebSocket | null = null;
    let reconnectTimer: any = null;

    function connectWs() {
      try {
        ws = new WebSocket(wsUrl);
        ws.onmessage = (event) => {
          try {
            const parsed = JSON.parse(event.data);
            if (parsed.type === 'QUOTE_TICK' && parsed.data) {
              handleIncomingTick(parsed.data);
            }
          } catch {
            // ignore
          }
        };
        ws.onclose = () => {
          reconnectTimer = setTimeout(connectWs, 2000);
        };
      } catch {
        reconnectTimer = setTimeout(connectWs, 3000);
      }
    }

    connectWs();

    return () => {
      if (ws) ws.close();
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  }, [authToken, wsUrl, handleIncomingTick]);

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#0f172a" />

      {/* Screen Content */}
      <View style={styles.content}>
        {activeTab === 'WATCHLIST' && (
          <WatchlistScreen
            onSelectInstrument={(inst) => {
              selectInstrument(inst.globalId);
              setActiveTab('CHART');
            }}
          />
        )}
        {activeTab === 'CHART' && <ChartScreen />}
        {activeTab === 'TRADE' && <OrdersPositionsScreen />}
        {activeTab === 'ACCOUNT' && <AccountScreen />}
      </View>

      {/* Bottom Navigation Dock */}
      <View style={styles.bottomNav}>
        <TouchableOpacity
          style={styles.navItem}
          onPress={() => setActiveTab('WATCHLIST')}
        >
          <Text style={[styles.navText, activeTab === 'WATCHLIST' && styles.navActive]}>
            Watchlist
          </Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.navItem} onPress={() => setActiveTab('CHART')}>
          <Text style={[styles.navText, activeTab === 'CHART' && styles.navActive]}>
            Chart
          </Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.navItem} onPress={() => setActiveTab('TRADE')}>
          <Text style={[styles.navText, activeTab === 'TRADE' && styles.navActive]}>
            Orders/Pos
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.navItem}
          onPress={() => setActiveTab('ACCOUNT')}
        >
          <Text style={[styles.navText, activeTab === 'ACCOUNT' && styles.navActive]}>
            Account
          </Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a' },
  content: { flex: 1 },
  bottomNav: {
    flexDirection: 'row',
    height: 54,
    backgroundColor: '#1e293b',
    borderTopWidth: 1,
    borderTopColor: '#334155',
    alignItems: 'center',
  },
  navItem: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  navText: { color: '#94a3b8', fontSize: 11, fontWeight: '600' },
  navActive: { color: '#38bdf8', fontWeight: '800' },
});

export default App;
