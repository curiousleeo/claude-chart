import type { Timeframe } from "./types";

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

const INTERVAL_MAP: Record<Timeframe, string> = {
  "1m": "1m",
  "5m": "5m",
  "15m": "15m",
  "1h": "1h",
  "6h": "6h",
  "1d": "1d",
};

export async function fetchCandles(symbol: string, timeframe: Timeframe, limit = 500): Promise<Candle[]> {
  const interval = INTERVAL_MAP[timeframe];
  const res = await fetch(
    `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`
  );
  const data = await res.json();
  return data.map((k: unknown[]) => ({
    time: Math.floor((k[0] as number) / 1000),
    open: parseFloat(k[1] as string),
    high: parseFloat(k[2] as string),
    low: parseFloat(k[3] as string),
    close: parseFloat(k[4] as string),
  }));
}

export function subscribeLiveCandle(
  symbol: string,
  timeframe: Timeframe,
  onCandle: (candle: Candle) => void
): () => void {
  const interval = INTERVAL_MAP[timeframe];
  const ws = new WebSocket(
    `wss://stream.binance.com:9443/ws/${symbol.toLowerCase()}@kline_${interval}`
  );

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    const k = msg.k;
    onCandle({
      time: Math.floor(k.t / 1000),
      open: parseFloat(k.o),
      high: parseFloat(k.h),
      low: parseFloat(k.l),
      close: parseFloat(k.c),
    });
  };

  return () => ws.close();
}
