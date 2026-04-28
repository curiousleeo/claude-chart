"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import {
  createChart,
  IChartApi,
  ISeriesApi,
  LineStyle,
  IPriceLine,
  CrosshairMode,
} from "lightweight-charts";
import { fetchCandles, subscribeLiveCandle, type Candle } from "../lib/coinbase";
import type { MCPCommand, Symbol, Timeframe, DrawingRecord } from "../lib/types";

// ── Indicator math ──────────────────────────────────────────────────────────

function ema(data: number[], period: number): (number | null)[] {
  const k = 2 / (period + 1);
  const out: (number | null)[] = new Array(period - 1).fill(null);
  let prev = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out.push(prev);
  for (let i = period; i < data.length; i++) {
    prev = data[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

function macd(closes: number[], fast = 12, slow = 26, sig = 9) {
  const ef = ema(closes, fast);
  const es = ema(closes, slow);
  const ml: (number | null)[] = ef.map((f, i) =>
    f != null && es[i] != null ? f - es[i]! : null
  );
  const validMacd = ml.filter((v): v is number => v != null);
  const nulls = ml.findIndex((v) => v != null);
  const se = ema(validMacd, sig);
  const sigLine: (number | null)[] = [
    ...new Array(nulls + sig - 1).fill(null),
    ...se.filter((v): v is number => v != null),
  ];
  const hist: (number | null)[] = ml.map((m, i) =>
    m != null && sigLine[i] != null ? m - sigLine[i]! : null
  );
  return { ml, sigLine, hist };
}

function rsi(closes: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(period).fill(null);
  let ag = 0, al = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) ag += d; else al -= d;
  }
  ag /= period; al /= period;
  out.push(al === 0 ? 100 : 100 - 100 / (1 + ag / al));
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + (d > 0 ? d : 0)) / period;
    al = (al * (period - 1) + (d < 0 ? -d : 0)) / period;
    out.push(al === 0 ? 100 : 100 - 100 / (1 + ag / al));
  }
  return out;
}

function sma(data: (number | null)[], period: number): (number | null)[] {
  return data.map((_, i) => {
    if (i < period - 1) return null;
    const sl = data.slice(i - period + 1, i + 1);
    if (sl.some((v) => v == null)) return null;
    return sl.reduce((a, b) => a! + b!, 0)! / period;
  });
}

// ── Chart theme ─────────────────────────────────────────────────────────────

const BG = "#131722";
const BORDER = "#2a2e39";

const THEME = {
  layout: { background: { color: BG }, textColor: "#d1d4dc" },
  grid: {
    vertLines: { color: "rgba(42,46,57,0.5)" },
    horzLines: { color: "rgba(42,46,57,0.5)" },
  },
  crosshair: {
    mode: CrosshairMode.Normal,
    vertLine: { color: "#758696", labelBackgroundColor: "#2a2e39" },
    horzLine: { color: "#758696", labelBackgroundColor: "#2a2e39" },
  },
  rightPriceScale: { borderColor: BORDER },
  timeScale: { borderColor: BORDER, timeVisible: true, secondsVisible: false },
};

// ── Types ────────────────────────────────────────────────────────────────────

interface Props {
  symbol: Symbol;
  timeframe: Timeframe;
  onSymbolChange: (s: Symbol) => void;
  onTimeframeChange: (t: Timeframe) => void;
  onPriceChange: (p: number) => void;
  onDrawingsChange: (d: DrawingRecord[]) => void;
  commandRef: React.MutableRefObject<((cmd: MCPCommand) => void) | null>;
}

const TIMEFRAMES: Timeframe[] = ["1m", "5m", "15m", "1h", "4h", "1d"];

// ── Component ────────────────────────────────────────────────────────────────

