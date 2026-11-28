/**
 * Sikho Trading — Professional Mobile Chart Adapter & HQChart Integration
 * Engine: 'hqchart' (default) with 'lightweight' (fallback).
 * Strictly inverted Indian market conventions:
 *   - Green = Up / Bullish (close >= open)
 *   - Red = Down / Bearish (close < open)
 * Preserves Apache 2.0 license.
 */
(function (global) {
  'use strict';

  const DEFAULT_ENGINE = 'hqchart';
  const STORAGE_KEY_ENGINE = 'tz_chart_engine';
  const STORAGE_KEY_INDICATORS = 'tz_kline_indicators_v2';
  const STORAGE_KEY_FAVORITES = 'tz_kline_favorites_v2';
  const STORAGE_KEY_DRAWINGS = 'tz_kline_drawings_v2';

  // Indian Market Convention Palette
  const THEME_COLORS = {
    dark: {
      up: '#34D399',
      upRgb: 'rgb(52, 211, 153)',
      upRgba: 'rgba(52, 211, 153, 0.25)',
      down: '#FB7185',
      downRgb: 'rgb(251, 113, 133)',
      downRgba: 'rgba(251, 113, 133, 0.25)',
      bg: '#0B1220',
      grid: 'rgba(255, 255, 255, 0.05)',
      text: '#94A3B8',
      border: '#1E293B',
    },
    light: {
      up: '#047857',
      upRgb: 'rgb(4, 120, 87)',
      upRgba: 'rgba(4, 120, 87, 0.2)',
      down: '#BE123C',
      downRgb: 'rgb(190, 18, 60)',
      downRgba: 'rgba(190, 18, 60, 0.2)',
      bg: '#F6F8FC',
      grid: 'rgba(0, 0, 0, 0.05)',
      text: '#526176',
      border: '#D8E0EB',
    },
  };

  // Technical Indicator Registry
  const INDICATOR_REGISTRY = {
    // --- Main Chart Overlays ---
    MA: {
      name: 'MA',
      label: 'Moving Average (MA)',
      category: 'main',
      series: 'price',
      isStack: true,
      description: 'Arithmetic mean of closing prices across multiple lookback periods.',
      requiresVolume: false,
      defaultParams: [5, 10, 20, 50],
      paramDefs: [
        { name: 'MA 1', min: 1, max: 500, step: 1 },
        { name: 'MA 2', min: 1, max: 500, step: 1 },
        { name: 'MA 3', min: 1, max: 500, step: 1 },
        { name: 'MA 4', min: 1, max: 500, step: 1 },
      ],
    },
    EMA: {
      name: 'EMA',
      label: 'Exponential Moving Average (EMA)',
      category: 'main',
      series: 'price',
      isStack: true,
      description: 'Weighted moving average giving higher priority to recent price action.',
      requiresVolume: false,
      defaultParams: [9, 21, 55],
      paramDefs: [
        { name: 'Short EMA', min: 1, max: 500, step: 1 },
        { name: 'Medium EMA', min: 1, max: 500, step: 1 },
        { name: 'Long EMA', min: 1, max: 500, step: 1 },
      ],
    },
    BOLL: {
      name: 'BOLL',
      label: 'Bollinger Bands (BOLL)',
      category: 'main',
      series: 'price',
      isStack: true,
      description: 'Volatility bands placed above and below a moving average (Mid, Upper, Lower).',
      requiresVolume: false,
      defaultParams: [20, 2],
      paramDefs: [
        { name: 'Period', min: 2, max: 200, step: 1 },
        { name: 'StdDev Multiplier', min: 0.5, max: 10, step: 0.1 },
      ],
    },
    SAR: {
      name: 'SAR',
      label: 'Parabolic SAR',
      category: 'main',
      series: 'price',
      isStack: true,
      description: 'Stop and Reverse dots identifying trailing trend direction and exits.',
      requiresVolume: false,
      defaultParams: [2, 2, 20],
      paramDefs: [
        { name: 'Start Factor (%)', min: 1, max: 20, step: 1 },
        { name: 'Step Factor (%)', min: 1, max: 20, step: 1 },
        { name: 'Max Factor (%)', min: 10, max: 100, step: 1 },
      ],
    },
    VWAP: {
      name: 'VWAP',
      label: 'Session VWAP',
      category: 'main',
      series: 'price',
      isStack: true,
      description: 'Intraday Volume-Weighted Average Price anchored to the Indian market session open (09:15 IST).',
      requiresVolume: true,
      defaultParams: [],
      paramDefs: [],
    },
    BBI: {
      name: 'BBI',
      label: 'Bull and Bear Index',
      category: 'main',
      series: 'price',
      isStack: true,
      description: 'Multi-period composite moving average tracking broader market bias.',
      requiresVolume: false,
      defaultParams: [3, 6, 12, 24],
      paramDefs: [
        { name: 'P1', min: 1, max: 100, step: 1 },
        { name: 'P2', min: 1, max: 100, step: 1 },
        { name: 'P3', min: 1, max: 100, step: 1 },
        { name: 'P4', min: 1, max: 100, step: 1 },
      ],
    },
    SMA: {
      name: 'SMA',
      label: 'Smoothed Moving Average (SMA)',
      category: 'main',
      series: 'price',
      isStack: true,
      description: 'Smoothed simple moving average with weight factor.',
      requiresVolume: false,
      defaultParams: [12, 2],
      paramDefs: [
        { name: 'Period', min: 2, max: 200, step: 1 },
        { name: 'Weight', min: 1, max: 10, step: 1 },
      ],
    },

    // --- Oscillators ---
    RSI: {
      name: 'RSI',
      label: 'Relative Strength Index (RSI)',
      category: 'oscillator',
      series: 'normal',
      isStack: false,
      description: 'Momentum oscillator measuring the speed and change of price moves (0-100).',
      requiresVolume: false,
      defaultParams: [14],
      paramDefs: [{ name: 'Period', min: 2, max: 100, step: 1 }],
    },
    MACD: {
      name: 'MACD',
      label: 'MACD (Trend & Momentum)',
      category: 'oscillator',
      series: 'normal',
      isStack: false,
      description: 'Moving Average Convergence Divergence with Signal Line and Histogram.',
      requiresVolume: false,
      defaultParams: [12, 26, 9],
      paramDefs: [
        { name: 'Fast Period', min: 2, max: 100, step: 1 },
        { name: 'Slow Period', min: 5, max: 200, step: 1 },
        { name: 'Signal Period', min: 2, max: 100, step: 1 },
      ],
    },
    KDJ: {
      name: 'KDJ',
      label: 'KDJ Stochastic Oscillator',
      category: 'oscillator',
      series: 'normal',
      isStack: false,
      description: 'Stochastic indicator with %K, %D and %J lines to identify overbought/oversold turns.',
      requiresVolume: false,
      defaultParams: [9, 3, 3],
      paramDefs: [
        { name: 'Period', min: 2, max: 100, step: 1 },
        { name: 'M1 (%K smooth)', min: 1, max: 50, step: 1 },
        { name: 'M2 (%D smooth)', min: 1, max: 50, step: 1 },
      ],
    },
    ATR: {
      name: 'ATR',
      label: 'Average True Range (ATR)',
      category: 'oscillator',
      series: 'normal',
      isStack: false,
      description: 'Market volatility indicator measuring the degree of price movement.',
      requiresVolume: false,
      defaultParams: [14],
      paramDefs: [{ name: 'ATR Period', min: 1, max: 100, step: 1 }],
    },
    BIAS: {
      name: 'BIAS',
      label: 'BIAS Ratio',
      category: 'oscillator',
      series: 'normal',
      isStack: false,
      description: 'Percentage deviation of current price from moving averages.',
      requiresVolume: false,
      defaultParams: [6, 12, 24],
      paramDefs: [
        { name: 'Period 1', min: 1, max: 100, step: 1 },
        { name: 'Period 2', min: 1, max: 100, step: 1 },
        { name: 'Period 3', min: 1, max: 100, step: 1 },
      ],
    },
    AO: {
      name: 'AO',
      label: 'Awesome Oscillator (Bill Williams)',
      category: 'oscillator',
      series: 'normal',
      isStack: false,
      description: 'Market momentum calculated from the difference of 5 and 34 period midpoints.',
      requiresVolume: false,
      defaultParams: [],
      paramDefs: [],
    },
    MTM: {
      name: 'MTM',
      label: 'Momentum (MTM)',
      category: 'oscillator',
      series: 'normal',
      isStack: false,
      description: 'Measures rate of price change by comparing current close to N bars back.',
      requiresVolume: false,
      defaultParams: [12, 6],
      paramDefs: [
        { name: 'Momentum Period', min: 1, max: 100, step: 1 },
        { name: 'Signal Period', min: 1, max: 50, step: 1 },
      ],
    },
    ROC: {
      name: 'ROC',
      label: 'Price Rate of Change',
      category: 'oscillator',
      series: 'normal',
      isStack: false,
      description: 'Percentage difference between current price and price N bars ago.',
      requiresVolume: false,
      defaultParams: [12, 6],
      paramDefs: [
        { name: 'ROC Period', min: 1, max: 100, step: 1 },
        { name: 'Signal Period', min: 1, max: 50, step: 1 },
      ],
    },
    PSY: {
      name: 'PSY',
      label: 'Psychological Line',
      category: 'oscillator',
      series: 'normal',
      isStack: false,
      description: 'Ratio of advancing bars to total bars over the chosen window.',
      requiresVolume: false,
      defaultParams: [12, 6],
      paramDefs: [
        { name: 'PSY Period', min: 2, max: 100, step: 1 },
        { name: 'Signal Period', min: 1, max: 50, step: 1 },
      ],
    },

    // --- Volume Indicators ---
    VOL: {
      name: 'VOL',
      label: 'Trading Volume & MAs',
      category: 'volume',
      series: 'normal',
      isStack: false,
      description: 'Traded volume bars with short and medium moving average overlays.',
      requiresVolume: true,
      defaultParams: [5, 10],
      paramDefs: [
        { name: 'MA 1', min: 1, max: 100, step: 1 },
        { name: 'MA 2', min: 1, max: 100, step: 1 },
      ],
    },
    OBV: {
      name: 'OBV',
      label: 'On-Balance Volume (OBV)',
      category: 'volume',
      series: 'normal',
      isStack: false,
      description: 'Cumulative volume indicator relating volume flow to price changes.',
      requiresVolume: true,
      defaultParams: [30],
      paramDefs: [{ name: 'MA Period', min: 2, max: 100, step: 1 }],
    },
    VR: {
      name: 'VR',
      label: 'Volume Ratio',
      category: 'volume',
      series: 'normal',
      isStack: false,
      description: 'Measures ratio of upward volume to downward volume.',
      requiresVolume: true,
      defaultParams: [26, 6],
      paramDefs: [
        { name: 'VR Period', min: 2, max: 100, step: 1 },
        { name: 'Signal Period', min: 1, max: 50, step: 1 },
      ],
    },
    PVT: {
      name: 'PVT',
      label: 'Price and Volume Trend',
      category: 'volume',
      series: 'normal',
      isStack: false,
      description: 'Cumulative volume line scaled by fractional price changes.',
      requiresVolume: true,
      defaultParams: [],
      paramDefs: [],
    },
    EMV: {
      name: 'EMV',
      label: 'Ease of Movement (EMV)',
      category: 'volume',
      series: 'normal',
      isStack: false,
      description: 'Quantifies price movement relative to volume required.',
      requiresVolume: true,
      defaultParams: [14, 9],
      paramDefs: [
        { name: 'EMV Period', min: 2, max: 100, step: 1 },
        { name: 'Signal Period', min: 1, max: 50, step: 1 },
      ],
    },
  };

  // Drawing Tools Categorized Palette
  const DRAWING_TOOL_CATEGORIES = [
    {
      id: 'lines',
      title: 'Lines & Rays',
      tools: [
        { id: 'horizontalStraightLine', name: 'Horizontal Line', icon: '—', desc: 'Infinite horizontal support/resistance' },
        { id: 'horizontalRayLine', name: 'Horizontal Ray', icon: '→', desc: 'Single-direction horizontal ray' },
        { id: 'horizontalSegment', name: 'Horizontal Segment', icon: '–', desc: 'Bounded horizontal price segment' },
        { id: 'straightLine', name: 'Trend Line', icon: '╱', desc: 'Two-point infinite trend line' },
        { id: 'rayLine', name: 'Trend Ray', icon: '↗', desc: 'Two-point trend ray from origin' },
        { id: 'segment', name: 'Trend Segment', icon: '•—•', desc: 'Bounded segment between two points' },
        { id: 'verticalStraightLine', name: 'Vertical Line', icon: '│', desc: 'Time axis separator' },
      ],
    },
    {
      id: 'channels',
      title: 'Channels & Fibonacci',
      tools: [
        { id: 'parallelStraightLine', name: 'Parallel Channel', icon: '∥', desc: 'Three-point parallel trend channel' },
        { id: 'priceChannelLine', name: 'Price Channel', icon: '▰', desc: 'Bounded price channel' },
        { id: 'fibonacciLine', name: 'Fibonacci Retracement', icon: '≡', desc: 'Standard Fib levels (0.236, 0.382, 0.5, 0.618)' },
      ],
    },
    {
      id: 'zones',
      title: 'Zones & Shapes',
      tools: [
        { id: 'rectZone', name: 'Rectangle Zone', icon: '▭', desc: 'Supply / demand consolidation box' },
        { id: 'circleZone', name: 'Circle Zone', icon: '○', desc: 'Circular pivot target zone' },
      ],
    },
    {
      id: 'measurement',
      title: 'Measurement & Risk/Reward',
      tools: [
        { id: 'priceMeasurement', name: 'Measure Price & Bars', icon: '📐', desc: 'Measures points, %, bars, and duration' },
        { id: 'riskRewardLong', name: 'Long Risk/Reward', icon: '📈', desc: 'Visual long planning: Entry, TP, SL, R:R ratio' },
        { id: 'riskRewardShort', name: 'Short Risk/Reward', icon: '📉', desc: 'Visual short planning: Entry, TP, SL, R:R ratio' },
      ],
    },
    {
      id: 'annotations',
      title: 'Annotations & Tags',
      tools: [
        { id: 'brush', name: 'Freehand Brush', icon: '✏', desc: 'Freeform path sketching on chart' },
        { id: 'simpleAnnotation', name: 'Text Note', icon: '📝', desc: 'Text label anchored to price & candle' },
        { id: 'simpleTag', name: 'Price Tag', icon: '🏷', desc: 'Compact callout tag with price level' },
      ],
    },
  ];

  // Helper to convert timestamp (sec or ms) to IST YYYYMMDD and HHMM
  function epochToIstDateAndTime(epoch) {
    const tsMs = epoch > 1e11 ? Number(epoch) : Number(epoch) * 1000;
    // IST = UTC + 5:30 (19800000 ms)
    const ist = new Date(tsMs + 19800000);
    const y = ist.getUTCFullYear();
    const m = ist.getUTCMonth() + 1;
    const d = ist.getUTCDate();
    const dateInt = y * 10000 + m * 100 + d;
    const hh = ist.getUTCHours();
    const mm = ist.getUTCMinutes();
    const timeInt = hh * 100 + mm;
    return { dateInt, timeInt, tsMs };
  }

  // =========================================================================
  // HQCHART ADAPTER CLASS
  // =========================================================================
  class HQChartAdapter {
    constructor() {
      this.engine = 'hqchart';
      this.chart = null;      // JSChart instance
      this.hqChart = null;    // JSChartContainer
      this.container = null;
      this.activeIndicators = new Map();
      this.undoStack = [];
      this.redoStack = [];
      this.drawingHistoryLimit = 20;
      this.candleHistory = [];
      this.currentSymbol = null;
      this.currentPeriod = '5m';
      this.currentPeriodId = 5;
      this.isDark = true;
      this.magnetActive = false;
      this.lockActive = false;
      this.eraseActive = false;
      this.options = {};
    }

    // Configure HQChart global styles with inverted Indian colors
    applyIndianMarketColors(isDark) {
      const palette = isDark ? THEME_COLORS.dark : THEME_COLORS.light;
      let res = null;
      try { if (typeof g_JSChartResource !== 'undefined') res = g_JSChartResource; } catch {}
      if (!res && typeof global !== 'undefined' && global.g_JSChartResource) res = global.g_JSChartResource;
      if (!res && typeof globalThis !== 'undefined' && globalThis.g_JSChartResource) res = globalThis.g_JSChartResource;
      if (!res && typeof window !== 'undefined' && window.g_JSChartResource) res = window.g_JSChartResource;

      if (res) {
        if (res.FrameLogo) {
          res.FrameLogo.Text = null;
        }
        if (isDark) {
          res.BGColor = '#0B1220';
          res.FrameTitleBGColor = '#0B1220';
          res.FrameBorderPen = 'rgba(255, 255, 255, 0.1)';
          res.FrameSplitPen = 'rgba(255, 255, 255, 0.06)';
          res.FrameSplitTextColor = '#B2BFD1';
        } else {
          res.BGColor = '#F6F8FC';
          res.FrameTitleBGColor = '#F6F8FC';
          res.FrameBorderPen = '#D8E0EB';
          res.FrameSplitPen = '#E2E8F0';
          res.FrameSplitTextColor = '#526176';
        }

        res.UpBarColor = palette.upRgb;
        res.DownBarColor = palette.downRgb;
        res.UnchagneBarColor = '#888888';
        if (res.FrameLatestPrice) {
          res.FrameLatestPrice.UpBarColor = palette.upRgb;
          res.FrameLatestPrice.DownBarColor = palette.downRgb;
        }
        if (res.HLCArea) {
          res.HLCArea.HighLineColor = palette.upRgb;
          res.HLCArea.LowLineColor = palette.downRgb;
          res.HLCArea.UpAreaColor = palette.upRgba;
          res.HLCArea.DownAreaColor = palette.downRgba;
        }
      }
    }

    parsePeriodToHQId(tf) {
      if (!tf) return 5;
      const s = String(tf).trim();
      if (s === '1m') return 4;
      if (s === '3m') return 20003;
      if (s === '5m') return 5;
      if (s === '15m') return 6;
      if (s === '30m') return 7;
      if (s === '1h' || s === '60m') return 8;
      if (s === '1D' || s === '1d') return 0;
      return 5;
    }

    init(containerEl, options = {}) {
      this.container = typeof containerEl === 'string' ? document.getElementById(containerEl) : containerEl;
      if (!this.container) return null;

      this.isDark = options.isDark !== false;
      this.options = options;
      this.container.style.backgroundColor = this.isDark ? '#080C12' : '#F6F8FC';
      this.container.innerHTML = '';

      // Strictly apply Indian Market Convention (Green = Up, Red = Down)
      this.applyIndianMarketColors(this.isDark);

      if (typeof global.JSChart === 'undefined') {
        // Fallback placeholder if library is running in test/mock environment
        return this;
      }

      const self = this;
      const periodId = this.parsePeriodToHQId(this.currentPeriod);
      this.currentPeriodId = periodId;

      const chartOption = {
        Type: '历史K线图',
        Windows: [
          { Index: 'MA', IsDrawTitleBG: false },
          { Index: 'VOL', IsDrawTitleBG: false },
        ],
        IsAutoUpdate: false,
        IsApiPeriod: true,
        EnableResize: true,
        IsShowRightMenu: false,
        KLine: {
          DragDownload: { Enable: false },
          Period: periodId,
          Right: 0,
          DrawType: 0,
        },
        NetworkFilter: function (obj, callback) {
          self.handleNetworkFilter(obj, callback);
        },
        EventCallback: [
          {
            event: 1, // TitleDraw / Crosshair
            callback: function (event, data) {
              if (typeof self.options.onCrosshair === 'function') {
                self.options.onCrosshair(data);
              }
            },
          },
        ],
      };

      try {
        this.chart = global.JSChart.Init(this.container);
        this.chart.SetOption(chartOption);
        this.hqChart = this.chart.JSChartContainer;
      } catch (e) {
        console.warn('HQChart init error:', e);
      }

      return this.chart;
    }

    handleNetworkFilter(obj, callback) {
      if (!obj) return;
      const name = obj.Name || '';
      if (
        name === 'KLineChartContainer::RequestHistoryData' ||
        name === 'KLineChartContainer::ReqeustHistoryMinuteData' ||
        name === 'KLineChartContainer::RequestMinuteHistoryData' ||
        name.includes('HistoryData') ||
        name.includes('HistoryMinute')
      ) {
        obj.PreventDefault = true;
        const sym = this.currentSymbol?.ticker || (obj.Request && obj.Request.Data && obj.Request.Data.symbol) || 'NIFTY';
        const isMinute = this.currentPeriodId !== 0;
        const formattedData = this.formatHistoryForHQ(this.candleHistory, isMinute);
        if (typeof callback === 'function') {
          callback({
            code: 0,
            symbol: sym,
            data: formattedData,
            ChartOperator: { IsShowAll: true },
          });
        }
        return;
      }
      if (name.includes('FlowCapital')) {
        obj.PreventDefault = true;
        if (typeof callback === 'function') {
          callback({ code: 0, stock: [] });
        }
        return;
      }
      if (name.includes('Realtime') || name.includes('Tick')) {
        obj.PreventDefault = true;
        return;
      }
    }

    formatHistoryForHQ(candles, isMinute) {
      if (!Array.isArray(candles) || candles.length === 0) return [];
      let prevClose = null;
      return candles.map((c) => {
        const { dateInt, timeInt } = epochToIstDateAndTime(c.time);
        const open = Number(c.open);
        const high = Number(c.high);
        const low = Number(c.low);
        const close = Number(c.close);
        const vol = Number(c.volume) || 0;
        const amount = vol * close;
        const yclose = prevClose !== null ? prevClose : open;
        prevClose = close;

        if (isMinute) {
          // [Date, YClose, Open, High, Low, Close, Vol, Amount, Time]
          return [dateInt, yclose, open, high, low, close, vol, amount, timeInt];
        } else {
          // [Date, YClose, Open, High, Low, Close, Vol, Amount]
          return [dateInt, yclose, open, high, low, close, vol, amount];
        }
      });
    }

    setTheme(isDark) {
      this.isDark = isDark;
      if (this.container) {
        this.container.style.backgroundColor = isDark ? '#080C12' : '#F6F8FC';
      }
      this.applyIndianMarketColors(isDark);
      if (this.hqChart && typeof this.hqChart.Draw === 'function') {
        this.hqChart.Draw();
      }
    }

    setInstrumentAndPeriod(inst, tf) {
      this.currentSymbol = {
        ticker: inst.symbol || inst.name || inst.globalId,
        pricePrecision: Number(inst.pricePrecision) || 2,
        name: inst.name || inst.symbol,
      };
      this.currentPeriod = tf || '5m';
      this.currentPeriodId = this.parsePeriodToHQId(this.currentPeriod);

      if (this.chart) {
        if (typeof this.chart.ChangeSymbol === 'function') {
          this.chart.ChangeSymbol(this.currentSymbol.ticker);
        }
        if (typeof this.chart.ChangePeriod === 'function') {
          this.chart.ChangePeriod(this.currentPeriodId);
        }
      }
    }

    applyNewData(candles, more = false) {
      this.candleHistory = Array.isArray(candles) ? candles : [];
      if (!this.hqChart) return;

      const isMinute = this.currentPeriodId !== 0;
      const hqData = this.formatHistoryForHQ(this.candleHistory, isMinute);
      const payload = {
        code: 0,
        symbol: this.currentSymbol?.ticker || 'NIFTY',
        data: hqData,
        ChartOperator: { IsShowAll: true },
      };

      if (isMinute && typeof this.hqChart.RecvMinuteHistoryData === 'function') {
        this.hqChart.RecvMinuteHistoryData(payload);
      } else if (typeof this.hqChart.RecvHistoryData === 'function') {
        this.hqChart.RecvHistoryData(payload);
      }

      try {
        if (this.hqChart && this.hqChart.ChartSplashPaint) {
          this.hqChart.ChartSplashPaint.EnableSplash(false);
        }
      } catch {}

      if (typeof this.hqChart.Draw === 'function') {
        this.hqChart.Draw();
      }
      if (typeof this.options.onVisibleRangeChange === 'function') {
        this.options.onVisibleRangeChange();
      }
    }

    updateData(candle) {
      if (!candle || !this.hqChart) return;
      // Maintain candleHistory in-place
      const last = this.candleHistory[this.candleHistory.length - 1];
      if (last && Math.floor(last.time) === Math.floor(candle.time)) {
        this.candleHistory[this.candleHistory.length - 1] = candle;
      } else {
        this.candleHistory.push(candle);
      }

      const { dateInt, timeInt } = epochToIstDateAndTime(candle.time);
      const tick = {
        symbol: this.currentSymbol?.ticker || 'NIFTY',
        date: dateInt,
        time: timeInt,
        open: Number(candle.open),
        high: Number(candle.high),
        low: Number(candle.low),
        price: Number(candle.close),
        vol: Number(candle.volume) || 0,
        amount: (Number(candle.volume) || 0) * Number(candle.close),
      };

      if (typeof this.hqChart.RecvRealtimeData === 'function') {
        this.hqChart.RecvRealtimeData({ stock: [tick] });
      }
      if (typeof this.hqChart.Draw === 'function') {
        this.hqChart.Draw();
      }
      if (typeof this.options.onVisibleRangeChange === 'function') {
        this.options.onVisibleRangeChange();
      }
    }

    getDataList() {
      return this.candleHistory || [];
    }

    resize() {
      if (this.chart && typeof this.chart.OnSize === 'function') {
        this.chart.OnSize();
      } else if (this.hqChart && typeof this.hqChart.OnSize === 'function') {
        this.hqChart.OnSize();
      }
    }

    scrollToRealTime() {
      if (this.hqChart && typeof this.hqChart.Draw === 'function') {
        this.hqChart.Draw();
      }
    }

    // --- Coordinate conversions for TP/SL and Overlay Badges ---
    priceToCoordinate(price, paneHeight = null) {
      const p = Number(price);
      if (!p || p <= 0) return null;
      try {
        if (this.hqChart?.Frame?.SubFrame?.[0]?.Frame) {
          const frame = this.hqChart.Frame.SubFrame[0].Frame;
          const y = frame.GetYFromData ? frame.GetYFromData(p, false) : null;
          if (Number.isFinite(y)) {
            const totalH = this.container?.clientHeight || 420;
            const maxH = paneHeight || (totalH - 30);
            if (y < 0 || y > maxH) return { offscreen: true, coord: y };
            return { offscreen: false, y: Math.round(y) };
          }
        }
      } catch {}

      // Fallback coordinate mapping from candle history min/max
      if (this.candleHistory.length > 0) {
        let min = Infinity, max = -Infinity;
        this.candleHistory.forEach(c => {
          if (c.low < min) min = c.low;
          if (c.high > max) max = c.high;
        });
        if (max > min) {
          const totalH = this.container?.clientHeight || 420;
          const pad = 30;
          const usable = totalH - pad * 2;
          const y = pad + (1 - (p - min) / (max - min)) * usable;
          if (y < 0 || y > totalH) return { offscreen: true, coord: y };
          return { offscreen: false, y: Math.round(y) };
        }
      }
      return null;
    }

    coordinateToPrice(y) {
      const yNum = Number(y);
      if (!Number.isFinite(yNum)) return null;
      try {
        if (this.hqChart?.Frame?.SubFrame?.[0]?.Frame) {
          const frame = this.hqChart.Frame.SubFrame[0].Frame;
          const top = frame.ChartBorder?.GetTopEx?.() || 0;
          const bottom = frame.ChartBorder?.GetBottomEx?.() || (this.container?.clientHeight || 420);
          const min = frame.HorizontalMin;
          const max = frame.HorizontalMax;
          if (max > min && bottom > top) {
            const ratio = (bottom - yNum) / (bottom - top);
            return min + ratio * (max - min);
          }
        }
      } catch {}
      return null;
    }

    timeToCoordinate(timeSec) {
      const t = Number(timeSec);
      if (!t || this.candleHistory.length === 0) return null;
      const idx = this.candleHistory.findIndex(c => Math.abs(c.time - t) < 30);
      if (idx >= 0) {
        const totalW = this.container?.clientWidth || 380;
        const step = totalW / Math.max(this.candleHistory.length, 1);
        return Math.round(idx * step);
      }
      return null;
    }

    coordinateToTime(x) {
      const xNum = Number(x);
      if (!Number.isFinite(xNum) || this.candleHistory.length === 0) return null;
      const totalW = this.container?.clientWidth || 380;
      const ratio = Math.max(0, Math.min(1, xNum / totalW));
      const idx = Math.floor(ratio * (this.candleHistory.length - 1));
      return this.candleHistory[idx]?.time || null;
    }

    // --- Indicator Management ---
    createIndicator(name, isStack = null, paneOptions = {}, calcParams = null) {
      const meta = INDICATOR_REGISTRY[name];
      if (!meta) return null;
      const id = `ind_${name}_${Date.now()}`;
      this.activeIndicators.set(name, {
        id,
        name,
        isStack: isStack !== null ? isStack : meta.isStack,
        params: calcParams || meta.defaultParams,
      });

      if (this.chart) {
        try {
          if (meta.isStack && typeof this.chart.ChangeIndex === 'function') {
            this.chart.ChangeIndex(0, name);
          } else if (typeof this.chart.AddIndexWindow === 'function') {
            this.chart.AddIndexWindow(name);
          }
        } catch (e) {
          console.warn('HQChart ChangeIndex error:', e);
        }
      }
      return id;
    }

    removeIndicator(name) {
      if (!this.activeIndicators.has(name)) return false;
      this.activeIndicators.delete(name);
      if (this.chart && typeof this.chart.DeleteIndexWindow === 'function') {
        try { this.chart.DeleteIndexWindow(name); } catch {}
      }
      return true;
    }

    overrideIndicator(name, calcParams) {
      if (!this.activeIndicators.has(name) || !Array.isArray(calcParams)) return false;
      const entry = this.activeIndicators.get(name);
      entry.params = calcParams;
      return true;
    }

    getIndicators() {
      return Array.from(this.activeIndicators.values());
    }

    // --- TradingView Left Vertical Toolbar & Overlay Management ---
    setDrawingTool(toolId) {
      const toolMap = {
        cursor: 'cursor',
        trendline: '趋势线',
        ray: '射线',
        hline: '水平线',
        channel: '价格通道线',
        fib: '黄金分割',
        rect: '矩形',
        text: '文本',
        eraser: 'eraser',
        magnet: 'magnet',
        lock: 'lock',
        trash: 'trash',
      };

      if (toolId === 'cursor') {
        this.eraseActive = false;
        if (this.hqChart) {
          this.hqChart.EnableEraseChartDrawPicture = false;
          if (typeof this.hqChart.ClearCurrnetDrawPicture === 'function') {
            this.hqChart.ClearCurrnetDrawPicture();
          }
        }
        return;
      }

      if (toolId === 'trash') {
        this.clearAllOverlays();
        return;
      }

      if (toolId === 'eraser') {
        this.eraseActive = !this.eraseActive;
        if (this.hqChart) {
          this.hqChart.EnableEraseChartDrawPicture = this.eraseActive;
        }
        return;
      }

      if (toolId === 'magnet') {
        this.magnetActive = !this.magnetActive;
        if (this.hqChart && typeof this.hqChart.SetChartDrawOption === 'function') {
          this.hqChart.SetChartDrawOption({ Magnet: { Enable: this.magnetActive, Type: 0 } });
        }
        return;
      }

      if (toolId === 'lock') {
        this.lockActive = !this.lockActive;
        return;
      }

      const hqName = toolMap[toolId] || toolId;
      if (this.hqChart && typeof this.hqChart.CreateChartDrawPicture === 'function') {
        try {
          this.hqChart.CreateChartDrawPicture(hqName);
        } catch (e) {
          console.warn('CreateChartDrawPicture error:', e);
        }
      }
    }

    createOverlay(type, options = {}) {
      const id = `draw_${type}_${Date.now()}`;
      const action = { action: 'create', id, overlayDef: { name: type, ...options } };
      this.pushDrawingAction(action);
      this.setDrawingTool(type);
      return id;
    }

    removeOverlay(id) {
      const action = { action: 'remove', id };
      this.pushDrawingAction(action);
      return true;
    }

    clearAllOverlays() {
      this.pushDrawingAction({ action: 'clear' });
      if (this.hqChart && typeof this.hqChart.ClearChartDrawPicture === 'function') {
        try {
          this.hqChart.ClearChartDrawPicture();
        } catch {}
      }
      const svg = document.getElementById('drawing-svg-layer');
      if (svg) svg.innerHTML = '';
    }

    getOverlays() {
      return [];
    }

    pushDrawingAction(action) {
      this.undoStack.push(action);
      if (this.undoStack.length > this.drawingHistoryLimit) {
        this.undoStack.shift();
      }
      this.redoStack = [];
    }

    undoDrawing() {
      if (this.undoStack.length === 0) return false;
      const action = this.undoStack.pop();
      this.redoStack.push(action);
      return true;
    }

    redoDrawing() {
      if (this.redoStack.length === 0) return false;
      const action = this.redoStack.pop();
      this.undoStack.push(action);
      return true;
    }

    destroy() {
      if (this.chart) {
        try {
          if (typeof this.chart.Destroy === 'function') this.chart.Destroy();
        } catch {}
      }
      this.chart = null;
      this.hqChart = null;
      this.activeIndicators.clear();
      this.candleHistory = [];
    }
  }

  // Alias for backward-compatibility with previous adapter callers & test suites
  const KLineChartAdapter = HQChartAdapter;

  // =========================================================================
  // UNIFIED SIKHO CHART ADAPTER MANAGER
  // =========================================================================
  const SikhoChartAdapter = {
    INDICATOR_REGISTRY,
    DRAWING_TOOL_CATEGORIES,

    getEngine() {
      try {
        const stored = localStorage.getItem(STORAGE_KEY_ENGINE);
        if (stored === 'lightweight') return 'lightweight';
        if (stored === 'hqchart' || stored === 'klinechart') return 'hqchart';
      } catch {}
      return DEFAULT_ENGINE;
    },

    setEngine(engine) {
      const normalized = (engine === 'klinechart' || engine === 'hqchart') ? 'hqchart' : 'lightweight';
      try {
        localStorage.setItem(STORAGE_KEY_ENGINE, normalized);
      } catch {}
    },

    createAdapter(engine = null) {
      const active = engine || this.getEngine();
      if (active === 'hqchart' || active === 'klinechart') {
        return new HQChartAdapter();
      }
      return null;
    },

    // User Indicator Preferences Persistence
    getUserIndicatorSettings(userId) {
      const key = `${STORAGE_KEY_INDICATORS}_${userId || 'anon'}`;
      try {
        const raw = localStorage.getItem(key);
        if (raw) return JSON.parse(raw);
      } catch {}
      return {
        active: ['BOLL', 'RSI'],
        params: {
          BOLL: [20, 2],
          RSI: [14],
        },
      };
    },

    saveUserIndicatorSettings(userId, settings) {
      const key = `${STORAGE_KEY_INDICATORS}_${userId || 'anon'}`;
      try {
        localStorage.setItem(key, JSON.stringify(settings));
      } catch {}
    },

    // User Favorites Persistence
    getUserFavorites(userId) {
      const key = `${STORAGE_KEY_FAVORITES}_${userId || 'anon'}`;
      try {
        const raw = localStorage.getItem(key);
        if (raw) return JSON.parse(raw);
      } catch {}
      return ['MA', 'EMA', 'BOLL', 'RSI', 'MACD', 'VWAP', 'ATR', 'VOL'];
    },

    saveUserFavorites(userId, favs) {
      const key = `${STORAGE_KEY_FAVORITES}_${userId || 'anon'}`;
      try {
        localStorage.setItem(key, JSON.stringify(favs));
      } catch {}
    },
  };

  global.SikhoChartAdapter = SikhoChartAdapter;
  global.HQChartAdapter = HQChartAdapter;
  global.KLineChartAdapter = KLineChartAdapter;
})(typeof window !== 'undefined' ? window : globalThis);
