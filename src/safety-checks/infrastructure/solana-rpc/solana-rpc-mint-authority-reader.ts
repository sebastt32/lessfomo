import type { MintAuthorityReader } from "../../domain/mint-authority-reader.js";
import type { MintAuthorities } from "../../domain/token-safety-snapshot.js";
import { parseMintAccount } from "./parse-mint-account.js";
import { callSolanaRpc, SOLANA_PUBLIC_RPC_URL } from "./solana-rpc-client.js";

/** Reads mint authorities straight from the chain through a (free) Solana RPC node. */
export class SolanaRpcMintAuthorityReader implements MintAuthorityReader {
  constructor(private readonly rpcUrl: string = SOLANA_PUBLIC_RPC_URL) {}

  async read(mint: string): Promise<MintAuthorities | null> {
    const result = await callSolanaRpc(this.rpcUrl, "getAccountInfo", [
      mint,
      { encoding: "jsonParsed", commitment: "confirmed" },
    ]);
    return parseMintAccount(result);
  }
}