export default function TradingChart({
  symbol, timeframe, onSymbolChange, onTimeframeChange, onPriceChange, onDrawingsChange, commandRef,
}: Props) {
  // Pane containers
  const macdRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const rsiRef  = useRef<HTMLDivElement>(null);

  // Charts
  const macdChart = useRef<IChartApi | null>(null);
  const mainChart = useRef<IChartApi | null>(null);
  const rsiChart  = useRef<IChartApi | null>(null);

  // Series
  const candleSeries  = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const macdSeries    = useRef<ReturnType<IChartApi["addLineSeries"]> | null>(null);
  const signalSeries  = useRef<ReturnType<IChartApi["addLineSeries"]> | null>(null);
  const histSeries    = useRef<ReturnType<IChartApi["addHistogramSeries"]> | null>(null);
  const rsiSeries     = useRef<ReturnType<IChartApi["addLineSeries"]> | null>(null);
  const rsiMaSeries   = useRef<ReturnType<IChartApi["addLineSeries"]> | null>(null);
  const rsiBandUpper  = useRef<ReturnType<IChartApi["addAreaSeries"]> | null>(null);
  const rsiBandMask   = useRef<ReturnType<IChartApi["addAreaSeries"]> | null>(null);
  const rsiAnchorMin  = useRef<ReturnType<IChartApi["addLineSeries"]> | null>(null);
  const rsiAnchorMax  = useRef<ReturnType<IChartApi["addLineSeries"]> | null>(null);

  // Drawings
  const drawingsRef   = useRef<DrawingRecord[]>([]);
  const priceLinesRef = useRef<Map<string, IPriceLine>>(new Map());
  const trendLinesRef = useRef<Map<string, ISeriesApi<"Line">>>(new Map());

  // Indicator labels
  const [macdLabel, setMacdLabel]  = useState({ macd: 0, signal: 0, hist: 0 });
  const [rsiLabel,  setRsiLabel]   = useState({ rsi: 0, ma: 0 });
  const [ohlc,      setOhlc]       = useState({ o: 0, h: 0, l: 0, c: 0, chg: 0, pct: 0 });

  const updateDrawings = useCallback((d: DrawingRecord[]) => {
    drawingsRef.current = d;
    onDrawingsChange([...d]);
  }, [onDrawingsChange]);

  // ── Execute MCP drawing commands ──────────────────────────────────────────
  const executeCommand = useCallback((cmd: MCPCommand) => {
    const chart = mainChart.current;
    const series = candleSeries.current;
    if (!chart || !series) return;

    switch (cmd.type) {
      case "draw_level": {
        const pl = series.createPriceLine({
          price: cmd.price, color: cmd.color ?? "#f59e0b",
          lineWidth: 1, lineStyle: LineStyle.Dashed,
          axisLabelVisible: true, title: cmd.label ?? "",
        });
        priceLinesRef.current.set(cmd.id, pl);
        updateDrawings([...drawingsRef.current, { id: cmd.id, type: "level", params: { price: cmd.price, label: cmd.label, color: cmd.color } }]);
        break;
      }
      case "draw_trendline": {
        const ls = chart.addLineSeries({ color: cmd.color ?? "#2962ff", lineWidth: 1, lastValueVisible: false, priceLineVisible: false });
        ls.setData([{ time: cmd.time1 as never, value: cmd.price1 }, { time: cmd.time2 as never, value: cmd.price2 }]);
        trendLinesRef.current.set(cmd.id, ls);
        updateDrawings([...drawingsRef.current, { id: cmd.id, type: "trendline", params: { time1: cmd.time1, price1: cmd.price1, time2: cmd.time2, price2: cmd.price2 } }]);
        break;
      }
      case "draw_zone": {
        const ph = series.createPriceLine({ price: cmd.priceHigh, color: cmd.color ?? "#8b5cf6", lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: true, title: cmd.label ? `${cmd.label} H` : "" });
        const pl = series.createPriceLine({ price: cmd.priceLow, color: cmd.color ?? "#8b5cf6", lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: true, title: cmd.label ? `${cmd.label} L` : "" });
        priceLinesRef.current.set(`${cmd.id}_h`, ph);
        priceLinesRef.current.set(`${cmd.id}_l`, pl);
        updateDrawings([...drawingsRef.current, { id: cmd.id, type: "zone", params: { priceHigh: cmd.priceHigh, priceLow: cmd.priceLow, label: cmd.label } }]);
        break;
      }
      case "remove_drawing": {
        ["", "_h", "_l"].forEach((sfx) => {
          const pl = priceLinesRef.current.get(cmd.id + sfx);
          if (pl) { series.removePriceLine(pl); priceLinesRef.current.delete(cmd.id + sfx); }
        });
        const tl = trendLinesRef.current.get(cmd.id);
        if (tl) { chart.removeSeries(tl); trendLinesRef.current.delete(cmd.id); }
        updateDrawings(drawingsRef.current.filter((d) => d.id !== cmd.id));
        break;
      }
      case "clear_drawings": {
        priceLinesRef.current.forEach((pl) => series.removePriceLine(pl));
        priceLinesRef.current.clear();
        trendLinesRef.current.forEach((tl) => chart.removeSeries(tl));
        trendLinesRef.current.clear();
        updateDrawings([]);
        break;
      }
    }
  }, [updateDrawings]);

  useEffect(() => { commandRef.current = executeCommand; }, [executeCommand, commandRef]);

  // ── Init charts ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!macdRef.current || !mainRef.current || !rsiRef.current) return;

    // MACD chart
    const mc = createChart(macdRef.current, {
      ...THEME, width: macdRef.current.clientWidth, height: macdRef.current.clientHeight,
      timeScale: { ...THEME.timeScale, visible: false },
      rightPriceScale: { ...THEME.rightPriceScale, scaleMargins: { top: 0.1, bottom: 0.1 } },
    });
    const hist   = mc.addHistogramSeries({ lastValueVisible: true, priceLineVisible: false, priceScaleId: "hist" });
    const macdL  = mc.addLineSeries({ color: "#f77c00", lineWidth: 1, lastValueVisible: true, priceLineVisible: false });
    const sigL   = mc.addLineSeries({ color: "#2962ff", lineWidth: 1, lastValueVisible: true, priceLineVisible: false });
    macdL.createPriceLine({ price: 0, color: "rgba(120,123,134,0.4)", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: "" });
    macdChart.current   = mc;
    histSeries.current  = hist;
    macdSeries.current  = macdL;
    signalSeries.current = sigL;

    // Main candle chart
    const cc = createChart(mainRef.current, {
      ...THEME, width: mainRef.current.clientWidth, height: mainRef.current.clientHeight,
      timeScale: { ...THEME.timeScale, visible: false },
      rightPriceScale: { ...THEME.rightPriceScale, scaleMargins: { top: 0.05, bottom: 0.05 } },
    });
    const cs = cc.addCandlestickSeries({
      upColor: "#26a69a", downColor: "#ef5350",
      borderUpColor: "#26a69a", borderDownColor: "#ef5350",
      wickUpColor: "#26a69a", wickDownColor: "#ef5350",
    });
    mainChart.current  = cc;
    candleSeries.current = cs;

    // RSI chart
    const rc = createChart(rsiRef.current, {
      ...THEME, width: rsiRef.current.clientWidth, height: rsiRef.current.clientHeight,
      rightPriceScale: { ...THEME.rightPriceScale, scaleMargins: { top: 0.08, bottom: 0.08 } },
    });
    // Invisible anchors at 0 and 100 — lock the RSI scale so it never auto-fits and shifts the band
    const anchorMin = rc.addLineSeries({ color: "transparent", lineWidth: 1, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false });
    const anchorMax = rc.addLineSeries({ color: "transparent", lineWidth: 1, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false });
    rsiAnchorMin.current = anchorMin;
    rsiAnchorMax.current = anchorMax;

    // Band fill: upper area (0→70, light purple) + mask (0→30, dark bg) = shaded 30–70 zone
    const bandUpper = rc.addAreaSeries({
      lineColor: "rgba(149,117,205,0.5)", lineWidth: 1,
      topColor: "rgba(149,117,205,0.18)", bottomColor: "rgba(149,117,205,0.18)",
      lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false,
    });
    const bandMask = rc.addAreaSeries({
      lineColor: "rgba(149,117,205,0.5)", lineWidth: 1,
      topColor: BG, bottomColor: BG,
      lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false,
    });
    // RSI lines on top of band
    const rsiL  = rc.addLineSeries({ color: "#7b1fa2", lineWidth: 1, lastValueVisible: true, priceLineVisible: false });
    const rsiMa = rc.addLineSeries({ color: "#f59e0b", lineWidth: 1, lastValueVisible: true, priceLineVisible: false });
    rsiChart.current    = rc;
    rsiBandUpper.current = bandUpper;
    rsiBandMask.current  = bandMask;
    rsiSeries.current   = rsiL;
    rsiMaSeries.current = rsiMa;

    // ── Time scale sync ──
    let syncing = false;
    const sync = (src: IChartApi, targets: IChartApi[]) => {
      src.timeScale().subscribeVisibleLogicalRangeChange((range) => {
        if (syncing || !range) return;
        syncing = true;
        targets.forEach((t) => t.timeScale().setVisibleLogicalRange(range));
        syncing = false;
      });
    };
    sync(mc, [cc, rc]);
    sync(cc, [mc, rc]);
    sync(rc, [mc, cc]);

    // ── Resize observer ──
    const ro = new ResizeObserver(() => {
      if (macdRef.current) mc.resize(macdRef.current.clientWidth, macdRef.current.clientHeight);
      if (mainRef.current) cc.resize(mainRef.current.clientWidth, mainRef.current.clientHeight);
      if (rsiRef.current)  rc.resize(rsiRef.current.clientWidth, rsiRef.current.clientHeight);
    });
    if (macdRef.current) ro.observe(macdRef.current);
    if (mainRef.current) ro.observe(mainRef.current);
    if (rsiRef.current)  ro.observe(rsiRef.current);

    return () => {
      ro.disconnect();
      mc.remove(); cc.remove(); rc.remove();
      macdChart.current = mainChart.current = rsiChart.current = null;
      candleSeries.current = macdSeries.current = signalSeries.current = null;
      histSeries.current = rsiSeries.current = rsiMaSeries.current = null;
      rsiBandUpper.current = rsiBandMask.current = null;
      rsiAnchorMin.current = rsiAnchorMax.current = null;
    };
  }, []);

  // ── Load data + indicators ────────────────────────────────────────────────
  useEffect(() => {
    const cs  = candleSeries.current;
    const hs  = histSeries.current;
    const ml  = macdSeries.current;
    const sl  = signalSeries.current;
    const rl  = rsiSeries.current;
    const rm  = rsiMaSeries.current;
    const bu  = rsiBandUpper.current;
    const bm  = rsiBandMask.current;
    const amin = rsiAnchorMin.current;
    const amax = rsiAnchorMax.current;
    if (!cs || !hs || !ml || !sl || !rl || !rm || !bu || !bm || !amin || !amax) return;

    let unsub: (() => void) | null = null;

    fetchCandles(symbol, timeframe).then((candles: Candle[]) => {
      cs.setData(candles as never);

      const closes = candles.map((c) => c.close);

      // MACD
      const { ml: macdVals, sigLine, hist } = macd(closes);
      ml.setData(candles.map((c, i) => macdVals[i] != null ? { time: c.time as never, value: macdVals[i]! } : null).filter(Boolean) as never);
      sl.setData(candles.map((c, i) => sigLine[i] != null ? { time: c.time as never, value: sigLine[i]! } : null).filter(Boolean) as never);
      hs.setData(candles.map((c, i) => hist[i] != null ? {
        time: c.time as never, value: hist[i]!,
        color: hist[i]! >= 0 ? (hist[i]! > (hist[i - 1] ?? hist[i]!) ? "#26a69a" : "rgba(38,166,154,0.5)")
                              : (hist[i]! < (hist[i - 1] ?? hist[i]!) ? "#ef5350" : "rgba(239,83,80,0.5)"),
      } : null).filter(Boolean) as never);

      // RSI
      const rsiVals = rsi(closes);
      const rsiMaVals = sma(rsiVals, 14);
      // Anchor scale to 0–100 so band never shifts on pan/zoom
      amin.setData(candles.map((c) => ({ time: c.time as never, value: 0 })));
      amax.setData(candles.map((c) => ({ time: c.time as never, value: 100 })));
      // Band data: flat lines at 70 and 30 for the shaded zone
      bu.setData(candles.map((c) => ({ time: c.time as never, value: 70 })));
      bm.setData(candles.map((c) => ({ time: c.time as never, value: 30 })));
      rl.setData(candles.map((c, i) => rsiVals[i] != null ? { time: c.time as never, value: rsiVals[i]! } : null).filter(Boolean) as never);
      rm.setData(candles.map((c, i) => rsiMaVals[i] != null ? { time: c.time as never, value: rsiMaVals[i]! } : null).filter(Boolean) as never);

      // Labels
      const last = candles[candles.length - 1];
      const prev = candles[candles.length - 2];
      const lastI = candles.length - 1;
      const chg = last.close - prev?.close;
      setOhlc({ o: last.open, h: last.high, l: last.low, c: last.close, chg, pct: (chg / (prev?.close || last.close)) * 100 });
      setMacdLabel({ macd: macdVals[lastI] ?? 0, signal: sigLine[lastI] ?? 0, hist: hist[lastI] ?? 0 });
      setRsiLabel({ rsi: rsiVals[lastI] ?? 0, ma: rsiMaVals[lastI] ?? 0 });
      onPriceChange(last.close);

      // Set zoom after ALL series have data — show last 150 bars with right padding
      const total = candles.length;
      const range = { from: Math.max(0, total - 150), to: total - 1 + 8 };
      mainChart.current?.timeScale().setVisibleLogicalRange(range);

      unsub = subscribeLiveCandle(symbol, timeframe, (candle: Candle) => {
        cs.update(candle as never);
        onPriceChange(candle.close);
      });
    });

    return () => unsub?.();
  }, [symbol, timeframe, onPriceChange]);

  const fmt = (n: number, d = 2) => n.toFixed(d);
  const fmtPrice = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  return (
    <div className="flex flex-col h-full" style={{ background: BG, color: "#d1d4dc", fontFamily: "ui-sans-serif,system-ui,sans-serif", fontSize: 12 }}>

      {/* ── Toolbar ── */}
      <div className="flex items-center gap-2 px-3 py-1" style={{ borderBottom: `1px solid ${BORDER}` }}>
        <div className="flex gap-0.5">
          {(["BTC-USD", "SOL-USD"] as Symbol[]).map((s) => (
            <button key={s} onClick={() => onSymbolChange(s)}
              className="px-2 py-0.5 text-xs rounded font-medium transition-colors"
              style={{ background: symbol === s ? "rgba(41,98,255,0.15)" : "transparent", color: symbol === s ? "#2962ff" : "#787b86" }}>
              {s === "BTC-USD" ? "BTC/USD" : "SOL/USD"}
            </button>
          ))}
        </div>
        <div style={{ width: 1, height: 12, background: BORDER }} />
        <div className="flex gap-0.5">
          {TIMEFRAMES.map((tf) => (
            <button key={tf} onClick={() => onTimeframeChange(tf)}
              className="px-2 py-0.5 text-xs rounded transition-colors"
              style={{ background: timeframe === tf ? "rgba(41,98,255,0.15)" : "transparent", color: timeframe === tf ? "#2962ff" : "#787b86" }}>
              {tf}
            </button>
          ))}
        </div>
      </div>

      {/* ── MACD pane ── */}
      <div className="relative" style={{ height: "20%" }}>
        <div className="absolute top-1 left-2 z-10 flex items-center gap-1 text-[11px]" style={{ color: "#787b86" }}>
          <span style={{ color: "#d1d4dc" }}>MACD</span>
          <span>close 12 26 9</span>
          <span style={{ color: "#f77c00" }}>{fmt(macdLabel.macd)}</span>
          <span style={{ color: "#2962ff" }}>{fmt(macdLabel.signal)}</span>
          <span style={{ color: macdLabel.hist >= 0 ? "#26a69a" : "#ef5350" }}>{fmt(macdLabel.hist)}</span>
        </div>
        <div ref={macdRef} style={{ width: "100%", height: "100%" }} />
      </div>

      {/* ── Main candle pane ── */}
      <div className="relative" style={{ height: "55%", borderTop: `1px solid ${BORDER}` }}>
        <div className="absolute top-1 left-2 z-10 flex flex-wrap items-center gap-x-1.5 gap-y-0 text-[11px]" style={{ color: "#787b86" }}>
          {/* live dot */}
          <div className="w-1.5 h-1.5 rounded-full" style={{ background: "#26a69a", boxShadow: "0 0 4px #26a69a" }} />
          <span style={{ color: "#d1d4dc", fontWeight: 600 }}>
            {symbol === "BTC-USD" ? "Bitcoin / U.S. Dollar" : "Solana / U.S. Dollar"}
          </span>
          <span>·</span>
          <span>{timeframe}</span>
          <span>·</span>
          <span>Coinbase</span>
          <span className="ml-1">
            O <span style={{ color: "#d1d4dc" }}>{fmtPrice(ohlc.o)}</span>
          </span>
          <span>H <span style={{ color: "#26a69a" }}>{fmtPrice(ohlc.h)}</span></span>
          <span>L <span style={{ color: "#ef5350" }}>{fmtPrice(ohlc.l)}</span></span>
          <span>C <span style={{ color: "#d1d4dc" }}>{fmtPrice(ohlc.c)}</span></span>
          <span style={{ color: ohlc.chg >= 0 ? "#26a69a" : "#ef5350" }}>
            {ohlc.chg >= 0 ? "+" : ""}{fmtPrice(ohlc.chg)} ({ohlc.pct >= 0 ? "+" : ""}{fmt(ohlc.pct)}%)
          </span>
        </div>
        <div ref={mainRef} style={{ width: "100%", height: "100%" }} />
      </div>

      {/* ── RSI pane ── */}
      <div className="relative" style={{ height: "25%", borderTop: `1px solid ${BORDER}` }}>
        <div className="absolute top-1 left-2 z-10 flex items-center gap-1 text-[11px]" style={{ color: "#787b86" }}>
          <span style={{ color: "#d1d4dc" }}>RSI</span>
          <span>14 close</span>
          <span style={{ color: "#9575cd" }}>{fmt(rsiLabel.rsi)}</span>
          <span style={{ color: "#f59e0b" }}>{fmt(rsiLabel.ma)}</span>
        </div>
        <div ref={rsiRef} style={{ width: "100%", height: "100%" }} />
      </div>

    </div>
  );
}
