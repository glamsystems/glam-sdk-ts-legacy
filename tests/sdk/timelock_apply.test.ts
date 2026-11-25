import { PublicKey } from "@solana/web3.js";

import type { BaseClient } from "../../src/client/base";
import type { StateClient } from "../../src/client/state";
import { TimelockClient } from "../../src/client/timelock";
import { StateAccountType } from "../../src/models";

// glam_protocol counts a single-asset vault as a tokenized vault, whose staged
// changes glam_mint applies. The client refused that account type, while the
// CLI's confirmations sent its owner to `timelock apply`.
describe("TimelockClient.apply", () => {
  function timelock(accountType: StateAccountType) {
    const sendAndConfirm = jest.fn(async (..._args: unknown[]) => "SIG");
    const client = new TimelockClient(
      {
        fetchStateAccount: jest.fn(async () => ({ accountType })),
        sendAndConfirm,
        signer: PublicKey.unique(),
      } as unknown as BaseClient,
      {} as StateClient,
    );
    const mintTx = { mint: true };
    const stateTx = { state: true };
    jest
      .spyOn(client.txBuilder, "applyMintTimelockTx")
      .mockResolvedValue(mintTx as never);
    jest
      .spyOn(client.txBuilder, "applyStateTimelockTx")
      .mockResolvedValue(stateTx as never);
    return { client, sendAndConfirm, mintTx, stateTx };
  }

  it.each([
    ["a single-asset vault", StateAccountType.SINGLE_ASSET_VAULT],
    ["a tokenized vault", StateAccountType.TOKENIZED_VAULT],
    ["a mint", StateAccountType.MINT],
  ])("applies %s through glam_mint", async (_name, accountType) => {
    const { client, sendAndConfirm, mintTx } = timelock(accountType);
    await expect(client.apply()).resolves.toBe("SIG");
    expect(sendAndConfirm).toHaveBeenCalledWith(mintTx);
  });

  it("applies a vault through glam_protocol", async () => {
    const { client, sendAndConfirm, stateTx } = timelock(
      StateAccountType.VAULT,
    );
    await expect(client.apply()).resolves.toBe("SIG");
    expect(sendAndConfirm).toHaveBeenCalledWith(stateTx);
  });
});
