import { isObject } from "../../../shared/json.js";

export const SOLANA_PUBLIC_RPC_URL = "https://api.mainnet-beta.solana.com";

/** Sends one JSON-RPC request and returns its `result`, throwing on HTTP or RPC errors. */
export const callSolanaRpc = async (
  url: string,
  method: string,
  params: unknown[],
  fetchFn: typeof fetch = fetch,
): Promise<unknown> => {
  const response = await fetchFn(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) {
    throw new Error(`Solana RPC ${method} responded ${response.status}`);
  }

  const body: unknown = await response.json();
  if (!isObject(body)) throw new Error(`Solana RPC ${method} returned an invalid body`);
  if (isObject(body["error"])) {
    throw new Error(`Solana RPC ${method} failed: ${String(body["error"]["message"])}`);
  }
  return body["result"];
};
