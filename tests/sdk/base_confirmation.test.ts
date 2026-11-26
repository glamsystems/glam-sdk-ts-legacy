import { AnchorProvider, Wallet, utils } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  SystemProgram,
  Transaction,
  type Commitment,
} from "@solana/web3.js";
import { BaseClient } from "../../src/client/base";
import { ClusterNetwork } from "../../src/clientConfig";

/** A signed transaction's id, its first signature. */
const idOf = (tx: Transaction) => utils.bytes.bs58.encode(tx.signature!);

describe("BaseClient transaction confirmation", () => {
  const savedEnvironment = {
    NEXT_PUBLIC_WEBSOCKET_DISABLED: process.env.NEXT_PUBLIC_WEBSOCKET_DISABLED,
    WEBSOCKET_DISABLED: process.env.WEBSOCKET_DISABLED,
  };

  beforeEach(() => {
    delete process.env.NEXT_PUBLIC_WEBSOCKET_DISABLED;
    delete process.env.WEBSOCKET_DISABLED;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  function createClient(commitment?: Commitment) {
    const connection = new Connection("http://localhost:8899", commitment);
    const wallet = new Wallet(Keypair.generate());
    const latestBlockhash = {
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 100,
    };
    jest
      .spyOn(connection, "getLatestBlockhash")
      .mockResolvedValue(latestBlockhash);
    const client = new BaseClient({
      provider: new AnchorProvider(connection, wallet, {}),
      cluster: ClusterNetwork.Devnet,
      useStaging: false,
    });
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey: Keypair.generate().publicKey,
        lamports: 1,
      }),
    );
    // The RPC answers with the transaction's own id once the wallet signed it.
    jest
      .spyOn(connection, "sendRawTransaction")
      .mockImplementation(async () => idOf(tx));
    return { client, connection, latestBlockhash, tx };
  }

  it.each([
    ["processed", "processed"],
    ["confirmed", "confirmed"],
    ["recent", "recent"],
    ["single", "single"],
    ["confirmed", "finalized"],
    ["confirmed", undefined],
  ] as const)(
    "uses %s WebSocket commitment for connection commitment %s",
    async (expectedCommitment, connectionCommitment) => {
      const { client, connection, latestBlockhash, tx } =
        createClient(connectionCommitment);
      const confirm = jest
        .spyOn(connection, "confirmTransaction")
        .mockImplementation(async (_strategy, commitment) => {
          const requestedCommitment =
            commitment ?? connection.commitment ?? "finalized";
          if (requestedCommitment !== expectedCommitment) {
            throw new Error("Unexpected transaction confirmation commitment");
          }
          return { context: { slot: 1 }, value: { err: null } };
        });

      expect(await client.sendAndConfirm(tx)).toBe(idOf(tx));

      expect(confirm).toHaveBeenCalledWith(
        { ...latestBlockhash, signature: idOf(tx) },
        expectedCommitment,
      );
      expect(connection.commitment).toBe(connectionCommitment);
    },
  );

  it.each(["confirmed", "finalized"] as const)(
    "accepts a %s transaction on the polling path",
    async (confirmationStatus) => {
      process.env.WEBSOCKET_DISABLED = "1";
      const { client, connection, tx } = createClient("finalized");
      const status = jest
        .spyOn(connection, "getSignatureStatus")
        .mockResolvedValue({
          context: { slot: 1 },
          value: {
            slot: 1,
            confirmations: confirmationStatus === "finalized" ? null : 1,
            confirmationStatus,
            err: null,
          },
        });

      expect(await client.sendAndConfirm(tx)).toBe(idOf(tx));

      expect(status).toHaveBeenCalledTimes(1);
      expect(status).toHaveBeenCalledWith(idOf(tx));
    },
  );

  it("reports a processed polling error immediately", async () => {
    process.env.WEBSOCKET_DISABLED = "1";
    const { client, connection, tx } = createClient("finalized");
    const status = jest
      .spyOn(connection, "getSignatureStatus")
      .mockResolvedValue({
        context: { slot: 1 },
        value: {
          slot: 1,
          confirmations: 0,
          confirmationStatus: "processed",
          err: { InstructionError: [0, { Custom: 6000 }] },
        },
      });
    jest.spyOn(connection, "getTransaction").mockResolvedValue(null);

    await expect(client.sendAndConfirm(tx)).rejects.toMatchObject({
      rawError: { InstructionError: [0, { Custom: 6000 }] },
    });
    expect(status).toHaveBeenCalledTimes(1);
  });

  it.each(["confirmed", "finalized"] as const)(
    "reports a %s failure on the polling path",
    async (confirmationStatus) => {
      process.env.WEBSOCKET_DISABLED = "1";
      const { client, connection, tx } = createClient("finalized");
      const rawError = { InstructionError: [0, { Custom: 6000 }] };
      const status = jest
        .spyOn(connection, "getSignatureStatus")
        .mockResolvedValue({
          context: { slot: 1 },
          value: {
            slot: 1,
            confirmations: confirmationStatus === "finalized" ? null : 1,
            confirmationStatus,
            err: rawError,
          },
        });
      jest.spyOn(connection, "getTransaction").mockResolvedValue(null);

      await expect(client.sendAndConfirm(tx)).rejects.toMatchObject({
        rawError,
      });
      expect(status).toHaveBeenCalledTimes(1);
    },
  );

  it("reads a failed transaction at confirmed and retains the confirmation error when its body is unavailable", async () => {
    const { client, connection, tx } = createClient("finalized");
    const rawError = { InstructionError: [0, { Custom: 6000 }] };
    jest.spyOn(connection, "confirmTransaction").mockResolvedValue({
      context: { slot: 1 },
      value: { err: rawError },
    });
    const readback = jest
      .spyOn(connection, "getTransaction")
      .mockResolvedValue(null);

    await expect(client.sendAndConfirm(tx)).rejects.toMatchObject({
      rawError,
      programLogs: [],
    });

    expect(readback).toHaveBeenCalledWith(idOf(tx), {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 1,
    });
    expect(connection.commitment).toBe("finalized");
  });

  it("throws an Error naming the event's type when the WebSocket confirmation rejects with an Event", async () => {
    const { client, connection, tx } = createClient();
    jest
      .spyOn(connection, "confirmTransaction")
      .mockRejectedValue(new Event("error"));

    await expect(client.sendAndConfirm(tx)).rejects.toThrow(
      "WebSocket error during transaction confirmation: error",
    );
  });

  it("throws a new Error with the rejection as its cause when the WebSocket confirmation rejects with a revoked proxy", async () => {
    const { client, connection, tx } = createClient();
    const { proxy, revoke } = Proxy.revocable(new Event("error"), {});
    revoke();
    jest.spyOn(connection, "confirmTransaction").mockRejectedValue(proxy);

    const error = await client.sendAndConfirm(tx).catch((e) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe(
      "An error with no readable message; the original is the cause",
    );
    expect(error.cause).toBe(proxy);
    expect(
      Object.prototype.hasOwnProperty.call(error, "unacknowledgedSignature"),
    ).toBe(false);
  });

  it("rethrows the rejection as it is when the WebSocket confirmation rejects with an Event whose type cannot be read", async () => {
    const { client, connection, tx } = createClient();
    const event = Object.defineProperty(new Event("error"), "type", {
      get() {
        throw new TypeError("unreadable");
      },
    });
    jest.spyOn(connection, "confirmTransaction").mockRejectedValue(event);

    await expect(client.sendAndConfirm(tx)).rejects.toBe(event);
  });

  it("rethrows the rejection as it is when the WebSocket confirmation rejects with an Event whose type cannot be converted to text", async () => {
    const { client, connection, tx } = createClient();
    const event = Object.defineProperty(new Event("error"), "type", {
      value: {
        toString() {
          throw new TypeError("unconvertible");
        },
      },
    });
    jest.spyOn(connection, "confirmTransaction").mockRejectedValue(event);

    await expect(client.sendAndConfirm(tx)).rejects.toBe(event);
  });
});
