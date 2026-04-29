import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocket } from "ws";
import { z } from "zod";

// Connect to the relay (hosted WSS or local WS for dev)
const RELAY_URL = process.env.RELAY_URL || "wss://claude-chart-relay-production.up.railway.app";
const server = new McpServer({ name: "claude-chart", version: "1.0.0" });

let relay = null;
let lastState = null;

function connectRelay() {
  const ws = new WebSocket(RELAY_URL);
  relay = ws;

  ws.on("open", () => {
    process.stderr.write(`[mcp] connected to relay at ${RELAY_URL}\n`);
  });

  ws.on("message", (data) => {
    try { lastState = JSON.parse(data.toString()); } catch {}
  });

  ws.on("close", () => {
    process.stderr.write(`[mcp] relay disconnected — retrying in 3s\n`);
    relay = null;
    setTimeout(connectRelay, 3000);
  });

  ws.on("error", () => {
    ws.terminate();
  });
}

connectRelay();

function send(cmd) {
  if (!relay || relay.readyState !== 1) {
    return { content: [{ type: "text", text: "Chart not connected. Make sure the relay is running and the chart app is open." }] };
  }
  relay.send(JSON.stringify(cmd));
  return null;
}

function uid() {
  return Math.random().toString(36).slice(2, 8);
}

// --- Tools ---

server.tool("set_symbol", "Switch the chart to BTC or SOL", {
  symbol: z.enum(["BTC-USD", "SOL-USD"]).describe("Symbol to display"),
}, async ({ symbol }) => {
  const err = send({ type: "set_symbol", symbol });
  return err ?? { content: [{ type: "text", text: `Switched to ${symbol}` }] };
});

server.tool("set_timeframe", "Change the chart timeframe", {
  timeframe: z.enum(["1m", "5m", "15m", "1h", "6h", "1d"]).describe("Timeframe"),
}, async ({ timeframe }) => {
  const err = send({ type: "set_timeframe", timeframe });
  return err ?? { content: [{ type: "text", text: `Timeframe set to ${timeframe}` }] };
});

server.tool("draw_level", "Draw a horizontal price level on the chart", {
  price: z.number().describe("Price level"),
  label: z.string().optional().describe("Label text (e.g. 'Resistance')"),
  color: z.string().optional().describe("Hex color, default amber"),
}, async ({ price, label, color }) => {
  const id = uid();
  const err = send({ type: "draw_level", id, price, label, color });
  return err ?? { content: [{ type: "text", text: `Drew level at $${price}${label ? ` (${label})` : ""} [id: ${id}]` }] };
});

server.tool("draw_trendline", "Draw a trend line between two price/time points", {
  time1: z.number().describe("Start time as Unix timestamp (seconds)"),
  price1: z.number().describe("Start price"),
  time2: z.number().describe("End time as Unix timestamp (seconds)"),
  price2: z.number().describe("End price"),
  label: z.string().optional().describe("Optional label"),
  color: z.string().optional().describe("Hex color, default blue"),
}, async ({ time1, price1, time2, price2, label, color }) => {
  const id = uid();
  const err = send({ type: "draw_trendline", id, time1, price1, time2, price2, label, color });
  return err ?? { content: [{ type: "text", text: `Drew trendline from $${price1} to $${price2} [id: ${id}]` }] };
});

server.tool("draw_zone", "Draw a shaded price zone (support/resistance range)", {
  priceHigh: z.number().describe("Top of the zone"),
  priceLow: z.number().describe("Bottom of the zone"),
  label: z.string().optional().describe("Zone label (e.g. 'Support zone')"),
  color: z.string().optional().describe("Hex color, default purple"),
}, async ({ priceHigh, priceLow, label, color }) => {
  const id = uid();
  const err = send({ type: "draw_zone", id, priceHigh, priceLow, label, color });
  return err ?? { content: [{ type: "text", text: `Drew zone $${priceLow}–$${priceHigh}${label ? ` (${label})` : ""} [id: ${id}]` }] };
});

server.tool("remove_drawing", "Remove a specific drawing by ID", {
  id: z.string().describe("Drawing ID returned when it was created"),
}, async ({ id }) => {
  const err = send({ type: "remove_drawing", id });
  return err ?? { content: [{ type: "text", text: `Removed drawing ${id}` }] };
});

server.tool("clear_drawings", "Remove all drawings from the chart", {}, async () => {
  const err = send({ type: "clear_drawings" });
  return err ?? { content: [{ type: "text", text: "Cleared all drawings" }] };
});

server.tool("detect_divergence", "Scan the current chart for RSI divergences (regular and hidden)", {}, async () => {
  if (!relay || relay.readyState !== 1) {
    return { content: [{ type: "text", text: "Chart not connected. Make sure the relay is running and the chart app is open." }] };
  }
  relay.send(JSON.stringify({ type: "get_state" }));
  await new Promise((r) => setTimeout(r, 300));
  const divs = lastState?.divergences;
  if (!divs?.length) {
    return { content: [{ type: "text", text: "No divergences detected in the current view." }] };
  }
  const LABELS = {
    regular_bullish: "Regular Bullish",
    regular_bearish: "Regular Bearish",
    hidden_bullish:  "Hidden Bullish",
    hidden_bearish:  "Hidden Bearish",
  };
  const lines = divs.map((d) => {
    const t1 = new Date(d.p1.time * 1000).toISOString().slice(0, 16).replace("T", " ");
    const t2 = new Date(d.p2.time * 1000).toISOString().slice(0, 16).replace("T", " ");
    return `${LABELS[d.type]}: price $${d.p1.price.toFixed(2)} → $${d.p2.price.toFixed(2)} | RSI ${d.p1.rsi.toFixed(1)} → ${d.p2.rsi.toFixed(1)} [${t1} → ${t2}]`;
  });
  return { content: [{ type: "text", text: lines.join("\n") }] };
});

server.tool("get_chart_state", "Get current symbol, timeframe, price, and active drawings", {}, async () => {
  if (!relay || relay.readyState !== 1) {
    return { content: [{ type: "text", text: "Chart not connected." }] };
  }
  relay.send(JSON.stringify({ type: "get_state" }));
  await new Promise((r) => setTimeout(r, 300));
  return {
    content: [{
      type: "text",
      text: lastState ? JSON.stringify(lastState, null, 2) : "No state received yet",
    }],
  };
});

// Start
const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`Claude Chart MCP running — relay: ${RELAY_URL}\n`);
