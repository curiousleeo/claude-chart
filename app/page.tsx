"use client";

import { useState, useRef, useEffect } from "react";
import TradingChart from "../components/TradingChart";
import type { Symbol, Timeframe, MCPCommand, DrawingRecord } from "../lib/types";

const DEFAULT_WS = "wss://claude-chart-relay-production.up.railway.app";
const MIN_DELAY = 2000;
const MAX_DELAY = 30000;

function getStoredWsUrl(): string {
  if (typeof window === "undefined") return DEFAULT_WS;
  return localStorage.getItem("claude_chart_ws") ?? DEFAULT_WS;
}

export default function Page() {
  const [symbol, setSymbol]       = useState<Symbol>("BTC-USD");
  const [timeframe, setTimeframe] = useState<Timeframe>("1h");
  const [price, setPrice]         = useState(0);
  const [drawings, setDrawings]   = useState<DrawingRecord[]>([]);
  const [wsStatus, setWsStatus]   = useState<"connecting" | "connected" | "disconnected">("disconnected");
  const [showSettings, setShowSettings] = useState(false);
  const [wsInput, setWsInput]     = useState(DEFAULT_WS);
  const [retryIn, setRetryIn]     = useState<number | null>(null);

  const commandRef    = useRef<((cmd: MCPCommand) => void) | null>(null);
  const wsRef         = useRef<WebSocket | null>(null);
  const wsUrlRef      = useRef(DEFAULT_WS);
  const delayRef      = useRef(MIN_DELAY);
  const timerRef      = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownRef  = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef    = useRef(true);
  // Use refs for state needed inside WS callbacks to avoid stale closures
  const symbolRef     = useRef(symbol);
  const timeframeRef  = useRef(timeframe);
  const priceRef      = useRef(price);
  const drawingsRef   = useRef(drawings);

  // Keep refs in sync
  useEffect(() => { symbolRef.current = symbol; }, [symbol]);
  useEffect(() => { timeframeRef.current = timeframe; }, [timeframe]);
  useEffect(() => { priceRef.current = price; }, [price]);
  useEffect(() => { drawingsRef.current = drawings; }, [drawings]);

  function clearTimers() {
    if (timerRef.current)    { clearTimeout(timerRef.current);  timerRef.current = null; }
    if (countdownRef.current) { clearInterval(countdownRef.current); countdownRef.current = null; }
    setRetryIn(null);
  }

  function scheduleReconnect() {
    if (!mountedRef.current) return;
    const delay = delayRef.current;
    delayRef.current = Math.min(delay * 2, MAX_DELAY);

    let remaining = Math.ceil(delay / 1000);
    setRetryIn(remaining);
    countdownRef.current = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) { clearInterval(countdownRef.current!); countdownRef.current = null; setRetryIn(null); }
      else setRetryIn(remaining);
    }, 1000);

    timerRef.current = setTimeout(() => connect(wsUrlRef.current), delay);
  }

  function connect(url: string) {
    if (!mountedRef.current) return;
    clearTimers();

    // Mixed content guard — browser blocks ws:// from https:// pages, just stay disconnected quietly
    if (typeof window !== "undefined" && window.location.protocol === "https:" && url.startsWith("ws://")) {
      setWsStatus("disconnected");
      return;
    }

    // Close previous socket cleanly without triggering its onclose reconnect
    if (wsRef.current) {
      const old = wsRef.current;
      old.onclose = null;
      old.onerror = null;
      old.close();
      wsRef.current = null;
    }

    setWsStatus("connecting");
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      if (!mountedRef.current) { ws.close(); return; }
      setWsStatus("connected");
      delayRef.current = MIN_DELAY; // reset backoff on success
      clearTimers();
    };

    ws.onclose = () => {
      if (!mountedRef.current) return;
      if (wsRef.current === ws) wsRef.current = null;
      setWsStatus("disconnected");
      scheduleReconnect();
    };

    ws.onerror = () => {
      ws.onclose = null;
      ws.close();
      if (!mountedRef.current) return;
      if (wsRef.current === ws) wsRef.current = null;
      setWsStatus("disconnected");
      scheduleReconnect();
    };

    ws.onmessage = (e) => {
      try {
        const cmd = JSON.parse(e.data) as MCPCommand;
        if (cmd.type === "set_symbol")    { setSymbol(cmd.symbol); return; }
        if (cmd.type === "set_timeframe") { setTimeframe(cmd.timeframe); return; }
        if (cmd.type === "get_state") {
          ws.send(JSON.stringify({
            symbol: symbolRef.current,
            timeframe: timeframeRef.current,
            price: priceRef.current,
            drawings: drawingsRef.current,
          }));
          return;
        }
        commandRef.current?.(cmd);
      } catch { /* ignore malformed */ }
    };
  }

  useEffect(() => {
    mountedRef.current = true;
    const url = getStoredWsUrl();
    wsUrlRef.current = url;
    setWsInput(url);
    connect(url);
    return () => {
      mountedRef.current = false;
      clearTimers();
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.onerror = null;
        wsRef.current.close();
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function saveWsUrl() {
    localStorage.setItem("claude_chart_ws", wsInput);
    wsUrlRef.current = wsInput;
    delayRef.current = MIN_DELAY;
    setShowSettings(false);
    connect(wsInput);
  }

  const dotColor = wsStatus === "connected" ? "#22c55e" : wsStatus === "connecting" ? "#eab308" : "#ef4444";
  const statusText = wsStatus === "connected" ? "MCP connected"
    : wsStatus === "connecting" ? "MCP connecting…"
    : retryIn ? `MCP retry in ${retryIn}s`
    : "MCP disconnected";

  return (
    <div className="flex flex-col h-screen" style={{ background: "#131722" }}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-1.5 border-b" style={{ borderColor: "rgba(255,255,255,0.06)", background: "#0f1118" }}>
        <span className="text-xs font-bold tracking-widest" style={{ color: "#d1d4dc", letterSpacing: "0.15em" }}>CLAUDE  CHART</span>
        <div className="flex items-center gap-3">
          <span className="text-sm font-mono" style={{ color: "#d1d4dc" }}>
            {price > 0 ? `$${price.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 2 })}` : "—"}
          </span>
          <button onClick={() => setShowSettings((v) => !v)} className="flex items-center gap-1.5">
            <div className="w-1.5 h-1.5 rounded-full transition-colors" style={{ background: dotColor }} />
            <span className="text-xs font-mono transition-colors" style={{ color: "#787b86" }}>{statusText}</span>
          </button>
        </div>
      </div>

      {/* Settings bar */}
      {showSettings && (
        <div className="flex items-center gap-2 px-4 py-2 border-b" style={{ background: "#161a25", borderColor: "rgba(255,255,255,0.06)" }}>
          {window.location.protocol === "https:" && (
            <span className="text-xs text-yellow-400 font-mono mr-1">⚠ HTTPS requires wss://</span>
          )}
          <span className="text-xs font-mono shrink-0" style={{ color: "#787b86" }}>WS URL</span>
          <input
            className="flex-1 text-xs font-mono px-2 py-1 rounded border focus:outline-none"
            style={{ background: "#1e2230", color: "#d1d4dc", borderColor: "#2a2e39" }}
            value={wsInput}
            onChange={(e) => setWsInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && saveWsUrl()}
            placeholder="ws://localhost:8765"
          />
          <button onClick={saveWsUrl}
            className="text-xs font-mono px-3 py-1 rounded transition-colors"
            style={{ background: "#2962ff", color: "#fff" }}>
            Connect
          </button>
        </div>
      )}

      {/* Chart */}
      <div className="flex flex-1 overflow-hidden">
        <div className="flex-1">
          <TradingChart
            symbol={symbol}
            timeframe={timeframe}
            onSymbolChange={setSymbol}
            onTimeframeChange={setTimeframe}
            onPriceChange={setPrice}
            onDrawingsChange={setDrawings}
            commandRef={commandRef}
          />
        </div>

        {drawings.length > 0 && (
          <div className="w-52 border-l p-3 overflow-y-auto" style={{ borderColor: "rgba(255,255,255,0.06)", background: "#0f1118" }}>
            <p className="text-xs mb-2 uppercase tracking-wider" style={{ color: "#787b86" }}>Drawings</p>
            {drawings.map((d) => (
              <div key={d.id} className="text-xs py-1 border-b font-mono" style={{ color: "#d1d4dc", borderColor: "rgba(255,255,255,0.06)" }}>
                <span style={{ color: "#787b86" }}>{d.type}</span>{" "}
                {d.type === "level" && `$${(d.params.price as number).toLocaleString()}`}
                {d.type === "zone" && `$${(d.params.priceLow as number).toLocaleString()} – $${(d.params.priceHigh as number).toLocaleString()}`}
                {d.type === "trendline" && "trend"}
                {d.params.label && <span style={{ color: "#787b86" }} className="ml-1">({d.params.label as string})</span>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
