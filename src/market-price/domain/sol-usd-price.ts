export type SolUsdListener = (solUsd: number) => void;

/** Port: latest SOL/USD price, or null while it is unknown. */
export interface SolUsdPrice {
  current(): number | null;
  /** Called whenever the known price changes. */
  subscribe(listener: SolUsdListener): () => void;
}
