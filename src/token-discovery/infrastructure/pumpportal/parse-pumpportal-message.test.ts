import { describe, expect, it } from "vitest";
import { parsePumpPortalMessage } from "./parse-pumpportal-message.js";

const DETECTED_AT = new Date("2026-11-13T20:00:00.000Z");

const createEvent = {
  signature: "5wVaaaCcNWzfn79WDNQH7aMX9uV7uxbnTVpcMYWcTJKqmzQPk3AzjpvikXkZduQ2mznbJE7RxknqVbbTAXeR24fq",
  mint: "E5Ww5LyBHaxPYwogS7eFGnJcysUsuEzFGmDt51Z1pump",
  traderPublicKey: "HWUnfRdrzFfyPpVcmZHr9FdenUP1hjP1C7jUSyzYP1FH",
  txType: "create",
  initialBuy: 2701556.534012,
  solAmount: 0.075723455,
  bondingCurveKey: "5iHxiGG6LiyEvKEGnk9UgFbcTi3Nb3tpUTSqCGL3h2Fh",
  vTokensInBondingCurve: 1070298443.465988,
  vSolInBondingCurve: 30.07572345499999,
  marketCapSol: 28.100315046338512,
  name: "cock bride",
  symbol: "COCKBRIDE",
  uri: "https://ipfs.io/ipfs/bafkreicj2zyuihw3cdc3nkigqaokgx25rar6idzoluylpdeow6e2pxtr4y",
  is_mayhem_mode: true,
  pool: "pump",
};

describe("parsePumpPortalMessage", () => {
  it("maps a token creation event to a NewToken", () => {
    const result = parsePumpPortalMessage(JSON.stringify(createEvent), DETECTED_AT);

    expect(result).toEqual({
      mint: createEvent.mint,
      name: "cock bride",
      symbol: "COCKBRIDE",
      creator: createEvent.traderPublicKey,
      signature: createEvent.signature,
      metadataUri: createEvent.uri,
      bondingCurve: createEvent.bondingCurveKey,
      pool: "pump",
      initialBuyTokens: 2701556.534012,
      initialBuySol: 0.075723455,
      marketCapSol: 28.100315046338512,
      detectedAt: DETECTED_AT,
    });
  });

  it("ignores the subscription acknowledgement", () => {
    const ack = JSON.stringify({ message: "Successfully subscribed to token creation events." });

    expect(parsePumpPortalMessage(ack, DETECTED_AT)).toBeNull();
  });

  it("ignores events that are not token creations", () => {
    const trade = JSON.stringify({ ...createEvent, txType: "buy" });

    expect(parsePumpPortalMessage(trade, DETECTED_AT)).toBeNull();
  });

  it("ignores events missing required fields", () => {
    const { mint: _mint, ...withoutMint } = createEvent;

    expect(parsePumpPortalMessage(JSON.stringify(withoutMint), DETECTED_AT)).toBeNull();
  });

  it("ignores events with non-numeric amounts", () => {
    const broken = JSON.stringify({ ...createEvent, marketCapSol: "28.1" });

    expect(parsePumpPortalMessage(broken, DETECTED_AT)).toBeNull();
  });

  it("ignores payloads that are not valid JSON", () => {
    expect(parsePumpPortalMessage("not json", DETECTED_AT)).toBeNull();
  });
});
