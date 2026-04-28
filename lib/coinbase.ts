import type { Timeframe } from "./types";

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

// Coinbase Exchange granularity in seconds
const GRANULARITY: Record<Timeframe, number> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3600,
  "4h": 14400,
  "1d": 86400,
};

const BASE = "https://api.exchange.coinbase.com";

const PAGE = 300; // Coinbase hard limit per request

async function fetchPage(symbol: string, granularity: number, endMs: number): Promise<Candle[]> {
  const end = new Date(endMs);
  const start = new Date(endMs - granularity * PAGE * 1000);
  const url = `${BASE}/products/${symbol}/candles?granularity=${granularity}&start=${start.toISOString()}&end=${end.toISOString()}`;
  const res = await fetch(url);
  const data: [number, number, number, number, number, number][] = await res.json();
  if (!Array.isArray(data)) return [];
  return data.map(([time, low, high, open, close]) => ({ time, open, high, low, close }));
}

export async function fetchCandles(symbol: string, timeframe: Timeframe, pages = 3): Promise<Candle[]> {
  const granularity = GRANULARITY[timeframe];
  const pageMs = granularity * PAGE * 1000;

  // Fetch pages sequentially, walking backward in time
  const now = Date.now();
  const pagePromises: Promise<Candle[]>[] = [];
  for (let i = 0; i < pages; i++) {
    pagePromises.push(fetchPage(symbol, granularity, now - i * pageMs));
  }
  const pages_data = await Promise.all(pagePromises);

  // Merge, deduplicate by timestamp, sort ascending
  const seen = new Set<number>();
  const all: Candle[] = [];
  for (const page of pages_data) {
    for (const c of page) {
      if (!seen.has(c.time)) { seen.add(c.time); all.push(c); }
    }
  }
  all.sort((a, b) => a.time - b.time);
  return all;
}

export function subscribeLiveCandle(
  symbol: string,
  _timeframe: Timeframe,
  onCandle: (candle: Candle) => void
): () => void {
  const ws = new WebSocket("wss://ws-feed.exchange.coinbase.com");

  ws.onopen = () => {
    ws.send(JSON.stringify({
      type: "subscribe",
      product_ids: [symbol],
      channels: ["ticker"],
    }));
  };

  // Track the current open/high/low for the live candle update
  let currentCandle: Candle | null = null;

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type !== "ticker" || !msg.price) return;

    const price = parseFloat(msg.price);
    const time = Math.floor(Date.now() / 1000);

    if (!currentCandle) {
      currentCandle = { time, open: price, high: price, low: price, close: price };
    } else {
      currentCandle = {
        ...currentCandle,
        high: Math.max(currentCandle.high, price),
        low: Math.min(currentCandle.low, price),
        close: price,
      };
    }

    onCandle({ ...currentCandle });
  };

  ws.onerror = () => ws.close();

  return () => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: "unsubscribe",
        product_ids: [symbol],
        channels: ["ticker"],
      }));
    }
    ws.close();
  };
}
