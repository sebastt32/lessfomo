import { describe, expect, it } from "vitest";
import { parseMintAccount } from "./parse-mint-account.js";

const mintAccount = (info: Record<string, unknown>, program = "spl-token-2022") => ({
  value: { data: { parsed: { type: "mint", info }, program } },
});

describe("parseMintAccount", () => {
  it("reads revoked authorities from a pump.fun Token-2022 mint", () => {
    const account = mintAccount({
      mintAuthority: null,
      freezeAuthority: null,
      supply: "1000000000000000",
      extensions: [
        { extension: "metadataPointer", state: { authority: null } },
        { extension: "tokenMetadata", state: { updateAuthority: null } },
      ],
    });

    expect(parseMintAccount(account)).toEqual({
      mintAuthority: null,
      freezeAuthority: null,
      dangerousExtensions: [],
    });
  });

  it("reads active authorities from a classic SPL mint without extensions", () => {
    const account = mintAccount({ mintAuthority: "dev", freezeAuthority: "dev2" }, "spl-token");

    expect(parseMintAccount(account)).toEqual({
      mintAuthority: "dev",
      freezeAuthority: "dev2",
      dangerousExtensions: [],
    });
  });

  it("flags extensions that let someone take or lock holder funds", () => {
    const account = mintAccount({
      mintAuthority: null,
      freezeAuthority: null,
      extensions: [
        { extension: "permanentDelegate", state: { delegate: "dev" } },
        { extension: "transferHook", state: { authority: null, programId: "hookProgram" } },
        { extension: "nonTransferable" },
        { extension: "defaultAccountState", state: { accountState: "frozen" } },
        { extension: "pausableConfig", state: { authority: "dev", paused: false } },
        { extension: "transferFeeConfig", state: { transferFeeConfigAuthority: "dev" } },
        { extension: "mintCloseAuthority", state: { closeAuthority: "dev" } },
      ],
    });

    expect(parseMintAccount(account)?.dangerousExtensions).toEqual([
      "permanentDelegate",
      "transferHook",
      "nonTransferable",
      "defaultAccountState",
      "pausableConfig",
      "transferFeeConfig",
      "mintCloseAuthority",
    ]);
  });

  it("ignores dangerous extensions whose authority was renounced", () => {
    const account = mintAccount({
      mintAuthority: null,
      freezeAuthority: null,
      extensions: [
        { extension: "permanentDelegate", state: { delegate: null } },
        { extension: "transferHook", state: { programId: null } },
        { extension: "defaultAccountState", state: { accountState: "initialized" } },
        { extension: "pausableConfig", state: { authority: null } },
        { extension: "mintCloseAuthority", state: { closeAuthority: null } },
      ],
    });

    expect(parseMintAccount(account)?.dangerousExtensions).toEqual([]);
  });

  it("returns null when the account does not exist", () => {
    expect(parseMintAccount({ value: null })).toBeNull();
  });

  it("returns null when the account is not a mint", () => {
    expect(parseMintAccount({ value: { data: { parsed: { type: "account", info: {} } } } })).toBeNull();
  });
});
