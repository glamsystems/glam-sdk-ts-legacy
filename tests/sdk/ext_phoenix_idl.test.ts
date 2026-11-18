import { BN, Program, type Idl, type Provider } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

import { BaseClient } from "../../src/client/base";
import {
  PhoenixClient,
  type PhoenixRegisterTraderParams,
} from "../../src/client/phoenix";
import ExtPhoenixIdl from "../../target/idl/ext_phoenix.json";
import ExtPhoenixStagingIdl from "../../target/idl/ext_phoenix-staging.json";

const REGISTER_TRADER_ACCOUNT_ORDER = [
  "glam_state",
  "glam_vault",
  "glam_signer",
  "integration_authority",
  "cpi_program",
  "glam_protocol_program",
  "log_authority",
  "global_config",
  "trader_account",
  "system_program",
];

describe.each([
  ["mainnet", ExtPhoenixIdl],
  ["staging", ExtPhoenixStagingIdl],
])("ext_phoenix %s IDL", (_variant, idl) => {
  it("preserves the deployed register_trader account order", () => {
    const registerTrader = idl.instructions.find(
      (instruction) => instruction.name === "register_trader",
    );

    expect(registerTrader).toBeDefined();
    expect(registerTrader?.accounts.map((account) => account.name)).toEqual(
      REGISTER_TRADER_ACCOUNT_ORDER,
    );
  });

  // u32 max_positions, u32 trader_preference_bits, u8 pda index, u8 subaccount index.
  it("encodes both register_trader parameter forms as the same ten bytes", async () => {
    const base = {
      statePda: PublicKey.unique(),
      vaultPda: PublicKey.unique(),
      signer: PublicKey.unique(),
      protocolProgram: { programId: PublicKey.unique() },
      extPhoenixProgram: new Program(idl as Idl, {} as Provider),
      // Set so the client builds no Rise client of its own.
      phoenixRiseClient: {},
    } as unknown as BaseClient;
    const client = new PhoenixClient(base);
    const encode = async (params: PhoenixRegisterTraderParams) => {
      const ix = await client.txBuilder.registerTraderIx(params, {
        traderAccount: PublicKey.unique(),
      });
      return ix.data.subarray(8).toString("hex");
    };

    const withBn = await encode({
      maxPositions: new BN(64),
      traderPdaIndex: 1,
      traderSubaccountIndex: 2,
    });
    const withNumber = await encode({
      maxPositions: 64,
      traderPreferenceBits: 0,
      traderPdaIndex: 1,
      traderSubaccountIndex: 2,
    });

    expect(withBn).toBe("40000000000000000102");
    expect(withNumber).toBe(withBn);

    // The bits are the caller's to state; the program refuses any but zero.
    expect(
      await encode({
        maxPositions: 64,
        traderPreferenceBits: 7,
        traderPdaIndex: 1,
        traderSubaccountIndex: 2,
      }),
    ).toBe("40000000070000000102");

    const indexes = { traderPdaIndex: 1, traderSubaccountIndex: 2 };
    await expect(encode({ maxPositions: 64.5, ...indexes })).rejects.toThrow(
      "maxPositions must be an integer",
    );
    await expect(
      encode({ maxPositions: new BN(2).pow(new BN(32)), ...indexes }),
    ).rejects.toThrow("maxPositions must be an integer");
    await expect(encode({ maxPositions: -1, ...indexes })).rejects.toThrow(
      "maxPositions must be an integer",
    );
  });
});
