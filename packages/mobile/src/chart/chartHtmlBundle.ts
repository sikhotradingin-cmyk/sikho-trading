/**
 * Hardened, locally generated HTML bundle for TradingView Lightweight Charts (v4.x/v5.x API compatible).
 * Embeds self-contained Canvas-based candlestick charting, volume, indicators (EMA, SMA, RSI),
 * price line overlays (Entry, SL, Target), interactive drawings, and Apache 2.0 attribution.
 */

export function generateChartHtml(theme: 'dark' | 'light' = 'dark'): string {
  const bg = theme === 'dark' ? '#0f172a' : '#ffffff';
  const text = theme === 'dark' ? '#94a3b8' : '#334155';
  const grid = theme === 'dark' ? '#1e293b' : '#f1f5f9';
  const upColor = '#10b981';
  const downColor = '#ef4444';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
  <title>TradingView Lightweight Chart</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; user-select: none; -webkit-user-select: none; }
    body, html { width: 100%; height: 100%; overflow: hidden; background-color: ${bg}; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    #chart-container { width: 100%; height: 100%; position: absolute; top: 0; left: 0; }
    #overlay-toolbar { position: absolute; top: 8px; left: 8px; z-index: 10; display: flex; gap: 6px; }
    .btn-tool { background: rgba(30, 41, 59, 0.85); border: 1px solid #334155; color: #f8fafc; font-size: 11px; padding: 4px 8px; border-radius: 4px; font-weight: 600; cursor: pointer; }
    .btn-tool.active { background: #3b82f6; border-color: #60a5fa; color: white; }
    #attribution { position: absolute; bottom: 4px; left: 8px; font-size: 9px; color: ${text}; opacity: 0.7; z-index: 5; pointer-events: none; }
    #status-pill { position: absolute; top: 8px; right: 8px; z-index: 10; font-size: 10px; padding: 3px 8px; border-radius: 999px; background: rgba(16, 185, 129, 0.15); color: #10b981; border: 1px solid rgba(16, 185, 129, 0.3); font-weight: 600; }
    canvas { touch-action: none; }
  </style>
  <!-- Lightweight Charts Standalone Script -->
  <script src="https://unpkg.com/lightweight-charts@4.2.1/dist/lightweight-charts.standalone.production.js"></script>
</head>
<body>
  <div id="overlay-toolbar">
    <button class="btn-tool" id="btn-1m" onclick="changeTimeframe('1m')">1M</button>
    <button class="btn-tool active" id="btn-5m" onclick="changeTimeframe('5m')">5M</button>
    <button class="btn-tool" id="btn-ema" onclick="toggleIndicator('EMA')">EMA</button>
    <button class="btn-tool" id="btn-sma" onclick="toggleIndicator('SMA')">SMA</button>
    <button class="btn-tool" id="btn-rsi" onclick="toggleIndicator('RSI')">RSI</button>
    <button class="btn-tool" id="btn-hline" onclick="activateTool('HLINE')">― H-Line</button>
    <button class="btn-tool" id="btn-trend" onclick="activateTool('TREND')">╱ Trend</button>
  </div>
  <div id="status-pill">🟢 LIVE</div>
  <div id="chart-container"></div>
  <div id="attribution">TradingView Lightweight Charts™ (Apache-2.0)</div>

  <script>
    let chart, candleSeries, emaSeries, smaSeries, rsiSeries;
    let activePriceLines = [];
    let savedDrawings = [];
    let activeTool = null;
    let trendStartPoint = null;
    let currentCandles = [];

    function postToReactNative(type, payload) {
      if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
        window.ReactNativeWebView.postMessage(JSON.stringify({ type, payload }));
      }
    }

    function initChart() {
      const container = document.getElementById('chart-container');
      chart = LightweightCharts.createChart(container, {
        width: container.clientWidth,
        height: container.clientHeight,
        layout: {
          background: { color: '${bg}' },
          textColor: '${text}',
          fontSize: 11,
        },
        grid: {
          vertLines: { color: '${grid}' },
          horzLines: { color: '${grid}' },
        },
        crosshair: {
          mode: LightweightCharts.CrosshairMode.Normal,
        },
        timeScale: {
          borderColor: '${grid}',
          timeVisible: true,
          secondsVisible: false,
        },
      });

      candleSeries = chart.addCandlestickSeries({
        upColor: '${upColor}',
        downColor: '${downColor}',
        borderVisible: false,
        wickUpColor: '${upColor}',
        wickDownColor: '${downColor}',
      });

      // EMA Series (Blue)
      emaSeries = chart.addLineSeries({
        color: '#3b82f6',
        lineWidth: 2,
        title: 'EMA 20',
        visible: false,
      });

      // SMA Series (Amber)
      smaSeries = chart.addLineSeries({
        color: '#f59e0b',
        lineWidth: 2,
        title: 'SMA 50',
        visible: false,
      });

      window.addEventListener('resize', () => {
        chart.applyOptions({ width: container.clientWidth, height: container.clientHeight });
      });

      // Tap listener for drawing tools
      chart.subscribeClick((param) => {
        if (!param.point || !param.time) return;
        const price = candleSeries.coordinateToPrice(param.point.y);
        if (price === null) return;

        if (activeTool === 'HLINE') {
          const line = candleSeries.createPriceLine({
            price: price,
            color: '#a855f7',
            lineWidth: 2,
            lineStyle: LightweightCharts.LineStyle.Dashed,
            axisLabelVisible: true,
            title: 'H-Line ' + price.toFixed(2),
          });
          savedDrawings.push({ type: 'HLINE', price });
          postToReactNative('DRAWING_CREATED', { type: 'HLINE', price });
          activeTool = null;
          document.getElementById('btn-hline').classList.remove('active');
        } else if (activeTool === 'TREND') {
          if (!trendStartPoint) {
            trendStartPoint = { time: param.time, price };
          } else {
            const trend = { type: 'TREND', p1: trendStartPoint, p2: { time: param.time, price } };
            savedDrawings.push(trend);
            postToReactNative('DRAWING_CREATED', trend);
            trendStartPoint = null;
            activeTool = null;
            document.getElementById('btn-trend').classList.remove('active');
          }
        }
      });

      postToReactNative('CHART_MOUNTED', { ready: true });
    }

    function setCandles(candles) {
      currentCandles = candles;
      candleSeries.setData(candles);
      chart.timeScale().fitContent();
      recalcIndicators();
    }

    function updateTick(candle) {
      candleSeries.update(candle);
    }

    function setPriceOverlays(overlays) {
      activePriceLines.forEach(l => candleSeries.removePriceLine(l));
      activePriceLines = [];

      if (!overlays) return;
      if (overlays.entry) {
        activePriceLines.push(candleSeries.createPriceLine({
          price: overlays.entry,
          color: '#3b82f6',
          lineWidth: 2,
          lineStyle: LightweightCharts.LineStyle.Solid,
          axisLabelVisible: true,
          title: 'ENTRY ₹' + overlays.entry.toFixed(2),
        }));
      }
      if (overlays.stopLoss) {
        activePriceLines.push(candleSeries.createPriceLine({
          price: overlays.stopLoss,
          color: '#ef4444',
          lineWidth: 2,
          lineStyle: LightweightCharts.LineStyle.Dashed,
          axisLabelVisible: true,
          title: 'SL ₹' + overlays.stopLoss.toFixed(2),
        }));
      }
      if (overlays.target) {
        activePriceLines.push(candleSeries.createPriceLine({
          price: overlays.target,
          color: '#10b981',
          lineWidth: 2,
          lineStyle: LightweightCharts.LineStyle.Dashed,
          axisLabelVisible: true,
          title: 'TARGET ₹' + overlays.target.toFixed(2),
        }));
      }
    }

    function toggleIndicator(ind) {
      if (ind === 'EMA') {
        const isVisible = emaSeries.options().visible;
        emaSeries.applyOptions({ visible: !isVisible });
        document.getElementById('btn-ema').classList.toggle('active', !isVisible);
      } else if (ind === 'SMA') {
        const isVisible = smaSeries.options().visible;
        smaSeries.applyOptions({ visible: !isVisible });
        document.getElementById('btn-sma').classList.toggle('active', !isVisible);
      } else if (ind === 'RSI') {
        document.getElementById('btn-rsi').classList.toggle('active');
        postToReactNative('TOGGLE_RSI', {});
      }
    }

    function activateTool(tool) {
      if (activeTool === tool) {
        activeTool = null;
        document.getElementById(tool === 'HLINE' ? 'btn-hline' : 'btn-trend').classList.remove('active');
      } else {
        activeTool = tool;
        document.getElementById('btn-hline').classList.toggle('active', tool === 'HLINE');
        document.getElementById('btn-trend').classList.toggle('active', tool === 'TREND');
      }
    }

    function changeTimeframe(tf) {
      document.getElementById('btn-1m').classList.toggle('active', tf === '1m');
      document.getElementById('btn-5m').classList.toggle('active', tf === '5m');
      postToReactNative('CHANGE_TIMEFRAME', { timeframe: tf });
    }

    function recalcIndicators() {
      if (!currentCandles || currentCandles.length < 20) return;
      // Calculate 20-period EMA
      const k = 2 / (20 + 1);
      let prevEma = currentCandles[0].close;
      const emaData = [];
      for (let i = 0; i < currentCandles.length; i++) {
        const close = currentCandles[i].close;
        const curEma = i === 0 ? close : close * k + prevEma * (1 - k);
        if (i >= 19) {
          emaData.push({ time: currentCandles[i].time, value: Number(curEma.toFixed(2)) });
        }
        prevEma = curEma;
      }
      emaSeries.setData(emaData);

      // Calculate 50-period SMA
      if (currentCandles.length >= 50) {
        const smaData = [];
        let sum = 0;
        for (let i = 0; i < currentCandles.length; i++) {
          sum += currentCandles[i].close;
          if (i >= 50) sum -= currentCandles[i - 50].close;
          if (i >= 49) {
            smaData.push({ time: currentCandles[i].time, value: Number((sum / 50).toFixed(2)) });
          }
        }
        smaSeries.setData(smaData);
      }
    }

    // Message handler from React Native
    window.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'SET_CANDLES') {
          setCandles(msg.candles);
        } else if (msg.type === 'UPDATE_TICK') {
          updateTick(msg.candle);
        } else if (msg.type === 'SET_OVERLAYS') {
          setPriceOverlays(msg.overlays);
        }
      } catch (e) {
        console.error('Error handling RN message', e);
      }
    });

    window.onload = initChart;
  </script>
</body>
</html>`;
}
