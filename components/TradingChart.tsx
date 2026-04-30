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
import type { MCPCommand, Symbol, Timeframe, DrawingRecord, Divergence } from "../lib/types";

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

// ── Divergence detection ─────────────────────────────────────────────────────

const DIV_COLORS: Record<Divergence["type"], string> = {
  regular_bullish: "#26a69a",
  regular_bearish: "#ef5350",
  hidden_bullish:  "#4db6ac",
  hidden_bearish:  "#ef9a9a",
};

const DIV_LABELS: Record<Divergence["type"], string> = {
  regular_bullish: "Bull Div",
  regular_bearish: "Bear Div",
  hidden_bullish:  "H.Bull",
  hidden_bearish:  "H.Bear",
};

function detectDivergences(candles: Candle[], rsiVals: (number | null)[]): Divergence[] {
  const LEFT   = 5;  // bars left of pivot needed for confirmation
  const RIGHT  = 2;  // bars right of pivot needed — asymmetric, keeps pivots recent
  const WINDOW = 150;
  const ROLL   = 10; // look-back window for the developing current extreme

  const start = Math.max(0, candles.length - WINDOW - LEFT);
  const c = candles.slice(start);
  const r = rsiVals.slice(start);
  const n = c.length;

  const phIdx: number[] = [];
  const plIdx: number[] = [];

  for (let i = LEFT; i < n - RIGHT; i++) {
    let isHi = true, isLo = true;
    for (let j = i - LEFT; j < i; j++) {
      if (c[j].high >= c[i].high) isHi = false;
      if (c[j].low  <= c[i].low)  isLo = false;
    }
    for (let j = i + 1; j <= i + RIGHT; j++) {
      if (c[j].high >= c[i].high) isHi = false;
      if (c[j].low  <= c[i].low)  isLo = false;
    }
    if (isHi) phIdx.push(i);
    if (isLo) plIdx.push(i);
  }

  const divs: Divergence[] = [];

  // ── Confirmed historical pivot pairs ─────────────────────────────────────
  for (let k = 1; k < phIdx.length; k++) {
    const i1 = phIdx[k - 1], i2 = phIdx[k];
    const r1 = r[i1], r2 = r[i2];
    if (r1 == null || r2 == null) continue;
    const priceHH = c[i2].high > c[i1].high, rsiHH = r2 > r1;
    if (priceHH && !rsiHH)
      divs.push({ type: "regular_bearish", p1: { time: c[i1].time, price: c[i1].high, rsi: r1 }, p2: { time: c[i2].time, price: c[i2].high, rsi: r2 } });
    else if (!priceHH && rsiHH)
      divs.push({ type: "hidden_bearish",  p1: { time: c[i1].time, price: c[i1].high, rsi: r1 }, p2: { time: c[i2].time, price: c[i2].high, rsi: r2 } });
  }
  for (let k = 1; k < plIdx.length; k++) {
    const i1 = plIdx[k - 1], i2 = plIdx[k];
    const r1 = r[i1], r2 = r[i2];
    if (r1 == null || r2 == null) continue;
    const priceLL = c[i2].low < c[i1].low, rsiLL = r2 < r1;
    if (priceLL && !rsiLL)
      divs.push({ type: "regular_bullish", p1: { time: c[i1].time, price: c[i1].low,  rsi: r1 }, p2: { time: c[i2].time, price: c[i2].low,  rsi: r2 } });
    else if (!priceLL && rsiLL)
      divs.push({ type: "hidden_bullish",  p1: { time: c[i1].time, price: c[i1].low,  rsi: r1 }, p2: { time: c[i2].time, price: c[i2].low,  rsi: r2 } });
  }

  // ── Developing: last confirmed pivot vs rolling current extreme ───────────
  // Always extends to the current candle — shows what's forming right now.
  const rollStart = Math.max(0, n - ROLL);
  let curHi = rollStart, curLo = rollStart;
  for (let i = rollStart + 1; i < n; i++) {
    if (c[i].high > c[curHi].high) curHi = i;
    if (c[i].low  < c[curLo].low)  curLo = i;
  }

  if (phIdx.length > 0) {
    const lp = phIdx[phIdx.length - 1];
    if (curHi > lp + RIGHT) {
      const r1 = r[lp], r2 = r[curHi];
      if (r1 != null && r2 != null) {
        const priceHH = c[curHi].high > c[lp].high, rsiHH = r2 > r1;
        if (priceHH && !rsiHH)
          divs.push({ type: "regular_bearish", developing: true, p1: { time: c[lp].time, price: c[lp].high, rsi: r1 }, p2: { time: c[curHi].time, price: c[curHi].high, rsi: r2 } });
        else if (!priceHH && rsiHH)
          divs.push({ type: "hidden_bearish",  developing: true, p1: { time: c[lp].time, price: c[lp].high, rsi: r1 }, p2: { time: c[curHi].time, price: c[curHi].high, rsi: r2 } });
      }
    }
  }
  if (plIdx.length > 0) {
    const lp = plIdx[plIdx.length - 1];
    if (curLo > lp + RIGHT) {
      const r1 = r[lp], r2 = r[curLo];
      if (r1 != null && r2 != null) {
        const priceLL = c[curLo].low < c[lp].low, rsiLL = r2 < r1;
        if (priceLL && !rsiLL)
          divs.push({ type: "regular_bullish", developing: true, p1: { time: c[lp].time, price: c[lp].low,  rsi: r1 }, p2: { time: c[curLo].time, price: c[curLo].low,  rsi: r2 } });
        else if (!priceLL && rsiLL)
          divs.push({ type: "hidden_bullish",  developing: true, p1: { time: c[lp].time, price: c[lp].low,  rsi: r1 }, p2: { time: c[curLo].time, price: c[curLo].low,  rsi: r2 } });
      }
    }
  }

  divs.sort((a, b) => b.p2.time - a.p2.time);
  return divs.slice(0, 4);
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
  onDivergencesChange: (d: Divergence[]) => void;
  commandRef: React.MutableRefObject<((cmd: MCPCommand) => void) | null>;
}

