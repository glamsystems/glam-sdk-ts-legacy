import { AnchorProvider, Wallet, utils } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  SolanaJSONRPCError,
  SystemProgram,
  Transaction,
  TransactionExpiredBlockheightExceededError,
  type Commitment,
  type FetchFn,
  type TransactionError,
} from "@solana/web3.js";
import { BaseClient } from "../../src/client/base";
import { ClusterNetwork } from "../../src/clientConfig";
import { GlamError, parseTxError } from "../../src/error";
import {
  failedTransactionMessage,
  parseProgramLogs,
} from "../../src/utils/transaction";

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

  function createClient(commitment?: Commitment, fetch?: FetchFn) {
    const connection = new Connection(
      "http://localhost:8899",
      fetch ? { commitment, fetch } : commitment,
    );
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

  // `confirmations: null` says the transaction is rooted. Not every node adds
  // `confirmationStatus` to that.
  it("accepts a rooted status that carries no confirmationStatus on the polling path", async () => {
    process.env.WEBSOCKET_DISABLED = "1";
    const { client, connection, tx } = createClient("finalized");
    const status = jest
      .spyOn(connection, "getSignatureStatus")
      .mockResolvedValue({
        context: { slot: 1 },
        value: { slot: 1, confirmations: null, err: null },
      });

    expect(await client.sendAndConfirm(tx)).toBe(idOf(tx));

    expect(status).toHaveBeenCalledTimes(1);
  });

  it("accepts a status with three confirmations and no confirmationStatus on the polling path", async () => {
    process.env.WEBSOCKET_DISABLED = "1";
    const { client, connection, tx } = createClient("finalized");
    const status = jest
      .spyOn(connection, "getSignatureStatus")
      .mockResolvedValue({
        context: { slot: 1 },
        value: { slot: 1, confirmations: 3, err: null },
      });

    expect(await client.sendAndConfirm(tx)).toBe(idOf(tx));

    expect(status).toHaveBeenCalledTimes(1);
  });

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

  // web3.js reads the signature's status only once its websocket
  // subscription is acknowledged, and reports expiry from the block height
  // alone. A websocket that connects late, or never, therefore reports the
  // expiry of a transaction the cluster has confirmed.
  describe("when the WebSocket confirmation reports that the blockhash expired", () => {
    const statusOf = (
      confirmationStatus: "processed" | "confirmed" | "finalized",
      err: TransactionError | null = null,
    ) => ({
      context: { slot: 1 },
      value: {
        slot: 1,
        confirmations: confirmationStatus === "finalized" ? null : 1,
        confirmationStatus,
        err,
      },
    });

    function expiring(
      expiry?: (id: string) => unknown,
      commitment?: Commitment,
    ) {
      const made = createClient(commitment);
      const thrown: { error?: unknown } = {};
      const confirm = jest
        .spyOn(made.connection, "confirmTransaction")
        .mockImplementation(async () => {
          thrown.error = expiry
            ? expiry(idOf(made.tx))
            : new TransactionExpiredBlockheightExceededError(idOf(made.tx));
          throw thrown.error;
        });
      return { ...made, confirm, thrown };
    }

    it.each(["confirmed", "finalized"] as const)(
      "returns the id of a transaction whose status is %s",
      async (confirmationStatus) => {
        const { client, connection, tx } = expiring();
        const status = jest
          .spyOn(connection, "getSignatureStatus")
          .mockResolvedValue(statusOf(confirmationStatus));

        expect(await client.sendAndConfirm(tx)).toBe(idOf(tx));

        expect(status).toHaveBeenCalledTimes(1);
        expect(status).toHaveBeenCalledWith(idOf(tx), {
          searchTransactionHistory: true,
        });
      },
    );

    // A node answers from its recent status cache unless the read asks for
    // the transaction history, and a transaction that landed early can have
    // left that cache by the time its blockhash expires.
    it("finds a finalized transaction that has left the recent status cache", async () => {
      const { client, connection, tx } = expiring();
      jest
        .spyOn(connection, "getSignatureStatus")
        .mockImplementation(async (_signature, config) =>
          config?.searchTransactionHistory
            ? statusOf("finalized")
            : { context: { slot: 1 }, value: null },
        );

      expect(await client.sendAndConfirm(tx)).toBe(idOf(tx));
    });

    // The confirmation waits for the connection's commitment, or for
    // confirmed where the connection has none or says finalized. The status
    // counts once it has reached what the confirmation waited for.
    it.each([
      ["processed", "processed", "id"],
      ["recent", "processed", "id"],
      ["processed", "finalized", "id"],
      ["confirmed", "processed", "expiry"],
      ["confirmed", "confirmed", "id"],
      ["single", "processed", "expiry"],
      ["single", "confirmed", "id"],
      ["singleGossip", "processed", "expiry"],
      ["singleGossip", "finalized", "id"],
      ["finalized", "processed", "expiry"],
      ["finalized", "confirmed", "id"],
      [undefined, "processed", "expiry"],
      [undefined, "confirmed", "id"],
      ["root", "processed", "expiry"],
      ["root", "confirmed", "expiry"],
      ["root", "finalized", "id"],
      ["max", "confirmed", "expiry"],
      ["max", "finalized", "id"],
    ] as const)(
      "for connection commitment %s, a %s status gives the %s",
      async (commitment, confirmationStatus, outcome) => {
        const { client, connection, tx, thrown } = expiring(
          undefined,
          commitment,
        );
        jest
          .spyOn(connection, "getSignatureStatus")
          .mockResolvedValue(statusOf(confirmationStatus));

        const result = await client.sendAndConfirm(tx).catch((e) => e);

        expect(result).toBe(outcome === "id" ? idOf(tx) : thrown.error);
      },
    );

    // `confirmations: null` says the transaction is rooted, which is
    // finalized. Not every node adds `confirmationStatus` to that.
    it.each([undefined, "processed", "confirmed", "root", "max"] as const)(
      "for connection commitment %s, returns the id for a rooted status that carries no confirmationStatus",
      async (commitment) => {
        const { client, connection, tx } = expiring(undefined, commitment);
        jest.spyOn(connection, "getSignatureStatus").mockResolvedValue({
          context: { slot: 1 },
          value: { slot: 1, confirmations: null, err: null },
        });

        expect(await client.sendAndConfirm(tx)).toBe(idOf(tx));
      },
    );

    // Without `confirmationStatus`, Agave's own clients take a count of
    // confirmations above one as confirmed, and a lower count as processed.
    it.each([
      ["processed", 0, "id"],
      ["processed", 3, "id"],
      ["confirmed", 0, "expiry"],
      ["confirmed", 1, "expiry"],
      ["confirmed", 2, "id"],
      ["confirmed", 3, "id"],
      [undefined, 1, "expiry"],
      [undefined, 3, "id"],
      ["finalized", 3, "id"],
      ["root", 3, "expiry"],
      ["max", 31, "expiry"],
    ] as const)(
      "for connection commitment %s, a status with %i confirmations and no confirmationStatus gives the %s",
      async (commitment, confirmations, outcome) => {
        const { client, connection, tx, thrown } = expiring(
          undefined,
          commitment,
        );
        jest.spyOn(connection, "getSignatureStatus").mockResolvedValue({
          context: { slot: 1 },
          value: { slot: 1, confirmations, err: null },
        });

        const result = await client.sendAndConfirm(tx).catch((e) => e);

        expect(result).toBe(outcome === "id" ? idOf(tx) : thrown.error);
      },
    );

    it("reports the failure of a rooted transaction whose status carries no confirmationStatus", async () => {
      const { client, connection, tx } = expiring();
      const rawError = { InstructionError: [0, { Custom: 6000 }] };
      jest.spyOn(connection, "getSignatureStatus").mockResolvedValue({
        context: { slot: 1 },
        value: { slot: 1, confirmations: null, err: rawError },
      });
      jest.spyOn(connection, "getTransaction").mockResolvedValue(null);

      await expect(client.sendAndConfirm(tx)).rejects.toMatchObject({
        rawError,
      });
    });

    // A node that keeps no transaction history rejects a read that searches
    // it, before it looks at its recent status cache.
    it("reads the recent status cache when the node rejects the history search", async () => {
      const { client, connection, tx } = expiring();
      const status = jest
        .spyOn(connection, "getSignatureStatus")
        .mockImplementation(async (_signature, config) => {
          if (config?.searchTransactionHistory) {
            throw new SolanaJSONRPCError(
              {
                code: -32011,
                message: "Transaction history is not available from this node",
              },
              "failed to get signature status",
            );
          }
          return statusOf("confirmed");
        });

      expect(await client.sendAndConfirm(tx)).toBe(idOf(tx));

      expect(status.mock.calls).toEqual([
        [idOf(tx), { searchTransactionHistory: true }],
        [idOf(tx)],
      ]);
    });

    it("reports the expiry for an error whose status has not reached the commitment", async () => {
      const { client, connection, tx, thrown } = expiring();
      jest
        .spyOn(connection, "getSignatureStatus")
        .mockResolvedValue(
          statusOf("processed", { InstructionError: [0, { Custom: 6000 }] }),
        );

      expect(await client.sendAndConfirm(tx).catch((e) => e)).toBe(
        thrown.error,
      );
    });

    it("reads the status for an expiry another copy of web3.js threw", async () => {
      const { client, connection, tx } = expiring((id) =>
        Object.assign(new Error(`Signature ${id} has expired`), {
          name: "TransactionExpiredBlockheightExceededError",
        }),
      );
      jest
        .spyOn(connection, "getSignatureStatus")
        .mockResolvedValue(statusOf("confirmed"));

      expect(await client.sendAndConfirm(tx)).toBe(idOf(tx));
    });

    it("reports the failure of a transaction whose status holds an error", async () => {
      const { client, connection, tx } = expiring();
      const rawError = { InstructionError: [0, { Custom: 6000 }] };
      jest
        .spyOn(connection, "getSignatureStatus")
        .mockResolvedValue(statusOf("confirmed", rawError));
      jest.spyOn(connection, "getTransaction").mockResolvedValue(null);

      await expect(client.sendAndConfirm(tx)).rejects.toMatchObject({
        rawError,
      });
    });

    it.each([
      ["has no status", { context: { slot: 1 }, value: null }],
      ["is processed and not yet confirmed", statusOf("processed")],
    ])("reports the expiry when the transaction %s", async (_case, answer) => {
      const { client, connection, tx, thrown } = expiring();
      const status = jest
        .spyOn(connection, "getSignatureStatus")
        .mockResolvedValue(answer);

      const error = await client.sendAndConfirm(tx).catch((e) => e);

      expect(error).toBeInstanceOf(TransactionExpiredBlockheightExceededError);
      expect(error).toBe(thrown.error);
      expect(status).toHaveBeenCalledTimes(1);
    });

    it("reports the expiry when the status cannot be read, with the history search or without", async () => {
      const { client, connection, tx, thrown } = expiring();
      const status = jest
        .spyOn(connection, "getSignatureStatus")
        .mockRejectedValue(new Error("429 Too Many Requests"));

      const error = await client.sendAndConfirm(tx).catch((e) => e);

      expect(error).toBe(thrown.error);
      expect(status).toHaveBeenCalledTimes(2);
    });
  });

  it("reads no status when the WebSocket confirmation rejects with another error", async () => {
    const { client, connection, tx } = createClient();
    const failure = new Error("socket hang up");
    jest.spyOn(connection, "confirmTransaction").mockRejectedValue(failure);
    const status = jest.spyOn(connection, "getSignatureStatus");

    await expect(client.sendAndConfirm(tx)).rejects.toBe(failure);
    expect(status).not.toHaveBeenCalled();
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

  // A read made after the send must not change what the caller is told. A
  // failed transaction's error is the one its confirmation gave. Its logs
  // come from the transaction's body, where that can be read.
  describe("a failed transaction's error, whatever the read of its logs gives", () => {
    const rawError: TransactionError = {
      InstructionError: [0, { Custom: 6000 }],
    };
    const logs = [
      "Program 11111111111111111111111111111111 invoke [1]",
      "Program 11111111111111111111111111111111 failed: custom program error: 0x1770",
    ];
    const failed = {
      context: { slot: 1 },
      value: {
        slot: 1,
        confirmations: 1,
        confirmationStatus: "confirmed" as const,
        err: rawError,
      },
    };
    const noHistory = () =>
      new SolanaJSONRPCError(
        {
          code: -32011,
          message: "Transaction history is not available from this node",
        },
        "failed to get transaction",
      );

    type Made = ReturnType<typeof createClient>;

    /** How the confirmation comes to say that the transaction failed. */
    const paths: [string, (made: Made) => void][] = [
      [
        "the WebSocket confirmation",
        ({ connection }) => {
          jest.spyOn(connection, "confirmTransaction").mockResolvedValue({
            context: { slot: 1 },
            value: { err: rawError },
          });
        },
      ],
      [
        // The status cache of a node without history answers after it has
        // rejected the search of the history.
        "the recovery after an expiry on a node without history",
        ({ connection, tx }) => {
          jest
            .spyOn(connection, "confirmTransaction")
            .mockImplementation(async () => {
              throw new TransactionExpiredBlockheightExceededError(idOf(tx));
            });
          jest
            .spyOn(connection, "getSignatureStatus")
            .mockImplementation(async (_signature, config) => {
              if (config?.searchTransactionHistory) {
                throw noHistory();
              }
              return failed;
            });
        },
      ],
      [
        "the polling path",
        ({ connection }) => {
          process.env.WEBSOCKET_DISABLED = "1";
          jest
            .spyOn(connection, "getSignatureStatus")
            .mockResolvedValue(failed);
        },
      ],
    ];

    // The logs name the code. Without them the message states the error the
    // confirmation gave, with the instruction's index and the code.
    const FROM_LOGS = "Program error: 0x1770";
    const WITHOUT_LOGS =
      "Transaction failed at instruction 0: custom program error: 0x1770 (6000). The program logs were not available.";

    /**
     * What the read of the transaction's body gives, the logs told and the
     * message.
     */
    const reads: [
      string,
      (made: Made) => jest.SpyInstance,
      string[],
      string,
    ][] = [
      [
        "returns the logs",
        ({ connection }) =>
          jest.spyOn(connection, "getTransaction").mockResolvedValue({
            meta: { err: rawError, logMessages: logs },
          } as never),
        logs,
        FROM_LOGS,
      ],
      [
        "returns null",
        ({ connection }) =>
          jest.spyOn(connection, "getTransaction").mockResolvedValue(null),
        [],
        WITHOUT_LOGS,
      ],
      [
        "is rejected by the node",
        ({ connection }) =>
          jest
            .spyOn(connection, "getTransaction")
            .mockRejectedValue(noHistory()),
        [],
        WITHOUT_LOGS,
      ],
      [
        "throws something that is not an Error",
        ({ connection }) =>
          jest.spyOn(connection, "getTransaction").mockImplementation(() => {
            throw "socket hang up";
          }),
        [],
        WITHOUT_LOGS,
      ],
    ];

    const cells = paths.flatMap(([path, reach]) =>
      reads.map(
        ([read, answer, told, message]) =>
          [path, read, reach, answer, told, message] as const,
      ),
    );

    it.each(cells)(
      "through %s, when the read %s",
      async (_path, _read, reach, answer, told, message) => {
        const made = createClient();
        reach(made);
        const readback = answer(made);

        const error = await made.client.sendAndConfirm(made.tx).then(
          () => {
            throw new Error("the failed transaction was reported as sent");
          },
          (thrown) => thrown,
        );

        expect(error).toBeInstanceOf(GlamError);
        expect(error.rawError).toEqual(rawError);
        expect(error.programLogs).toEqual(told);
        expect(error.message).toBe(message);
        expect(readback).toHaveBeenCalledTimes(1);
      },
    );

    it("holds every path and every read", () => {
      expect(cells).toHaveLength(12);
    });
  });

  // Where the logs name no error, the message is the error the confirmation
  // gave. A code is not resolved to a name there: the index of the outer
  // instruction does not say which program raised it.
  describe("the message of a failed transaction whose logs name no error", () => {
    const UNAVAILABLE = "The program logs were not available.";

    it.each<[TransactionError, string]>([
      [
        { InstructionError: [2, { Custom: 6503 }] },
        `Transaction failed at instruction 2: custom program error: 0x1967 (6503). ${UNAVAILABLE}`,
      ],
      [
        { InstructionError: [0, "InvalidAccountData"] },
        `Transaction failed at instruction 0: InvalidAccountData. ${UNAVAILABLE}`,
      ],
      [
        { InstructionError: [1, { BorshIoError: "Unknown" }] },
        `Transaction failed at instruction 1: {"BorshIoError":"Unknown"}. ${UNAVAILABLE}`,
      ],
      [
        "BlockhashNotFound",
        `Transaction failed: "BlockhashNotFound". ${UNAVAILABLE}`,
      ],
      [
        { InsufficientFundsForRent: { account_index: 1 } },
        `Transaction failed: {"InsufficientFundsForRent":{"account_index":1}}. ${UNAVAILABLE}`,
      ],
    ])("states %j when no logs were read", (error, message) => {
      expect(failedTransactionMessage(error, [], false)).toBe(message);
    });

    it("says that the logs hold no error message where they were read and name none", () => {
      const logs = [
        "Program 11111111111111111111111111111111 invoke [1]",
        "Program 11111111111111111111111111111111 consumed 200000 of 200000 compute units",
        "Program 11111111111111111111111111111111 failed: Computational budget exceeded",
      ];

      expect(
        failedTransactionMessage(
          { InstructionError: [3, "ComputationalBudgetExceeded"] },
          logs,
          false,
        ),
      ).toBe(
        "Transaction failed at instruction 3: ComputationalBudgetExceeded. No error message was found in the program logs.",
      );
      // The exported parser keeps both of its fallbacks.
      expect(parseProgramLogs(logs, false)).toBe("Unknown error");
      expect(parseProgramLogs([], false)).toBe("Invalid program logs");
    });

    it("keeps the error the logs name", () => {
      expect(
        failedTransactionMessage(
          { InstructionError: [0, { Custom: 6008 }] },
          [
            "Program log: AnchorError thrown in programs/glam_mint/src/state/request_queue.rs:346. Error Code: RequestNotCancellable. Error Number: 6008. Error Message: Request is not cancellable.",
          ],
          false,
        ),
      ).toBe("Request is not cancellable");
    });

    // parseTxError reads a message for the signs of an RPC failure, among
    // them "429" and "503". A failed transaction's error is the cluster's
    // answer and is displayed as it is.
    it.each([
      [6503, "0x1967"],
      [6429, "0x191d"],
    ])(
      "is displayed as it is by parseTxError for the code %i",
      async (code, hex) => {
        const { client, connection, tx } = createClient();
        jest.spyOn(connection, "confirmTransaction").mockResolvedValue({
          context: { slot: 1 },
          value: { err: { InstructionError: [2, { Custom: code }] } },
        });
        jest.spyOn(connection, "getTransaction").mockResolvedValue(null);

        const error = await client.sendAndConfirm(tx).catch((thrown) => thrown);

        const message = `Transaction failed at instruction 2: custom program error: ${hex} (${code}). ${UNAVAILABLE}`;
        expect(error).toBeInstanceOf(GlamError);
        expect(parseTxError(error)).toBe(message);
        // The same words from anything but a GlamError are still read as an
        // RPC's failure.
        expect(parseTxError(new Error(message))).toMatch(/^RPC /);
      },
    );
  });

  // On the polling path a status read that fails says nothing about the
  // transaction, which may have landed.
  describe("a status read that is rejected on the polling path", () => {
    const answered = (err: TransactionError | null) => ({
      context: { slot: 1 },
      value: {
        slot: 1,
        confirmations: 1,
        confirmationStatus: "confirmed" as const,
        err,
      },
    });

    function polling() {
      process.env.WEBSOCKET_DISABLED = "1";
      const made = createClient();
      jest.useFakeTimers();
      return made;
    }

    it("is followed by the next poll, which reports the transaction as sent", async () => {
      const { client, connection, tx } = polling();
      const status = jest
        .spyOn(connection, "getSignatureStatus")
        .mockRejectedValueOnce(new Error("503 Service Unavailable"))
        .mockResolvedValue(answered(null));

      const sent = client.sendAndConfirm(tx);
      await jest.advanceTimersByTimeAsync(1_000);

      expect(await sent).toBe(idOf(tx));
      expect(status).toHaveBeenCalledTimes(2);
    });

    it("is followed by the next poll, which reports the transaction's error", async () => {
      const { client, connection, tx } = polling();
      const rawError: TransactionError = {
        InstructionError: [0, { Custom: 6000 }],
      };
      const status = jest
        .spyOn(connection, "getSignatureStatus")
        .mockRejectedValueOnce(new Error("fetch failed"))
        .mockResolvedValue(answered(rawError));
      jest.spyOn(connection, "getTransaction").mockResolvedValue(null);

      const sent = client.sendAndConfirm(tx).catch((thrown) => thrown);
      await jest.advanceTimersByTimeAsync(1_000);

      expect(await sent).toMatchObject({ rawError, programLogs: [] });
      expect(status).toHaveBeenCalledTimes(2);
    });

    it("ends in the confirmation timeout when every poll is rejected, and the timeout carries the last rejection", async () => {
      const { client, connection, tx } = polling();
      const last = new Error("fetch failed for the last time");
      const status = jest
        .spyOn(connection, "getSignatureStatus")
        .mockImplementation(async () => {
          throw status.mock.calls.length < 60
            ? new Error("fetch failed")
            : last;
        });

      const sent = client.sendAndConfirm(tx).catch((thrown) => thrown);
      await jest.advanceTimersByTimeAsync(60_000);

      const error = await sent;
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe(
        "Transaction confirmation timeout after 60 seconds. The last status read that was rejected said: fetch failed for the last time",
      );
      expect(error.cause).toBe(last);
      expect(status).toHaveBeenCalledTimes(60);
    });

    it("names the last rejection in the timeout when later polls found no status", async () => {
      const { client, connection, tx } = polling();
      const rejection = { code: 503 };
      const status = jest
        .spyOn(connection, "getSignatureStatus")
        .mockRejectedValueOnce(rejection)
        .mockResolvedValue({ context: { slot: 1 }, value: null });

      const sent = client.sendAndConfirm(tx).catch((thrown) => thrown);
      await jest.advanceTimersByTimeAsync(60_000);

      const error = await sent;
      expect(error.message).toBe(
        "Transaction confirmation timeout after 60 seconds. The last status read that was rejected said: [object Object]",
      );
      expect(error.cause).toBe(rejection);
      expect(status).toHaveBeenCalledTimes(60);
    });

    // A transport can throw one object for every failure. The timeout keeps
    // the rejection as its cause, and a later send that throws the same
    // object writes its signature onto a new error, not onto that cause.
    it("keeps a later send's signature off the rejection a timeout carries as its cause", async () => {
      const { client, connection, tx } = polling();
      const transportError = new Error("fetch failed");
      jest
        .spyOn(connection, "getSignatureStatus")
        .mockRejectedValue(transportError);

      const sent = client.sendAndConfirm(tx).catch((thrown) => thrown);
      await jest.advanceTimersByTimeAsync(60_000);
      const timeout = await sent;
      expect(timeout.cause).toBe(transportError);

      const second = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: client.signer,
          toPubkey: Keypair.generate().publicKey,
          lamports: 2,
        }),
      );
      jest
        .spyOn(connection, "sendRawTransaction")
        .mockRejectedValue(transportError);
      const later = await client
        .sendAndConfirm(second)
        .catch((thrown) => thrown);

      expect(idOf(second)).not.toBe(idOf(tx));
      expect(later).not.toBe(transportError);
      expect(later.unacknowledgedSignature).toBe(idOf(second));
      expect(later.cause).toBe(transportError);
      expect(transportError).not.toHaveProperty("unacknowledgedSignature");
      expect(timeout.cause).toBe(transportError);
      expect(timeout).not.toHaveProperty("unacknowledgedSignature");
    });

    // The same holds while the poll is still running, before any timeout is
    // built, and for a send through another client.
    it("keeps a signature off a rejection the poll has recorded, when another send throws it before the timeout", async () => {
      const { client, connection, tx } = polling();
      const transportError = new Error("fetch failed");
      jest
        .spyOn(connection, "getSignatureStatus")
        .mockRejectedValue(transportError);

      const sent = client.sendAndConfirm(tx).catch((thrown) => thrown);
      await jest.advanceTimersByTimeAsync(1_000);

      const other = createClient();
      jest
        .spyOn(other.connection, "sendRawTransaction")
        .mockRejectedValue(transportError);
      const later = await other.client
        .sendAndConfirm(other.tx)
        .catch((thrown) => thrown);

      expect(later).not.toBe(transportError);
      expect(later.unacknowledgedSignature).toBe(idOf(other.tx));
      expect(later.cause).toBe(transportError);
      expect(transportError).not.toHaveProperty("unacknowledgedSignature");

      await jest.advanceTimersByTimeAsync(59_000);
      const timeout = await sent;
      expect(timeout.message).toBe(
        "Transaction confirmation timeout after 60 seconds. The last status read that was rejected said: fetch failed",
      );
      expect(timeout.cause).toBe(transportError);
      expect(timeout.cause).not.toHaveProperty("unacknowledgedSignature");
      expect(timeout).not.toHaveProperty("unacknowledgedSignature");
    });

    it("ends in the plain timeout when no poll was rejected", async () => {
      const { client, connection, tx } = polling();
      jest
        .spyOn(connection, "getSignatureStatus")
        .mockResolvedValue({ context: { slot: 1 }, value: null });

      const sent = client.sendAndConfirm(tx).catch((thrown) => thrown);
      await jest.advanceTimersByTimeAsync(60_000);

      const error = await sent;
      expect(error.message).toBe(
        "Transaction confirmation timeout after 60 seconds.",
      );
      expect(error.cause).toBeUndefined();
    });
  });

  // The polling wait ends at a deadline, 60 seconds after it starts. How long
  // a status read takes, and how often web3.js tries it again, does not
  // stretch the wait.
  describe("the polling path's deadline", () => {
    const TIMEOUT = "Transaction confirmation timeout after 60 seconds.";
    const answer = (confirmationStatus: "confirmed" | null) => ({
      context: { slot: 1 },
      value: confirmationStatus && {
        slot: 1,
        confirmations: 1,
        confirmationStatus,
        err: null,
      },
    });
    /** A promise that resolves with `value` after `ms` of the fake clock. */
    const after = <T>(ms: number, value: T) =>
      new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

    function polling(fetch?: FetchFn) {
      process.env.WEBSOCKET_DISABLED = "1";
      const made = createClient(undefined, fetch);
      jest.useFakeTimers();
      return made;
    }

    /**
     * Sends, and says whether the send has settled and with what. A test
     * reads the state after it moved the clock, and never waits on the send,
     * which would hang where the wait does not end.
     */
    function sending({ client, tx }: ReturnType<typeof polling>) {
      const state: { settled: boolean; outcome?: unknown } = { settled: false };
      void client.sendAndConfirm(tx).then(
        (id) => Object.assign(state, { settled: true, outcome: id }),
        (thrown) => Object.assign(state, { settled: true, outcome: thrown }),
      );
      return state;
    }

    // web3.js tries a request that is answered 429 five times, with pauses
    // of 500, 1,000, 2,000 and 4,000 ms, before the read is rejected. One
    // poll then lasts 7.5 seconds.
    it("times out 60 seconds in when every request is answered 429, after 36 requests", async () => {
      jest.spyOn(console, "error").mockImplementation(() => {});
      const fetch = jest.fn(
        async () =>
          new Response("rate limited", {
            status: 429,
            statusText: "Too Many Requests",
          }),
      );
      const made = polling(fetch as unknown as FetchFn);
      const state = sending(made);

      await jest.advanceTimersByTimeAsync(59_999);
      expect(state.settled).toBe(false);
      expect(fetch).toHaveBeenCalledTimes(36);

      await jest.advanceTimersByTimeAsync(1);
      expect(state.settled).toBe(true);
      const error = state.outcome as Error;
      expect(error).toBeInstanceOf(Error);
      expect(error.message.startsWith(`${TIMEOUT} `)).toBe(true);
      expect(error.message).toContain("429 Too Many Requests");

      // The read in flight at the deadline is left behind. web3.js goes on
      // with its retries, four more requests in the next 7.5 seconds, and no
      // poll follows. Its rejection is dropped: a rejection nothing handles
      // would fail this test.
      await jest.advanceTimersByTimeAsync(10_000);
      expect(fetch).toHaveBeenCalledTimes(40);
      await jest.advanceTimersByTimeAsync(60_000);
      expect(fetch).toHaveBeenCalledTimes(40);
    });

    it("times out 60 seconds in when each read takes 3 seconds to find no status, after 15 reads", async () => {
      const made = polling();
      const status = jest
        .spyOn(made.connection, "getSignatureStatus")
        .mockImplementation(() => after(3_000, answer(null)));
      const state = sending(made);

      await jest.advanceTimersByTimeAsync(59_999);
      expect(state.settled).toBe(false);

      await jest.advanceTimersByTimeAsync(1);
      expect(state.settled).toBe(true);
      expect(state.outcome).toMatchObject({ message: TIMEOUT });
      expect((state.outcome as Error).cause).toBeUndefined();
      expect(status).toHaveBeenCalledTimes(15);
    });

    it("times out 60 seconds in when a read never settles", async () => {
      const made = polling();
      const status = jest
        .spyOn(made.connection, "getSignatureStatus")
        .mockImplementation(() => new Promise(() => {}));
      const state = sending(made);

      await jest.advanceTimersByTimeAsync(59_999);
      expect(state.settled).toBe(false);

      await jest.advanceTimersByTimeAsync(1);
      expect(state.settled).toBe(true);
      expect(state.outcome).toMatchObject({ message: TIMEOUT });
      expect((state.outcome as Error).cause).toBeUndefined();
      expect(status).toHaveBeenCalledTimes(1);
    });

    it("returns an answer that arrives one millisecond before the deadline", async () => {
      const made = polling();
      jest
        .spyOn(made.connection, "getSignatureStatus")
        .mockImplementation(() => after(59_999, answer("confirmed")));
      const state = sending(made);

      await jest.advanceTimersByTimeAsync(59_998);
      expect(state.settled).toBe(false);

      await jest.advanceTimersByTimeAsync(1);
      expect(state.settled).toBe(true);
      expect(state.outcome).toBe(idOf(made.tx));
    });

    it("times out at the deadline when the read in flight would answer one millisecond after it", async () => {
      const made = polling();
      const status = jest
        .spyOn(made.connection, "getSignatureStatus")
        .mockImplementation(() => after(60_001, answer("confirmed")));
      const state = sending(made);

      await jest.advanceTimersByTimeAsync(60_000);
      expect(state.settled).toBe(true);
      expect(state.outcome).toMatchObject({ message: TIMEOUT });

      // The late answer changes nothing, and no poll follows it.
      await jest.advanceTimersByTimeAsync(10_000);
      expect(state.outcome).toMatchObject({ message: TIMEOUT });
      expect(status).toHaveBeenCalledTimes(1);
    });

    // A busy event loop can run the deadline's timer late. The clock decides
    // what is too late, not the timer.
    it.each<
      [
        string,
        (read: {
          resolve(value: unknown): void;
          reject(reason: unknown): void;
        }) => void,
      ]
    >([
      [
        "an answer that the transaction is confirmed",
        (read) => read.resolve(answer("confirmed")),
      ],
      ["a rejection", (read) => read.reject(new Error("fetch failed"))],
    ])(
      "drops %s that is handled after the deadline while the deadline's timer has not fired",
      async (_what, settle) => {
        const made = polling();
        let now = 0;
        const clock = jest
          .spyOn(performance, "now")
          .mockImplementation(() => now);
        try {
          let read!: Parameters<typeof settle>[0];
          const status = jest
            .spyOn(made.connection, "getSignatureStatus")
            .mockImplementation(
              () =>
                new Promise((resolve, reject) => {
                  read = { resolve, reject };
                }) as never,
            );
          const state = sending(made);
          await jest.advanceTimersByTimeAsync(0);
          expect(status).toHaveBeenCalledTimes(1);
          expect(state.settled).toBe(false);

          // The clock passes the deadline and no timer runs.
          now = 75_000;
          settle(read);
          await jest.advanceTimersByTimeAsync(0);

          expect(state.settled).toBe(true);
          expect(state.outcome).toMatchObject({ message: TIMEOUT });
          expect((state.outcome as Error).cause).toBeUndefined();
          expect(status).toHaveBeenCalledTimes(1);
          expect(jest.getTimerCount()).toBe(0);
        } finally {
          clock.mockRestore();
        }
      },
    );

    it("leaves no timer behind when a poll confirms the transaction", async () => {
      const made = polling();
      jest
        .spyOn(made.connection, "getSignatureStatus")
        .mockResolvedValueOnce(answer(null))
        .mockResolvedValue(answer("confirmed"));
      const state = sending(made);

      await jest.advanceTimersByTimeAsync(1_000);
      expect(state.settled).toBe(true);
      expect(state.outcome).toBe(idOf(made.tx));
      expect(jest.getTimerCount()).toBe(0);
    });

    it("shortens the last pause to what is left before the deadline", async () => {
      const made = polling();
      const status = jest
        .spyOn(made.connection, "getSignatureStatus")
        .mockImplementation(() => after(59_500, answer(null)));
      const state = sending(made);

      await jest.advanceTimersByTimeAsync(59_999);
      expect(state.settled).toBe(false);

      await jest.advanceTimersByTimeAsync(1);
      expect(state.settled).toBe(true);
      expect(state.outcome).toMatchObject({ message: TIMEOUT });
      expect(status).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
    });

    // The deadline is 60 seconds of elapsed time. A step of the system clock,
    // which a time sync or a person can make, neither ends the wait early nor
    // stretches it.
    it.each([
      ["forward by 120 seconds", 120_000],
      ["backward by 30 seconds", -30_000],
    ])(
      "times out 60 seconds in when the system clock steps %s, after 60 reads",
      async (_step, stepMs) => {
        const made = polling();
        const status = jest
          .spyOn(made.connection, "getSignatureStatus")
          .mockResolvedValue(answer(null));
        const state = sending(made);

        await jest.advanceTimersByTimeAsync(1_000);
        jest.setSystemTime(Date.now() + stepMs);

        await jest.advanceTimersByTimeAsync(58_999);
        expect(state.settled).toBe(false);

        await jest.advanceTimersByTimeAsync(1);
        expect(state.settled).toBe(true);
        expect(state.outcome).toMatchObject({ message: TIMEOUT });
        // As many reads as with a steady clock, one a second from the start.
        expect(status).toHaveBeenCalledTimes(60);
      },
    );
  });
});
