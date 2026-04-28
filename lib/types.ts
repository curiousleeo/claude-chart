export type Symbol = "BTC-USD" | "SOL-USD";
export type Timeframe = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";

export type MCPCommand =
  | { type: "set_symbol"; symbol: Symbol }
  | { type: "set_timeframe"; timeframe: Timeframe }
  | { type: "draw_level"; id: string; price: number; label?: string; color?: string }
  | { type: "draw_trendline"; id: string; time1: number; price1: number; time2: number; price2: number; color?: string; label?: string }
  | { type: "draw_zone"; id: string; priceHigh: number; priceLow: number; label?: string; color?: string }
  | { type: "add_label"; id: string; time: number; price: number; text: string; color?: string }
  | { type: "remove_drawing"; id: string }
  | { type: "clear_drawings" }
  | { type: "get_state" };

export interface ChartState {
  symbol: Symbol;
  timeframe: Timeframe;
  price: number;
  drawings: DrawingRecord[];
}

export interface DrawingRecord {
  id: string;
  type: string;
  params: Record<string, unknown>;
}