const TF_GROUPS: { label: string; items: Timeframe[] }[] = [
  { label: "MINUTES", items: ["1m", "5m", "15m"] },
  { label: "HOURS",   items: ["1h", "6h"] },
  { label: "DAYS",    items: ["1d"] },
];

// ── Component ────────────────────────────────────────────────────────────────

export default function TradingChart({
  symbol, timeframe, onSymbolChange, onTimeframeChange, onPriceChange, onDrawingsChange, onDivergencesChange, commandRef,
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

  // Divergence overlay lines (cleared and redrawn on every data load)
  const divLinesRsi  = useRef<ISeriesApi<"Line">[]>([]);
  const divLinesMain = useRef<ISeriesApi<"Line">[]>([]);

  // Indicator labels
  const [macdLabel, setMacdLabel]  = useState({ macd: 0, signal: 0, hist: 0 });
  const [rsiLabel,  setRsiLabel]   = useState({ rsi: 0, ma: 0 });
  const [divTypes,  setDivTypes]   = useState<Divergence["type"][]>([]);
  const [ohlc,      setOhlc]       = useState({ o: 0, h: 0, l: 0, c: 0, chg: 0, pct: 0 });
  const [tfOpen,    setTfOpen]     = useState(false);
  const tfRef = useRef<HTMLDivElement>(null);

  // Pane resize / collapse
  const [macdChartH, setMacdChartH] = useState(110);
  const [rsiChartH,  setRsiChartH]  = useState(150);
  const [macdCollapsed, setMacdCollapsed] = useState(false);
  const [rsiCollapsed,  setRsiCollapsed]  = useState(false);
  const savedMacdH = useRef(110);
  const savedRsiH  = useRef(150);
  const dragRef    = useRef<{ which: "macd" | "rsi"; startY: number; startH: number } | null>(null);
  const panRef     = useRef<{ x: number; y: number } | null>(null);
  const priceMargins = useRef({ main: { top: 0.05, bottom: 0.05 }, macd: { top: 0.1, bottom: 0.1 }, rsi: { top: 0.08, bottom: 0.08 } });

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

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (tfRef.current && !tfRef.current.contains(e.target as Node)) setTfOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  // Drag-to-resize pane boundaries
  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!dragRef.current) return;
      const delta = e.clientY - dragRef.current.startY;
      if (dragRef.current.which === "macd") {
        setMacdChartH(Math.max(40, Math.min(600, dragRef.current.startH + delta)));
      } else {
        setRsiChartH(Math.max(40, Math.min(600, dragRef.current.startH - delta)));
      }
    }
    function onUp() { dragRef.current = null; }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, []);

  // Scroll-wheel zoom on the right price scale
  useEffect(() => {
    const SCALE_W = 65; // approximate px width of the right price axis

    type Entry = { ref: React.RefObject<HTMLDivElement | null>; chart: React.MutableRefObject<IChartApi | null>; m: { top: number; bottom: number } };
    const entries: Entry[] = [
      { ref: macdRef, chart: macdChart, m: priceMargins.current.macd },
      { ref: mainRef, chart: mainChart, m: priceMargins.current.main },
      { ref: rsiRef,  chart: rsiChart,  m: priceMargins.current.rsi  },
    ];

    const cleanups: Array<() => void> = [];

    for (const { ref, chart, m } of entries) {
      const el = ref.current;
      if (!el) continue;

      const fn = (e: WheelEvent) => {
        const rect = el.getBoundingClientRect();
        if (e.clientX < rect.right - SCALE_W) return; // not over price scale
        e.preventDefault();
        e.stopPropagation();
        const c = chart.current;
        if (!c) return;
        // Multiplicative zoom — each tick is a % change, no artificial hard stop
        const factor = e.deltaY > 0 ? 1.12 : 0.89;
        m.top    = Math.max(0.001, Math.min(0.499, m.top    * factor));
        m.bottom = Math.max(0.001, Math.min(0.499, m.bottom * factor));
        c.priceScale("right").applyOptions({ scaleMargins: { top: m.top, bottom: m.bottom } });
      };

      el.addEventListener("wheel", fn, { capture: true, passive: false });
      cleanups.push(() => el.removeEventListener("wheel", fn, { capture: true }));
    }

    return () => cleanups.forEach((c) => c());
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Right-click + drag: free 2D pan (horizontal = time scroll, vertical = price shift)
  useEffect(() => {
    const inCharts = (t: EventTarget | null) =>
      [mainRef, macdRef, rsiRef].some((r) => r.current?.contains(t as Node));

    const onDown = (e: MouseEvent) => {
      if (e.button !== 2 || !inCharts(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      panRef.current = { x: e.clientX, y: e.clientY };
      document.body.style.cursor = "grabbing";
    };

    const onMove = (e: MouseEvent) => {
      if (!panRef.current) return;
      const dx = e.clientX - panRef.current.x;
      const dy = e.clientY - panRef.current.y;
      panRef.current = { x: e.clientX, y: e.clientY };

      // Horizontal: shift the time axis (syncs to all panes via the existing subscribeVisibleLogicalRangeChange)
      const chart = mainChart.current;
      if (chart && dx !== 0) {
        const pos = chart.timeScale().scrollPosition();
        chart.timeScale().scrollToPosition(pos - dx * 0.15, false);
      }

      // Vertical: shift price view via asymmetric scaleMargins on main pane
      if (chart && dy !== 0 && mainRef.current) {
        const m = priceMargins.current.main;
        const step = (dy / mainRef.current.clientHeight) * 0.6;
        m.top    = Math.max(0.001, Math.min(0.499, m.top    + step));
        m.bottom = Math.max(0.001, Math.min(0.499, m.bottom - step));
        chart.priceScale("right").applyOptions({ scaleMargins: { top: m.top, bottom: m.bottom } });
      }
    };

    const onUp = (e: MouseEvent) => {
      if (e.button !== 2) return;
      panRef.current = null;
      document.body.style.cursor = "";
    };

    const noCtx = (e: MouseEvent) => { if (inCharts(e.target)) e.preventDefault(); };

    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("contextmenu", noCtx);

    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("contextmenu", noCtx);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Init charts ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!macdRef.current || !mainRef.current || !rsiRef.current) return;

    // MACD chart
    const mc = createChart(macdRef.current, {
      ...THEME, width: macdRef.current.clientWidth, height: macdRef.current.clientHeight,
      timeScale: { ...THEME.timeScale, visible: false },
      rightPriceScale: { ...THEME.rightPriceScale, scaleMargins: { top: 0.1, bottom: 0.1 } },
      handleScale: { axisPressedMouseMove: { time: true, price: true } },
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
      handleScale: { axisPressedMouseMove: { time: true, price: true } },
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
      handleScale: { axisPressedMouseMove: { time: true, price: true } },
    });
    // Invisible anchors at 0 and 100 — lock the RSI scale so it never auto-fits and shifts the band
    const anchorMin = rc.addLineSeries({ color: "transparent", lineWidth: 1, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false });
    const anchorMax = rc.addLineSeries({ color: "transparent", lineWidth: 1, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false });
    rsiAnchorMin.current = anchorMin;
    rsiAnchorMax.current = anchorMax;

    // Band fill: upper area (0→70, light purple) + mask (0→30, dark bg) = shaded 30–70 zone
    const bandUpper = rc.addAreaSeries({
      lineColor: "transparent", lineWidth: 1,
      topColor: "rgba(149,117,205,0.15)", bottomColor: "rgba(149,117,205,0.15)",
      lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false,
    });
    const bandMask = rc.addAreaSeries({
      lineColor: "transparent", lineWidth: 1,
      topColor: BG, bottomColor: BG,
      lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false,
    });
    // RSI lines on top of band
    const rsiL  = rc.addLineSeries({ color: "#7b1fa2", lineWidth: 1, lastValueVisible: true, priceLineVisible: false });
    const rsiMa = rc.addLineSeries({ color: "#f59e0b", lineWidth: 1, lastValueVisible: true, priceLineVisible: false });
    // Dashed reference lines at 70, 50, 30 — like TradingView
    rsiL.createPriceLine({ price: 70, color: "rgba(149,117,205,0.5)", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: "" });
    rsiL.createPriceLine({ price: 50, color: "rgba(120,123,134,0.35)", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: "" });
    rsiL.createPriceLine({ price: 30, color: "rgba(149,117,205,0.5)", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: "" });
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

    // ── Resize observer ── (guard against height=0 when pane is display:none)
    const ro = new ResizeObserver(() => {
      if (macdRef.current && macdRef.current.clientHeight > 0) mc.resize(macdRef.current.clientWidth, macdRef.current.clientHeight);
      if (mainRef.current && mainRef.current.clientHeight > 0) cc.resize(mainRef.current.clientWidth, mainRef.current.clientHeight);
      if (rsiRef.current  && rsiRef.current.clientHeight  > 0) rc.resize(rsiRef.current.clientWidth,  rsiRef.current.clientHeight);
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
      divLinesRsi.current = [];
      divLinesMain.current = [];
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

    // Clear previous divergence overlays before fetching new data
    divLinesRsi.current.forEach((l) => rsiChart.current?.removeSeries(l));
    divLinesRsi.current = [];
    divLinesMain.current.forEach((l) => mainChart.current?.removeSeries(l));
    divLinesMain.current = [];
    candleSeries.current?.setMarkers([]);

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
      // Extend band 200 bars into the future at the same interval so it always fills the right side
      const interval = candles[candles.length - 1].time - candles[candles.length - 2].time;
      const lastTime = candles[candles.length - 1].time;
      const futureTimes = Array.from({ length: 200 }, (_, i) => lastTime + (i + 1) * interval);
      const bandTimes = [...candles.map((c) => c.time), ...futureTimes];
      amin.setData(bandTimes.map((t) => ({ time: t as never, value: 0 })));
      amax.setData(bandTimes.map((t) => ({ time: t as never, value: 100 })));
      bu.setData(bandTimes.map((t) => ({ time: t as never, value: 70 })));
      bm.setData(bandTimes.map((t) => ({ time: t as never, value: 30 })));
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

      // Divergence detection and overlay
      const divs = detectDivergences(candles, rsiVals);
      onDivergencesChange(divs);
      setDivTypes(divs.map((d) => d.type));
      const rc2 = rsiChart.current;
      const mc2 = mainChart.current;
      if (mc2 && rc2 && cs) {
        // Arrow markers on the candles at each divergence pivot pair
        const markers = divs.flatMap((d) => {
          const isBull = d.type.includes("bullish");
          const color  = DIV_COLORS[d.type];
          const label  = DIV_LABELS[d.type];
          return [
            { time: d.p1.time as never, position: (isBull ? "belowBar" : "aboveBar") as never, color, shape: (isBull ? "arrowUp" : "arrowDown") as never, text: "" },
            { time: d.p2.time as never, position: (isBull ? "belowBar" : "aboveBar") as never, color, shape: (isBull ? "arrowUp" : "arrowDown") as never, text: label },
          ];
        }).sort((a, b) => (a.time as number) - (b.time as number));
        cs.setMarkers(markers);

        for (const d of divs) {
          const color    = DIV_COLORS[d.type];
          const style    = d.developing ? LineStyle.Dashed : LineStyle.Solid;
          const baseOpts = { color, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false, lineStyle: style };

          // Price pane — diagonal line connecting the two pivot prices
          const priceLine = mc2.addLineSeries({ ...baseOpts, lineWidth: 2 });
          priceLine.setData([{ time: d.p1.time as never, value: d.p1.price }, { time: d.p2.time as never, value: d.p2.price }]);
          divLinesMain.current.push(priceLine);

          // RSI pane — thicker line so it's visible in the small pane
          const rsiLine = rc2.addLineSeries({ ...baseOpts, lineWidth: 3 });
          rsiLine.setData([{ time: d.p1.time as never, value: d.p1.rsi }, { time: d.p2.time as never, value: d.p2.rsi }]);
          divLinesRsi.current.push(rsiLine);
        }
      }

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
  }, [symbol, timeframe, onPriceChange, onDivergencesChange]);

  function toggleMacd() {
    if (macdCollapsed) {
      const h = savedMacdH.current;
      setMacdCollapsed(false);
      setMacdChartH(h);
      // Chart was hidden via display:none — now resize it to match the restored div height
      requestAnimationFrame(() => {
        if (macdChart.current && macdRef.current)
          macdChart.current.resize(macdRef.current.clientWidth, h);
      });
    } else {
      savedMacdH.current = macdChartH;
      setMacdCollapsed(true);
      // Don't resize chart to 0 — lightweight-charts doesn't handle height=0
      // The div gets display:none so the chart is hidden without touching its internals
    }
  }
  function toggleRsi() {
    if (rsiCollapsed) {
      const h = savedRsiH.current;
      setRsiCollapsed(false);
      setRsiChartH(h);
      requestAnimationFrame(() => {
        if (rsiChart.current && rsiRef.current)
          rsiChart.current.resize(rsiRef.current.clientWidth, h);
      });
    } else {
      savedRsiH.current = rsiChartH;
      setRsiCollapsed(true);
    }
  }

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

        {/* Timeframe dropdown */}
        <div ref={tfRef} className="relative">
          <button
            onClick={() => setTfOpen((v) => !v)}
            className="flex items-center gap-1 px-2 py-0.5 text-xs rounded"
            style={{ background: tfOpen ? "rgba(41,98,255,0.15)" : "transparent", color: "#2962ff" }}>
            {timeframe}
            <svg width="8" height="5" viewBox="0 0 8 5" fill="none" style={{ opacity: 0.7 }}>
              <path d="M1 1l3 3 3-3" stroke="#2962ff" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </button>

          {tfOpen && (
            <div className="absolute top-full left-0 mt-1 z-50 rounded py-1 min-w-[140px]"
              style={{ background: "#1e2230", border: `1px solid ${BORDER}`, boxShadow: "0 4px 16px rgba(0,0,0,0.4)" }}>
              {TF_GROUPS.map((group) => (
                <div key={group.label}>
                  <div className="px-3 pt-2 pb-1 text-[10px] font-semibold tracking-widest" style={{ color: "#4a4f5e" }}>
                    {group.label}
                  </div>
                  {group.items.map((tf) => (
                    <button key={tf}
                      onClick={() => { onTimeframeChange(tf); setTfOpen(false); }}
                      className="w-full text-left px-3 py-1.5 text-xs transition-colors"
                      style={{
                        background: timeframe === tf ? "rgba(41,98,255,0.15)" : "transparent",
                        color: timeframe === tf ? "#2962ff" : "#d1d4dc",
                      }}>
                      {tf === "1m" ? "1 minute" : tf === "5m" ? "5 minutes" : tf === "15m" ? "15 minutes"
                        : tf === "1h" ? "1 hour" : tf === "6h" ? "6 hours" : "1 day"}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── MACD pane ── */}
      <div style={{ flexShrink: 0 }}>
        <div style={{ height: 26, display: "flex", alignItems: "center", gap: 6, padding: "0 8px", borderTop: `1px solid ${BORDER}` }}>
          <span style={{ color: "#d1d4dc", fontSize: 11 }}>MACD</span>
          {!macdCollapsed && <>
            <span style={{ color: "#787b86", fontSize: 11 }}>close 12 26 9</span>
            <span style={{ color: "#f77c00", fontSize: 11 }}>{fmt(macdLabel.macd)}</span>
            <span style={{ color: "#2962ff", fontSize: 11 }}>{fmt(macdLabel.signal)}</span>
            <span style={{ color: macdLabel.hist >= 0 ? "#26a69a" : "#ef5350", fontSize: 11 }}>{fmt(macdLabel.hist)}</span>
          </>}
          <button onClick={toggleMacd} title={macdCollapsed ? "Show" : "Hide"}
            style={{ marginLeft: "auto", color: "#4a4f5e", fontSize: 15, lineHeight: 1, cursor: "pointer", userSelect: "none" }}>
            {macdCollapsed ? "▸" : "▾"}
          </button>
        </div>
        <div ref={macdRef} style={{ width: "100%", height: macdChartH, overflow: "hidden", display: macdCollapsed ? "none" : undefined }} />
      </div>

      {/* ── Drag handle: MACD / Main ── */}
      <div
        onMouseDown={(e) => { e.preventDefault(); dragRef.current = { which: "macd", startY: e.clientY, startH: macdChartH }; }}
        style={{ height: 5, flexShrink: 0, cursor: "row-resize", background: BORDER, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ width: 28, height: 2, borderRadius: 1, background: "#4a4f5e" }} />
      </div>

      {/* ── Main candle pane ── */}
      <div className="relative" style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
        <div className="absolute top-1 left-2 z-10 flex flex-wrap items-center gap-x-1.5 gap-y-0 text-[11px]" style={{ color: "#787b86" }}>
          <div className="w-1.5 h-1.5 rounded-full" style={{ background: "#26a69a", boxShadow: "0 0 4px #26a69a" }} />
          <span style={{ color: "#d1d4dc", fontWeight: 600 }}>
            {symbol === "BTC-USD" ? "Bitcoin / U.S. Dollar" : "Solana / U.S. Dollar"}
          </span>
          <span>·</span><span>{timeframe}</span><span>·</span><span>Coinbase</span>
          <span className="ml-1">O <span style={{ color: "#d1d4dc" }}>{fmtPrice(ohlc.o)}</span></span>
          <span>H <span style={{ color: "#26a69a" }}>{fmtPrice(ohlc.h)}</span></span>
          <span>L <span style={{ color: "#ef5350" }}>{fmtPrice(ohlc.l)}</span></span>
          <span>C <span style={{ color: "#d1d4dc" }}>{fmtPrice(ohlc.c)}</span></span>
          <span style={{ color: ohlc.chg >= 0 ? "#26a69a" : "#ef5350" }}>
            {ohlc.chg >= 0 ? "+" : ""}{fmtPrice(ohlc.chg)} ({ohlc.pct >= 0 ? "+" : ""}{fmt(ohlc.pct)}%)
          </span>
        </div>
        <div ref={mainRef} style={{ width: "100%", height: "100%" }} />
      </div>

      {/* ── Drag handle: Main / RSI ── */}
      <div
        onMouseDown={(e) => { e.preventDefault(); dragRef.current = { which: "rsi", startY: e.clientY, startH: rsiChartH }; }}
        style={{ height: 5, flexShrink: 0, cursor: "row-resize", background: BORDER, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ width: 28, height: 2, borderRadius: 1, background: "#4a4f5e" }} />
      </div>

      {/* ── RSI pane ── */}
      <div style={{ flexShrink: 0 }}>
        <div style={{ height: 26, display: "flex", alignItems: "center", gap: 6, padding: "0 8px" }}>
          <span style={{ color: "#d1d4dc", fontSize: 11 }}>RSI</span>
          {!rsiCollapsed && <>
            <span style={{ color: "#787b86", fontSize: 11 }}>14 close</span>
            <span style={{ color: "#9575cd", fontSize: 11 }}>{fmt(rsiLabel.rsi)}</span>
            <span style={{ color: "#f59e0b", fontSize: 11 }}>{fmt(rsiLabel.ma)}</span>
            {divTypes.some((t) => t === "regular_bullish") && <span style={{ color: "#26a69a", fontWeight: 600, fontSize: 11 }}>bull div</span>}
            {divTypes.some((t) => t === "regular_bearish") && <span style={{ color: "#ef5350", fontWeight: 600, fontSize: 11 }}>bear div</span>}
            {divTypes.some((t) => t === "hidden_bullish")  && <span style={{ color: "rgba(38,166,154,0.8)", fontSize: 11 }}>hbull</span>}
            {divTypes.some((t) => t === "hidden_bearish")  && <span style={{ color: "rgba(239,83,80,0.8)", fontSize: 11 }}>hbear</span>}
          </>}
          <button onClick={toggleRsi} title={rsiCollapsed ? "Show" : "Hide"}
            style={{ marginLeft: "auto", color: "#4a4f5e", fontSize: 15, lineHeight: 1, cursor: "pointer", userSelect: "none" }}>
            {rsiCollapsed ? "▴" : "▾"}
          </button>
        </div>
        <div ref={rsiRef} style={{ width: "100%", height: rsiChartH, overflow: "hidden", display: rsiCollapsed ? "none" : undefined }} />
      </div>

    </div>
  );
}
