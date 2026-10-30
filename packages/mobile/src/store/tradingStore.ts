import { create } from 'zustand';
import {
  InstrumentMetadata,
  PlaceOrderRequest,
  QuoteSnapshot,
  SimulatedOrder,
  SimulatedPosition,
  Timeframe,
  VirtualAccount,
} from '@trading/shared';

export interface FeedHealthState {
  source: 'DEMO' | 'SMARTAPI';
  status: 'LIVE' | 'STALE' | 'DISCONNECTED' | 'NOT_LIVE_VERIFIED';
  latencyMs: number;
  uiBannerLabel: string;
}

interface TradingState {
  apiBaseUrl: string;
  wsUrl: string;
  authToken: string | null;
  userId: string | null;
  userName: string | null;
  feedHealth: FeedHealthState | null;
  instruments: InstrumentMetadata[];
  selectedInstrument: InstrumentMetadata | null;
  quotes: Record<string, QuoteSnapshot>;
  account: VirtualAccount | null;
  orders: SimulatedOrder[];
  positions: SimulatedPosition[];
  selectedTimeframe: Timeframe;
  savedDrawings: Record<string, any[]>; // globalId -> drawings[]

  // Actions
  setApiBaseUrl: (url: string) => void;
  loginDev: (userId?: string) => Promise<boolean>;
  loadFeedHealth: () => Promise<void>;
  loadInstruments: () => Promise<void>;
  selectInstrument: (globalId: string) => void;
  loadAccount: () => Promise<void>;
  resetAccount: () => Promise<{ success: boolean; error?: string }>;
  loadOrdersAndPositions: () => Promise<void>;
  placeOrder: (req: Omit<PlaceOrderRequest, 'accountId'>) => Promise<{ success: boolean; error?: string }>;
  squareOffPosition: (globalInstrumentId: string) => Promise<{ success: boolean; error?: string }>;
  handleIncomingTick: (quote: QuoteSnapshot) => void;
  setTimeframe: (tf: Timeframe) => void;
  addDrawing: (globalId: string, drawing: any) => void;
}

export const useTradingStore = create<TradingState>((set, get) => ({
  apiBaseUrl: 'http://10.0.2.2:4000', // Standard Android Emulator loopback to host
  wsUrl: 'ws://10.0.2.2:4000/ws',
  authToken: null,
  userId: null,
  userName: null,
  feedHealth: {
    source: 'DEMO',
    status: 'LIVE',
    latencyMs: 15,
    uiBannerLabel: 'DEMO DATA — NOT LIVE MARKET',
  },
  instruments: [],
  selectedInstrument: null,
  quotes: {},
  account: null,
  orders: [],
  positions: [],
  selectedTimeframe: '5m',
  savedDrawings: {},

  setApiBaseUrl: (url: string) => set({ apiBaseUrl: url }),

  loginDev: async (userId: string = 'dev-trader-01') => {
    try {
      const { apiBaseUrl } = get();
      const res = await fetch(`${apiBaseUrl}/api/v1/auth/dev-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, name: 'Practice Trader' }),
      });
      if (!res.ok) return false;
      const data = await res.json();
      set({
        authToken: data.token,
        userId: data.user.userId,
        userName: data.user.name,
        account: data.account,
      });
      await get().loadInstruments();
      await get().loadOrdersAndPositions();
      return true;
    } catch {
      return false;
    }
  },

  loadFeedHealth: async () => {
    try {
      const { apiBaseUrl } = get();
      const res = await fetch(`${apiBaseUrl}/api/v1/feed-health`);
      if (res.ok) {
        const data = await res.json();
        set({ feedHealth: data.activeProvider });
      }
    } catch {
      // Keep existing state
    }
  },

  loadInstruments: async () => {
    try {
      const { apiBaseUrl, selectedInstrument } = get();
      const res = await fetch(`${apiBaseUrl}/api/v1/instruments`);
      if (!res.ok) return;
      const data = await res.json();
      const list: InstrumentMetadata[] = data.instruments || [];
      // Default to NIFTY Futures
      const defaultInst =
        selectedInstrument ||
        list.find((i) => i.instrumentType === 'FUTIDX') ||
        list[0] ||
        null;
      set({ instruments: list, selectedInstrument: defaultInst });
    } catch {
      // Fallback
    }
  },

  selectInstrument: (globalId: string) => {
    const inst = get().instruments.find((i) => i.globalId === globalId);
    if (inst) set({ selectedInstrument: inst });
  },

  loadAccount: async () => {
    try {
      const { apiBaseUrl, authToken } = get();
      if (!authToken) return;
      const res = await fetch(`${apiBaseUrl}/api/v1/account`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (res.ok) {
        const acc = await res.json();
        set({ account: acc });
      }
    } catch {
      // ignore
    }
  },

  resetAccount: async () => {
    try {
      const { apiBaseUrl, authToken } = get();
      if (!authToken) return { success: false, error: 'Not authenticated' };
      const res = await fetch(`${apiBaseUrl}/api/v1/account/reset`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}` },
      });
      const data = await res.json();
      if (!res.ok) {
        return { success: false, error: data.error };
      }
      set({ account: data.account });
      await get().loadOrdersAndPositions();
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },

  loadOrdersAndPositions: async () => {
    try {
      const { apiBaseUrl, authToken } = get();
      if (!authToken) return;
      const [ordRes, posRes] = await Promise.all([
        fetch(`${apiBaseUrl}/api/v1/orders`, { headers: { Authorization: `Bearer ${authToken}` } }),
        fetch(`${apiBaseUrl}/api/v1/positions`, { headers: { Authorization: `Bearer ${authToken}` } }),
      ]);
      if (ordRes.ok) {
        const ordData = await ordRes.json();
        set({ orders: ordData.orders || [] });
      }
      if (posRes.ok) {
        const posData = await posRes.json();
        set({ positions: posData.positions || [] });
      }
    } catch {
      // ignore
    }
  },

  placeOrder: async (req) => {
    try {
      const { apiBaseUrl, authToken } = get();
      if (!authToken) return { success: false, error: 'Not authenticated' };
      const res = await fetch(`${apiBaseUrl}/api/v1/orders/place`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify(req),
      });
      const data = await res.json();
      if (!res.ok) {
        return { success: false, error: data.error };
      }
      await get().loadAccount();
      await get().loadOrdersAndPositions();
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },

  squareOffPosition: async (globalInstrumentId) => {
    try {
      const { apiBaseUrl, authToken } = get();
      if (!authToken) return { success: false, error: 'Not authenticated' };
      const res = await fetch(`${apiBaseUrl}/api/v1/positions/square-off`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ globalInstrumentId }),
      });
      const data = await res.json();
      if (!res.ok) {
        return { success: false, error: data.error };
      }
      await get().loadAccount();
      await get().loadOrdersAndPositions();
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },

  handleIncomingTick: (quote) => {
    set((state) => ({
      quotes: { ...state.quotes, [quote.globalId]: quote },
    }));
  },

  setTimeframe: (tf) => set({ selectedTimeframe: tf }),

  addDrawing: (globalId, drawing) => {
    set((state) => {
      const existing = state.savedDrawings[globalId] || [];
      return {
        savedDrawings: {
          ...state.savedDrawings,
          [globalId]: [...existing, drawing],
        },
      };
    });
  },
}));
