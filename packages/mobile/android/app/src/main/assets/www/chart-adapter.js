/**
 * Sikho Trading — Professional Mobile Chart Adapter & KLineChart Integration
 * Supported Engines: 'klinechart' (v10.1.1 pinned, default) and 'lightweight' (rollback)
 * Apache-2.0 License preserved.
 */
(function (global) {
  'use strict';

  // =========================================================================
  // 1. CONSTANTS & METADATA
  // =========================================================================
  const DEFAULT_ENGINE = 'klinechart';
  const STORAGE_KEY_ENGINE = 'tz_chart_engine';
  const STORAGE_KEY_INDICATORS = 'tz_kline_indicators_v2';
  const STORAGE_KEY_FAVORITES = 'tz_kline_favorites_v2';
  const STORAGE_KEY_DRAWINGS = 'tz_kline_drawings_v2';

  // Indicator Registry with detailed category, param schemas and descriptions
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

    // --- Oscillators (Lower Sub-Panes) ---
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
      label: 'KDJ (Stochastic Oscillator)',
      category: 'oscillator',
      series: 'normal',
      isStack: false,
      description: 'Fast momentum oscillator identifying short-term overbought/oversold turns.',
      requiresVolume: false,
      defaultParams: [9, 3, 3],
      paramDefs: [
        { name: 'Period', min: 2, max: 100, step: 1 },
        { name: 'M1', min: 1, max: 50, step: 1 },
        { name: 'M2', min: 1, max: 50, step: 1 },
      ],
    },
    ATR: {
      name: 'ATR',
      label: 'Average True Range (ATR)',
      category: 'oscillator',
      series: 'normal',
      isStack: false,
      description: 'Wilder volatility gauge measuring absolute candle range in INR.',
      requiresVolume: false,
      defaultParams: [14],
      paramDefs: [{ name: 'Period', min: 2, max: 100, step: 1 }],
    },
    CCI: {
      name: 'CCI',
      label: 'Commodity Channel Index',
      category: 'oscillator',
      series: 'normal',
      isStack: false,
      description: 'Identifies cyclical price trends and deviations from statistical means.',
      requiresVolume: false,
      defaultParams: [20],
      paramDefs: [{ name: 'Period', min: 2, max: 200, step: 1 }],
    },
    WR: {
      name: 'WR',
      label: 'Williams %R',
      category: 'oscillator',
      series: 'normal',
      isStack: false,
      description: 'Momentum indicator reflecting the market close relative to the high-low range.',
      requiresVolume: false,
      defaultParams: [14],
      paramDefs: [{ name: 'Period', min: 2, max: 100, step: 1 }],
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

  // =========================================================================
  // 2. REGISTER CUSTOM INDICATORS & OVERLAYS IN KLINECHART
  // =========================================================================
  function registerCustomKLineExtensions(kl) {
    if (!kl || typeof kl.registerIndicator !== 'function') return;

    // A. Custom ATR Indicator (Average True Range)
    try {
      kl.registerIndicator({
        name: 'ATR',
        shortName: 'ATR',
        series: 'normal',
        calcParams: [14],
        precision: 2,
        shouldOhlc: true,
        figures: [{ key: 'atr', title: 'ATR: ', type: 'line' }],
        calc: (dataList, indicator) => {
          const period = (indicator.calcParams && indicator.calcParams[0]) || 14;
          let prevClose = null;
          let trSum = 0;
          let prevAtr = null;
          return dataList.map((k, i) => {
            const h = k.high;
            const l = k.low;
            let tr = h - l;
            if (prevClose !== null) {
              tr = Math.max(h - l, Math.abs(h - prevClose), Math.abs(l - prevClose));
            }
            prevClose = k.close;
            trSum += tr;

            const res = {};
            if (i >= period - 1) {
              if (prevAtr === null) {
                prevAtr = trSum / period;
              } else {
                prevAtr = (prevAtr * (period - 1) + tr) / period;
              }
              res.atr = Number(prevAtr.toFixed(2));
            }
            return res;
          });
        },
      });
    } catch {}

    // B. Custom VWAP Indicator (Volume-Weighted Average Price anchored to IST session)
    try {
      kl.registerIndicator({
        name: 'VWAP',
        shortName: 'VWAP',
        series: 'price',
        calcParams: [],
        precision: 2,
        shouldOhlc: true,
        figures: [{ key: 'vwap', title: 'VWAP: ', type: 'line' }],
        calc: (dataList) => {
          let cumVol = 0;
          let cumTpVol = 0;
          let currentSessionDate = '';
          return dataList.map((k) => {
            // Anchor to IST session date (UTC + 5:30)
            const istDate = new Date(k.timestamp + 19800000);
            const sessionDate = `${istDate.getUTCFullYear()}-${istDate.getUTCMonth() + 1}-${istDate.getUTCDate()}`;
            if (sessionDate !== currentSessionDate) {
              currentSessionDate = sessionDate;
              cumVol = 0;
              cumTpVol = 0;
            }
            const vol = Number(k.volume) || 0;
            if (vol <= 0) {
              // Volume unavailable (e.g. index spot); do not invent volume
              return {};
            }
            const tp = (k.high + k.low + k.close) / 3;
            cumVol += vol;
            cumTpVol += tp * vol;
            return cumVol > 0 ? { vwap: Number((cumTpVol / cumVol).toFixed(2)) } : {};
          });
        },
      });
    } catch {}

    // C. Custom Rectangle Zone Overlay (Supply / Demand consolidation box)
    try {
      kl.registerOverlay({
        name: 'rectZone',
        totalStep: 3,
        needDefaultPointFigure: true,
        needDefaultXAxisFigure: true,
        needDefaultYAxisFigure: true,
        createPointFigures: ({ coordinates }) => {
          if (coordinates.length >= 2) {
            const x = Math.min(coordinates[0].x, coordinates[1].x);
            const y = Math.min(coordinates[0].y, coordinates[1].y);
            const width = Math.abs(coordinates[0].x - coordinates[1].x);
            const height = Math.abs(coordinates[0].y - coordinates[1].y);
            return [
              {
                type: 'rect',
                attrs: { x, y, width, height },
                styles: {
                  style: 'stroke_fill',
                  color: 'rgba(59, 130, 246, 0.16)',
                  borderColor: '#3B82F6',
                  borderSize: 1.5,
                  borderDashedValue: [4, 4],
                },
              },
            ];
          }
          return [];
        },
      });
    } catch {}

    // D. Custom Circle Zone Overlay (Pivot zone / target)
    try {
      kl.registerOverlay({
        name: 'circleZone',
        totalStep: 3,
        needDefaultPointFigure: true,
        needDefaultXAxisFigure: true,
        needDefaultYAxisFigure: true,
        createPointFigures: ({ coordinates }) => {
          if (coordinates.length >= 2) {
            const c0 = coordinates[0];
            const c1 = coordinates[1];
            const r = Math.hypot(c0.x - c1.x, c0.y - c1.y);
            return [
              {
                type: 'circle',
                attrs: { x: c0.x, y: c0.y, r },
                styles: {
                  style: 'stroke_fill',
                  color: 'rgba(234, 179, 8, 0.16)',
                  borderColor: '#EAB308',
                  borderSize: 1.5,
                },
              },
            ];
          }
          return [];
        },
      });
    } catch {}

    // E. Custom Price & Date Measurement Overlay
    try {
      kl.registerOverlay({
        name: 'priceMeasurement',
        totalStep: 3,
        needDefaultPointFigure: true,
        needDefaultXAxisFigure: true,
        needDefaultYAxisFigure: true,
        createPointFigures: ({ coordinates, overlay }) => {
          if (coordinates.length >= 2) {
            const c1 = coordinates[0];
            const c2 = coordinates[1];
            const x = Math.min(c1.x, c2.x);
            const y = Math.min(c1.y, c2.y);
            const width = Math.abs(c1.x - c2.x);
            const height = Math.abs(c1.y - c2.y);

            const p1 = overlay.points?.[0];
            const p2 = overlay.points?.[1];
            const priceDiff = (p2?.value || 0) - (p1?.value || 0);
            const pct = p1?.value ? (priceDiff / p1.value) * 100 : 0;
            const sign = priceDiff >= 0 ? '+' : '';
            const isPos = priceDiff >= 0;

            const label = `${sign}₹${priceDiff.toFixed(2)} (${sign}${pct.toFixed(2)}%)`;
            return [
              {
                type: 'rect',
                attrs: { x, y, width, height },
                styles: {
                  style: 'stroke_fill',
                  color: isPos ? 'rgba(16, 185, 129, 0.12)' : 'rgba(239, 68, 68, 0.12)',
                  borderColor: isPos ? '#10B981' : '#EF4444',
                  borderSize: 1.5,
                },
              },
              {
                type: 'text',
                attrs: {
                  x: x + 6,
                  y: y + 18,
                  text: label,
                },
                styles: {
                  color: isPos ? '#10B981' : '#EF4444',
                  size: 11,
                  weight: 'bold',
                  family: 'system-ui, sans-serif',
                },
              },
            ];
          }
          return [];
        },
      });
    } catch {}

    // F. Custom Long Risk/Reward Planning Tool (Visual Analysis Only)
    try {
      kl.registerOverlay({
        name: 'riskRewardLong',
        totalStep: 3,
        needDefaultPointFigure: true,
        needDefaultXAxisFigure: true,
        needDefaultYAxisFigure: true,
        createPointFigures: ({ coordinates, overlay }) => {
          if (coordinates.length >= 2) {
            const p1 = overlay.points?.[0]; // Entry
            const p2 = overlay.points?.[1]; // Target
            if (!p1 || !p2) return [];
            const entryY = coordinates[0].y;
            const targetY = coordinates[1].y;
            const leftX = Math.min(coordinates[0].x, coordinates[1].x);
            const width = Math.max(Math.abs(coordinates[0].x - coordinates[1].x), 80);

            const ep = p1.value || 0;
            const tp = p2.value || 0;
            const reward = Math.abs(tp - ep);
            const risk = reward / 2; // Default 1:2 R:R target
            const sl = ep - risk;

            const targetTop = Math.min(entryY, targetY);
            const targetHeight = Math.abs(entryY - targetY);
            const riskHeight = targetHeight / 2;

            return [
              // Target Profit Zone (Green)
              {
                type: 'rect',
                attrs: { x: leftX, y: targetTop, width, height: targetHeight },
                styles: {
                  style: 'stroke_fill',
                  color: 'rgba(16, 185, 129, 0.18)',
                  borderColor: '#10B981',
                  borderSize: 1.5,
                },
              },
              // Stop Loss Zone (Red)
              {
                type: 'rect',
                attrs: { x: leftX, y: Math.max(entryY, targetY), width, height: riskHeight },
                styles: {
                  style: 'stroke_fill',
                  color: 'rgba(239, 68, 68, 0.18)',
                  borderColor: '#EF4444',
                  borderSize: 1.5,
                },
              },
              // Info Text
              {
                type: 'text',
                attrs: {
                  x: leftX + 8,
                  y: targetTop + 16,
                  text: `LONG R:R 1:2.0 · Target ₹${tp.toFixed(2)} (+₹${reward.toFixed(2)})`,
                },
                styles: { color: '#10B981', size: 11, weight: 'bold' },
              },
            ];
          }
          return [];
        },
      });
    } catch {}

    // G. Custom Short Risk/Reward Planning Tool (Visual Analysis Only)
    try {
      kl.registerOverlay({
        name: 'riskRewardShort',
        totalStep: 3,
        needDefaultPointFigure: true,
        needDefaultXAxisFigure: true,
        needDefaultYAxisFigure: true,
        createPointFigures: ({ coordinates, overlay }) => {
          if (coordinates.length >= 2) {
            const p1 = overlay.points?.[0];
            const p2 = overlay.points?.[1];
            if (!p1 || !p2) return [];
            const entryY = coordinates[0].y;
            const targetY = coordinates[1].y;
            const leftX = Math.min(coordinates[0].x, coordinates[1].x);
            const width = Math.max(Math.abs(coordinates[0].x - coordinates[1].x), 80);

            const ep = p1.value || 0;
            const tp = p2.value || 0;
            const reward = Math.abs(ep - tp);
            const risk = reward / 2;

            const targetTop = Math.min(entryY, targetY);
            const targetHeight = Math.abs(entryY - targetY);
            const riskHeight = targetHeight / 2;

            return [
              // Target Profit Zone (Green, downward)
              {
                type: 'rect',
                attrs: { x: leftX, y: Math.max(entryY, targetY), width, height: targetHeight },
                styles: {
                  style: 'stroke_fill',
                  color: 'rgba(16, 185, 129, 0.18)',
                  borderColor: '#10B981',
                  borderSize: 1.5,
                },
              },
              // Stop Loss Zone (Red, upward)
              {
                type: 'rect',
                attrs: { x: leftX, y: targetTop - riskHeight, width, height: riskHeight },
                styles: {
                  style: 'stroke_fill',
                  color: 'rgba(239, 68, 68, 0.18)',
                  borderColor: '#EF4444',
                  borderSize: 1.5,
                },
              },
              // Info Text
              {
                type: 'text',
                attrs: {
                  x: leftX + 8,
                  y: Math.max(entryY, targetY) + 16,
                  text: `SHORT R:R 1:2.0 · Target ₹${tp.toFixed(2)} (+₹${reward.toFixed(2)})`,
                },
                styles: { color: '#10B981', size: 11, weight: 'bold' },
              },
            ];
          }
          return [];
        },
      });
    } catch {}
  }

  // =========================================================================
  // 3. KLINECHART ADAPTER CLASS
  // =========================================================================
  class KLineChartAdapter {
    constructor() {
      this.engine = 'klinechart';
      this.chart = null;
      this.container = null;
      this.tickSubscriber = null;
      this.activeIndicators = new Map(); // indicatorName -> { id, paneId, isStack, params }
      this.undoStack = [];
      this.redoStack = [];
      this.drawingHistoryLimit = 20;
      this.currentSymbol = null;
      this.currentPeriod = null;
    }

    init(containerEl, options = {}) {
      if (!global.klinecharts) {
        throw new Error('KLineChart library not loaded');
      }
      this.container = typeof containerEl === 'string' ? document.getElementById(containerEl) : containerEl;
      if (!this.container) return null;

      const isDark = options.isDark !== false;
      this.container.style.backgroundColor = isDark ? '#0B1220' : '#F6F8FC';

      // Register custom indicators and overlays on klinecharts engine
      registerCustomKLineExtensions(global.klinecharts);

      // Clean container of any stale elements
      this.container.innerHTML = '';

      // Initialize KLineChart instance
      this.chart = global.klinecharts.init(this.container, {
        timezone: 'Asia/Kolkata',
        styles: this.getThemeStyles(isDark),
      });

      // Bind crosshair action
      this.chart.subscribeAction('onCrosshairChange', (param) => {
        if (typeof options.onCrosshair === 'function') {
          options.onCrosshair(param);
        }
      });

      // Bind visible range change for scrolling/pagination/TP-SL sync
      this.chart.subscribeAction('onVisibleRangeChange', (param) => {
        if (typeof options.onVisibleRangeChange === 'function') {
          options.onVisibleRangeChange(param);
        }
      });

      return this.chart;
    }

    getThemeStyles(isDark) {
      if (isDark) {
        return {
          grid: {
            show: true,
            horizontal: { color: 'rgba(255, 255, 255, 0.05)', size: 1 },
            vertical: { color: 'rgba(255, 255, 255, 0.05)', size: 1 },
          },
          candle: {
            type: 'candle_solid',
            bar: {
              upColor: '#34D399',
              downColor: '#FB7185',
              noChangeColor: '#888888',
              upBorderColor: '#34D399',
              downBorderColor: '#FB7185',
              noChangeBorderColor: '#888888',
              upWickColor: '#34D399',
              downWickColor: '#FB7185',
              noChangeWickColor: '#888888',
            },
            priceMark: {
              last: {
                show: true,
                upColor: '#34D399',
                downColor: '#FB7185',
                noChangeColor: '#888888',
                line: { show: true, style: 'dashed', dashedValue: [3, 3] },
                text: { color: '#FFFFFF', size: 11, paddingLeft: 4, paddingRight: 4 },
              },
            },
            tooltip: {
              showRule: 'none', // Handled by app's native OHLC legend bar
            },
          },
          xAxis: {
            show: true,
            axisLine: { color: '#30415B', size: 1 },
            tickText: { color: '#B2BFD1', size: 11 },
          },
          yAxis: {
            show: true,
            axisLine: { color: '#30415B', size: 1 },
            tickText: { color: '#B2BFD1', size: 11 },
          },
          separator: {
            color: '#30415B',
            size: 1,
          },
          crosshair: {
            show: true,
            horizontal: {
              line: { color: 'rgba(241, 245, 249, 0.35)', style: 'dashed', dashedValue: [3, 3] },
              text: { color: '#F1F5F9', backgroundColor: '#1B283D' },
            },
            vertical: {
              line: { color: 'rgba(241, 245, 249, 0.35)', style: 'dashed', dashedValue: [3, 3] },
              text: { color: '#F1F5F9', backgroundColor: '#1B283D' },
            },
          },
          overlay: {
            point: { color: '#60A5FA', borderColor: '#FFFFFF', radius: 4 },
            line: { color: '#60A5FA', size: 1.5 },
          },
        };
      } else {
        return {
          grid: {
            show: true,
            horizontal: { color: 'rgba(0, 0, 0, 0.05)', size: 1 },
            vertical: { color: 'rgba(0, 0, 0, 0.05)', size: 1 },
          },
          candle: {
            type: 'candle_solid',
            bar: {
              upColor: '#047857',
              downColor: '#BE123C',
              noChangeColor: '#666666',
              upBorderColor: '#047857',
              downBorderColor: '#BE123C',
              noChangeBorderColor: '#666666',
              upWickColor: '#047857',
              downWickColor: '#BE123C',
              noChangeWickColor: '#666666',
            },
            priceMark: {
              last: {
                show: true,
                upColor: '#047857',
                downColor: '#BE123C',
                noChangeColor: '#666666',
                line: { show: true, style: 'dashed', dashedValue: [3, 3] },
                text: { color: '#FFFFFF', size: 11, paddingLeft: 4, paddingRight: 4 },
              },
            },
            tooltip: {
              showRule: 'none',
            },
          },
          xAxis: {
            show: true,
            axisLine: { color: '#D8E0EB', size: 1 },
            tickText: { color: '#526176', size: 11 },
          },
          yAxis: {
            show: true,
            axisLine: { color: '#D8E0EB', size: 1 },
            tickText: { color: '#526176', size: 11 },
          },
          separator: {
            color: '#D8E0EB',
            size: 1,
          },
          crosshair: {
            show: true,
            horizontal: {
              line: { color: 'rgba(23, 32, 51, 0.35)', style: 'dashed', dashedValue: [3, 3] },
              text: { color: '#FFFFFF', backgroundColor: '#172033' },
            },
            vertical: {
              line: { color: 'rgba(23, 32, 51, 0.35)', style: 'dashed', dashedValue: [3, 3] },
              text: { color: '#FFFFFF', backgroundColor: '#172033' },
            },
          },
          overlay: {
            point: { color: '#1D4ED8', borderColor: '#FFFFFF', radius: 4 },
            line: { color: '#1D4ED8', size: 1.5 },
          },
        };
      }
    }

    setTheme(isDark) {
      if (this.container) {
        this.container.style.backgroundColor = isDark ? '#0B1220' : '#F6F8FC';
      }
      if (!this.chart) return;
      this.chart.setStyles(this.getThemeStyles(isDark));
    }

    parsePeriod(tf) {
      if (!tf) return { multiplier: 5, timespan: 'minute' };
      const num = parseInt(tf, 10);
      if (tf.endsWith('m')) return { multiplier: num || 5, timespan: 'minute' };
      if (tf.endsWith('h')) return { multiplier: num || 1, timespan: 'hour' };
      if (tf.endsWith('D')) return { multiplier: num || 1, timespan: 'day' };
      if (tf.endsWith('W')) return { multiplier: num || 1, timespan: 'week' };
      return { multiplier: 5, timespan: 'minute' };
    }

    bindDataLoader(loader) {
      if (!this.chart) return;
      this.chart.setDataLoader({
        getBars: (params) => {
          if (typeof loader.getBars === 'function') {
            loader.getBars(params);
          }
        },
        subscribeBar: (params) => {
          this.tickSubscriber = params.callback;
        },
        unsubscribeBar: () => {
          this.tickSubscriber = null;
        },
      });
    }

    setInstrumentAndPeriod(inst, tf) {
      if (!this.chart) return;
      const precision = Number(inst.pricePrecision) || 2;
      this.currentSymbol = {
        ticker: inst.symbol || inst.name || inst.globalId,
        pricePrecision: precision,
        volumePrecision: 0,
      };
      this.currentPeriod = this.parsePeriod(tf);
      this.chart.setSymbol(this.currentSymbol);
      this.chart.setPeriod(this.currentPeriod);
    }

    applyNewData(candles, more = false) {
      if (!this.chart || !Array.isArray(candles)) return;
      // Convert candles to KLineChart milliseconds format
      const formatted = candles.map((c) => ({
        timestamp: c.time > 1e11 ? c.time : c.time * 1000,
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
        volume: Number(c.volume) || 0,
      }));

      // Set via resetData and internal dataLoader callback
      if (this.tickSubscriber) {
        // Real-time mode via loader
      }
      this.chart.resetData();
      if (this.chart.getChartStore && typeof this.chart.getChartStore()._addData === 'function') {
        this.chart.getChartStore()._addData(formatted, 'init', more);
      }
    }

    appendOlderData(candles) {
      if (!this.chart || !Array.isArray(candles) || candles.length === 0) return;
      const formatted = candles.map((c) => ({
        timestamp: c.time > 1e11 ? c.time : c.time * 1000,
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
        volume: Number(c.volume) || 0,
      }));
      if (this.chart.getChartStore && typeof this.chart.getChartStore()._addData === 'function') {
        this.chart.getChartStore()._addData(formatted, 'backward', true);
      }
    }

    updateData(candle) {
      if (!this.chart || !candle) return;
      const formatted = {
        timestamp: candle.time > 1e11 ? candle.time : candle.time * 1000,
        open: Number(candle.open),
        high: Number(candle.high),
        low: Number(candle.low),
        close: Number(candle.close),
        volume: Number(candle.volume) || 0,
      };
      if (typeof this.tickSubscriber === 'function') {
        this.tickSubscriber(formatted);
      } else if (this.chart.getChartStore && typeof this.chart.getChartStore()._addData === 'function') {
        this.chart.getChartStore()._addData(formatted, 'update');
      }
    }

    getDataList() {
      if (!this.chart) return [];
      return this.chart.getDataList() || [];
    }

    resize() {
      if (!this.chart) return;
      this.chart.resize();
    }

    scrollToRealTime() {
      if (!this.chart) return;
      this.chart.scrollToRealTime(0);
    }

    // --- Coordinate conversions for TP/SL and Drawings ---
    priceToCoordinate(price, paneHeight = null) {
      if (!this.chart || !(Number(price) > 0)) return null;
      try {
        const coord = this.chart.convertToPixel({ value: Number(price) }, { paneId: 'candle_pane', absolute: true });
        if (!coord || !Number.isFinite(coord.y)) return null;
        const totalHeight = this.container?.clientHeight || 420;
        const limitHeight = paneHeight || (totalHeight - 30);
        if (coord.y < 0 || coord.y > limitHeight) {
          return { offscreen: true, coord: coord.y };
        }
        return { offscreen: false, y: Math.round(coord.y) };
      } catch {
        return null;
      }
    }

    coordinateToPrice(y) {
      if (!this.chart || !Number.isFinite(y)) return null;
      try {
        const pt = this.chart.convertFromPixel({ y: Number(y) }, { paneId: 'candle_pane', absolute: true });
        return pt?.value ? Number(pt.value) : null;
      } catch {
        return null;
      }
    }

    timeToCoordinate(timeSec) {
      if (!this.chart || !(Number(timeSec) > 0)) return null;
      try {
        const tsMs = timeSec > 1e11 ? timeSec : timeSec * 1000;
        const coord = this.chart.convertToPixel({ timestamp: tsMs }, { paneId: 'candle_pane', absolute: true });
        return coord?.x ? Math.round(coord.x) : null;
      } catch {
        return null;
      }
    }

    coordinateToTime(x) {
      if (!this.chart || !Number.isFinite(x)) return null;
      try {
        const pt = this.chart.convertFromPixel({ x: Number(x) }, { paneId: 'candle_pane', absolute: true });
        return pt?.timestamp ? Math.floor(pt.timestamp / 1000) : null;
      } catch {
        return null;
      }
    }

    // --- Indicator Management ---
    createIndicator(name, isStack = null, paneOptions = {}, calcParams = null) {
      if (!this.chart) return null;
      const meta = INDICATOR_REGISTRY[name];
      if (!meta) return null;

      const stack = isStack !== null ? isStack : meta.isStack;
      const targetPane = stack ? 'candle_pane' : (paneOptions.id || null);

      const indConfig = {
        name,
        paneId: targetPane,
      };
      if (Array.isArray(calcParams)) {
        indConfig.calcParams = calcParams;
      }

      const id = this.chart.createIndicator(indConfig, stack, paneOptions);
      if (id) {
        this.activeIndicators.set(name, { id, name, isStack: stack, paneId: targetPane, params: calcParams || meta.defaultParams });
      }
      return id;
    }

    removeIndicator(name) {
      if (!this.chart) return false;
      const entry = this.activeIndicators.get(name);
      if (!entry) return false;
      const removed = this.chart.removeIndicator({ name });
      this.activeIndicators.delete(name);
      return removed;
    }

    overrideIndicator(name, calcParams) {
      if (!this.chart || !Array.isArray(calcParams)) return false;
      const entry = this.activeIndicators.get(name);
      if (!entry) return false;
      const res = this.chart.overrideIndicator({
        name,
        calcParams,
      });
      entry.params = calcParams;
      return res;
    }

    getIndicators() {
      if (!this.chart) return [];
      return this.chart.getIndicators() || [];
    }

    setDrawingTool(toolId) {
      if (!this.chart) return;
      this.activeTool = toolId;
      const toolMap = {
        cursor: null,
        trendline: 'straightLine',
        ray: 'rayLine',
        hline: 'horizontalStraightLine',
        channel: 'parallelStraightLine',
        fib: 'fibonacciLine',
        rect: 'rectZone',
        text: 'simpleAnnotation',
      };
      if (toolId === 'cursor') {
        return;
      }
      if (toolId === 'trash') {
        this.clearAllOverlays();
        return;
      }
      if (toolId === 'eraser') {
        const overlays = this.getOverlays();
        if (overlays.length > 0) {
          this.removeOverlay(overlays[overlays.length - 1].id);
        }
        return;
      }
      if (toolId === 'lock') {
        this.isLocked = !this.isLocked;
        const overlays = this.getOverlays();
        overlays.forEach((o) => {
          try {
            if (typeof this.chart.overrideOverlay === 'function') {
              this.chart.overrideOverlay({ id: o.id, lock: this.isLocked });
            }
          } catch {}
        });
        return;
      }
      if (toolId === 'magnet') {
        this.magnetMode = !this.magnetMode;
        return;
      }
      const overlayName = toolMap[toolId] || toolId;
      this.createOverlay(overlayName);
    }

    zoomIn() {
      if (!this.chart) return;
      try {
        if (typeof this.chart.zoomAtCoordinate === 'function') {
          this.chart.zoomAtCoordinate(0.2, { x: 200, y: 150 });
        }
      } catch {}
    }

    zoomOut() {
      if (!this.chart) return;
      try {
        if (typeof this.chart.zoomAtCoordinate === 'function') {
          this.chart.zoomAtCoordinate(-0.2, { x: 200, y: 150 });
        }
      } catch {}
    }

    // --- Drawing Overlay Management ---
    createOverlay(type, options = {}) {
      if (!this.chart) return null;
      const overlayDef = {
        name: type,
        lock: Boolean(options.lock),
        visible: options.visible !== false,
        points: options.points || [],
      };
      if (options.styles) {
        overlayDef.styles = options.styles;
      }
      const id = this.chart.createOverlay(overlayDef);
      if (id && !options.skipHistory) {
        this.pushDrawingAction({ action: 'create', id, overlayDef });
      }
      return id;
    }

    removeOverlay(id) {
      if (!this.chart || !id) return false;
      const overlays = this.chart.getOverlays() || [];
      const target = overlays.find((o) => o.id === id);
      if (target) {
        this.pushDrawingAction({ action: 'remove', id, overlayDef: { ...target } });
      }
      return this.chart.removeOverlay(id);
    }

    clearAllOverlays() {
      if (!this.chart) return;
      const overlays = this.chart.getOverlays() || [];
      if (overlays.length > 0) {
        this.pushDrawingAction({ action: 'clear', overlays: overlays.map((o) => ({ ...o })) });
      }
      this.chart.removeOverlay();
    }

    getOverlays() {
      if (!this.chart) return [];
      return this.chart.getOverlays() || [];
    }

    pushDrawingAction(action) {
      this.undoStack.push(action);
      if (this.undoStack.length > this.drawingHistoryLimit) {
        this.undoStack.shift();
      }
      this.redoStack = []; // Clear redo stack on new action
    }

    undoDrawing() {
      if (!this.chart || this.undoStack.length === 0) return false;
      const action = this.undoStack.pop();
      if (action.action === 'create') {
        this.chart.removeOverlay(action.id);
        this.redoStack.push(action);
        return true;
      } else if (action.action === 'remove') {
        const newId = this.chart.createOverlay(action.overlayDef);
        action.id = newId;
        this.redoStack.push(action);
        return true;
      } else if (action.action === 'clear') {
        (action.overlays || []).forEach((o) => this.chart.createOverlay(o));
        this.redoStack.push(action);
        return true;
      }
      return false;
    }

    redoDrawing() {
      if (!this.chart || this.redoStack.length === 0) return false;
      const action = this.redoStack.pop();
      if (action.action === 'create') {
        const newId = this.chart.createOverlay(action.overlayDef);
        action.id = newId;
        this.undoStack.push(action);
        return true;
      } else if (action.action === 'remove') {
        this.chart.removeOverlay(action.id);
        this.undoStack.push(action);
        return true;
      } else if (action.action === 'clear') {
        this.chart.removeOverlay();
        this.undoStack.push(action);
        return true;
      }
      return false;
    }

    destroy() {
      if (!this.chart) return;
      try {
        if (global.klinecharts && typeof global.klinecharts.dispose === 'function') {
          global.klinecharts.dispose(this.container || 'tv-main-chart');
        } else if (typeof this.chart.destroy === 'function') {
          this.chart.destroy();
        }
      } catch {}
      this.chart = null;
      this.activeIndicators.clear();
      this.tickSubscriber = null;
    }
  }

  // =========================================================================
  // 4. UNIFIED SIKHO CHART ADAPTER MANAGER
  // =========================================================================
  const SikhoChartAdapter = {
    INDICATOR_REGISTRY,
    DRAWING_TOOL_CATEGORIES,

    getEngine() {
      try {
        const stored = localStorage.getItem(STORAGE_KEY_ENGINE);
        if (stored === 'lightweight' || stored === 'klinechart') return stored;
      } catch {}
      return DEFAULT_ENGINE;
    },

    setEngine(engine) {
      if (engine !== 'klinechart' && engine !== 'lightweight') return;
      try {
        localStorage.setItem(STORAGE_KEY_ENGINE, engine);
      } catch {}
    },

    createAdapter(engine = null) {
      const active = engine || this.getEngine();
      if (active === 'klinechart') {
        return new KLineChartAdapter();
      }
      // Lightweight charts fallback adapter
      return null;
    },

    // User Indicator Preferences Persistence
    getUserIndicatorSettings(userId) {
      const key = `${STORAGE_KEY_INDICATORS}_${userId || 'anon'}`;
      try {
        const raw = localStorage.getItem(key);
        if (raw) return JSON.parse(raw);
      } catch {}
      // Defaults: BOLL and RSI
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

  // Expose to window / global
  global.SikhoChartAdapter = SikhoChartAdapter;
})(typeof window !== 'undefined' ? window : globalThis);
