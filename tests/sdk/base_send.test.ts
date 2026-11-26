import { utils, type Wallet } from "@coral-xyz/anchor";
import {
  Keypair,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { BaseClient } from "../../src/client/base";
import { ClusterNetwork } from "../../src/clientConfig";

describe("BaseClient.sendAndConfirm", () => {
  function createClient(wallet: Wallet, blockhash: string) {
    const connection = {
      commitment: "confirmed",
      rpcEndpoint: "http://localhost:8899",
      // The RPC answers with the transaction's own id, its first signature.
      sendRawTransaction: jest.fn(async (raw: Uint8Array) => {
        try {
          return utils.bytes.bs58.encode(
            VersionedTransaction.deserialize(raw).signatures[0],
          );
        } catch {
          return "txsig";
        }
      }),
      getTransaction: jest.fn(),
    };

    const client = Object.create(BaseClient.prototype) as BaseClient;
    Object.assign(client, {
      cluster: ClusterNetwork.Devnet,
      provider: {
        connection,
        publicKey: wallet.publicKey,
        wallet,
      },
      blockhashWithCache: {
        get: jest.fn(async () => ({
          blockhash,
          lastValidBlockHeight: 1,
        })),
      },
      onSentListeners: new Set(),
      staging: false,
    });
    (client as any).confirmTransaction = jest.fn(async () => ({
      value: { err: null },
    }));

    return { client, connection };
  }

  it("signs legacy transactions through the wallet without reading payer", async () => {
    const walletKeypair = Keypair.generate();
    const to = Keypair.generate().publicKey;
    const blockhash = Keypair.generate().publicKey.toBase58();

    const wallet = {
      get payer() {
        throw new Error("payer should not be accessed");
      },
      publicKey: walletKeypair.publicKey,
      signTransaction: jest.fn(async (tx: Transaction) => {
        tx.partialSign(walletKeypair);
        return tx;
      }),
      signAllTransactions: jest.fn(),
    } as unknown as Wallet;

    const { client, connection } = createClient(wallet, blockhash);

    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: walletKeypair.publicKey,
        toPubkey: to,
        lamports: 1,
      }),
    );

    const sig = await client.sendAndConfirm(tx);

    expect(sig).toBe(utils.bytes.bs58.encode(tx.signature!));
    expect(tx.feePayer?.equals(walletKeypair.publicKey)).toBe(true);
    expect(tx.recentBlockhash).toBe(blockhash);
    expect(wallet.signTransaction).toHaveBeenCalledWith(tx);
    expect(connection.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it("does not re-sign legacy transactions after wallet signing when extra signers are present", async () => {
    const walletKeypair = Keypair.generate();
    const extraSigner = Keypair.generate();
    const to = Keypair.generate().publicKey;
    const blockhash = Keypair.generate().publicKey.toBase58();

    const wallet = {
      publicKey: walletKeypair.publicKey,
      signTransaction: jest.fn(async (tx: Transaction) => {
        tx.partialSign(walletKeypair);
        return tx;
      }),
      signAllTransactions: jest.fn(),
    } as unknown as Wallet;

    const { client, connection } = createClient(wallet, blockhash);

    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: extraSigner.publicKey,
        toPubkey: to,
        lamports: 1,
      }),
    );
    const signSpy = jest.spyOn(tx, "sign");

    const sig = await client.sendAndConfirm(tx, [extraSigner]);

    expect(sig).toBe(utils.bytes.bs58.encode(tx.signature!));
    expect(signSpy).not.toHaveBeenCalled();
    expect(connection.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it("signs versioned transactions with extra signers after wallet signing", async () => {
    const walletKeypair = Keypair.generate();
    const extraSigner = Keypair.generate();
    const to = Keypair.generate().publicKey;
    const blockhash = Keypair.generate().publicKey.toBase58();

    const wallet = {
      publicKey: walletKeypair.publicKey,
      signTransaction: jest.fn(async (tx: VersionedTransaction) => {
        tx.sign([walletKeypair]);
        return tx;
      }),
      signAllTransactions: jest.fn(),
    } as unknown as Wallet;

    const { client, connection } = createClient(wallet, blockhash);

    const tx = new VersionedTransaction(
      new TransactionMessage({
        payerKey: walletKeypair.publicKey,
        recentBlockhash: blockhash,
        instructions: [
          SystemProgram.transfer({
            fromPubkey: extraSigner.publicKey,
            toPubkey: to,
            lamports: 1,
          }),
        ],
      }).compileToV0Message(),
    );
    const signSpy = jest.spyOn(tx, "sign");

    const sig = await client.sendAndConfirm(tx, [extraSigner]);

    expect(sig).toBe(utils.bytes.bs58.encode(tx.signatures[0]));
    expect(signSpy).toHaveBeenCalledWith([walletKeypair]);
    expect(signSpy).toHaveBeenCalledWith([extraSigner]);
    expect(connection.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it("signs structurally versioned transactions from another web3.js instance", async () => {
    const walletKeypair = Keypair.generate();
    const extraSigner = Keypair.generate();
    const blockhash = Keypair.generate().publicKey.toBase58();
    const signedTx = {
      sign: jest.fn(),
      serialize: jest.fn(() => new Uint8Array()),
    } as unknown as VersionedTransaction;

    const wallet = {
      publicKey: walletKeypair.publicKey,
      signTransaction: jest.fn(async () => signedTx),
      signAllTransactions: jest.fn(),
    } as unknown as Wallet;

    const { client, connection } = createClient(wallet, blockhash);
    const tx = {
      serialize: jest.fn(() => new Uint8Array()),
    } as unknown as VersionedTransaction;

    await expect(client.sendAndConfirm(tx, [extraSigner])).resolves.toBe(
      "txsig",
    );

    expect(signedTx.sign).toHaveBeenCalledWith([extraSigner]);
    expect(connection.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  // The RPC can take a transaction and lose its answer, and the listeners
  // heard a signature only from the answer, so nothing named the id to check
  // before a retry, of a burn say. An answer naming another transaction was
  // confirmed in its place.
  describe("an answer the RPC lost or gave for another transaction", () => {
    const walletKeypair = Keypair.generate();
    const blockhash = Keypair.generate().publicKey.toBase58();
    const transfer = () =>
      SystemProgram.transfer({
        fromPubkey: walletKeypair.publicKey,
        toPubkey: Keypair.generate().publicKey,
        lamports: 1,
      });
    const versioned = () =>
      new VersionedTransaction(
        new TransactionMessage({
          payerKey: walletKeypair.publicKey,
          recentBlockhash: blockhash,
          instructions: [transfer()],
        }).compileToV0Message(),
      );

    function listening() {
      const wallet = {
        publicKey: walletKeypair.publicKey,
        signTransaction: jest.fn(
          async (tx: VersionedTransaction | Transaction) => {
            if (tx instanceof Transaction) {
              tx.partialSign(walletKeypair);
            } else {
              tx.sign([walletKeypair]);
            }
            return tx;
          },
        ),
        signAllTransactions: jest.fn(),
      } as unknown as Wallet;
      const { client, connection } = createClient(wallet, blockhash);
      const heard: string[] = [];
      client.onSentListeners.add((sig) => heard.push(sig));
      return { client, connection, heard };
    }
    // A wallet that hands back the signed bytes without the signatures, so
    // the id the send signed cannot be read.
    function hidingSignatures() {
      const wallet = {
        publicKey: walletKeypair.publicKey,
        signTransaction: jest.fn(async (tx: VersionedTransaction) => {
          tx.sign([walletKeypair]);
          const bytes = tx.serialize();
          return { serialize: () => bytes };
        }),
        signAllTransactions: jest.fn(),
      } as unknown as Wallet;
      return createClient(wallet, blockhash);
    }
    const idOf = (tx: VersionedTransaction | Transaction) =>
      utils.bytes.bs58.encode(
        tx instanceof Transaction ? tx.signature! : tx.signatures[0],
      );

    it.each([
      ["versioned", versioned],
      ["legacy", () => new Transaction().add(transfer())],
    ])(
      "a %s send that throws carries the id it signed, and no listener hears it",
      async (_name, build) => {
        const { client, connection, heard } = listening();
        connection.sendRawTransaction.mockRejectedValueOnce(
          new Error("socket hang up"),
        );
        const tx = build();

        const error = await client.sendAndConfirm(tx).catch((e) => e);

        expect(error.message).toBe("socket hang up");
        expect(error.unacknowledgedSignature).toBe(idOf(tx));
        expect(heard).toEqual([]);
      },
    );

    it("wraps a send that throws what is not an Error", async () => {
      const { client, connection } = listening();
      connection.sendRawTransaction.mockRejectedValueOnce("socket hang up");
      const tx = versioned();

      const error = await client.sendAndConfirm(tx).catch((e) => e);

      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe("socket hang up");
      expect(error.unacknowledgedSignature).toBe(idOf(tx));
      expect(error.cause).toBe("socket hang up");
    });

    it("rethrows the RPC's own Error when it can take the id", async () => {
      const { client, connection } = listening();
      const rpcError = new Error("socket hang up");
      connection.sendRawTransaction.mockRejectedValueOnce(rpcError);
      const tx = versioned();

      const error = await client.sendAndConfirm(tx).catch((e) => e);

      expect(error).toBe(rpcError);
      expect(error.unacknowledgedSignature).toBe(idOf(tx));
    });

    it("carries the id on a new Error when the RPC's Error is frozen", async () => {
      const { client, connection } = listening();
      const frozen = Object.freeze(new Error("socket hang up"));
      connection.sendRawTransaction.mockRejectedValueOnce(frozen);
      const tx = versioned();

      const error = await client.sendAndConfirm(tx).catch((e) => e);

      expect(error).not.toBe(frozen);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe("socket hang up");
      expect(error.unacknowledgedSignature).toBe(idOf(tx));
      expect(error.cause).toBe(frozen);
    });

    it("carries each id when the RPC throws one Error for two sends", async () => {
      const { client, connection } = listening();
      const reused = new Error("rate limited");
      connection.sendRawTransaction.mockRejectedValue(reused);
      const first = versioned();
      const second = versioned();

      const one = await client.sendAndConfirm(first).catch((e) => e);
      const two = await client.sendAndConfirm(second).catch((e) => e);

      expect(idOf(first)).not.toBe(idOf(second));
      expect(one).toBe(reused);
      expect(one.unacknowledgedSignature).toBe(idOf(first));
      expect(two).not.toBe(reused);
      expect(two).toBeInstanceOf(Error);
      expect(two.message).toBe("rate limited");
      expect(two.unacknowledgedSignature).toBe(idOf(second));
      expect(two.cause).toBe(reused);
      expect((reused as any).unacknowledgedSignature).toBe(idOf(first));
    });

    it("carries each id when the RPC throws one Error for two sends in flight at once", async () => {
      const { client, connection } = listening();
      const reused = new Error("rate limited");
      connection.sendRawTransaction.mockRejectedValue(reused);
      const first = versioned();
      const second = versioned();

      const [one, two] = await Promise.all([
        client.sendAndConfirm(first).catch((e) => e),
        client.sendAndConfirm(second).catch((e) => e),
      ]);

      expect(idOf(first)).not.toBe(idOf(second));
      expect(one.unacknowledgedSignature).toBe(idOf(first));
      expect(two.unacknowledgedSignature).toBe(idOf(second));
      expect([one, two]).toContain(reused);
    });

    it("carries each id when the RPC throws one Error that already has the property for two sends in flight at once", async () => {
      const { client, connection } = listening();
      const reused = new Error("rate limited");
      // A property of the same name that other code set.
      (reused as any).unacknowledgedSignature = "set elsewhere";
      connection.sendRawTransaction.mockRejectedValue(reused);
      const first = versioned();
      const second = versioned();

      const [one, two] = await Promise.all([
        client.sendAndConfirm(first).catch((e) => e),
        client.sendAndConfirm(second).catch((e) => e),
      ]);

      expect(one.unacknowledgedSignature).toBe(idOf(first));
      expect(two.unacknowledgedSignature).toBe(idOf(second));
      expect([one, two]).toContain(reused);
    });

    it("carries the id on a new Error when the RPC throws one Error for two sends of the same transaction", async () => {
      const { client, connection } = listening();
      const rpcError = new Error("rate limited");
      connection.sendRawTransaction.mockRejectedValue(rpcError);
      const tx = versioned();

      const one = await client.sendAndConfirm(tx).catch((e) => e);
      const two = await client.sendAndConfirm(tx).catch((e) => e);

      expect(one).toBe(rpcError);
      expect(one.unacknowledgedSignature).toBe(idOf(tx));
      expect(two).not.toBe(rpcError);
      expect(two).toBeInstanceOf(Error);
      expect(two.message).toBe("rate limited");
      expect(two.unacknowledgedSignature).toBe(idOf(tx));
      expect(two.cause).toBe(rpcError);
    });

    it("leaves an Error it threw after the acknowledgement as it was when the RPC refuses a later send with it", async () => {
      const { client, connection } = listening();
      const reused = new Error("rate limited");
      (client as any).confirmTransaction.mockRejectedValueOnce(reused);
      const one = await client.sendAndConfirm(versioned()).catch((e) => e);
      expect(one).toBe(reused);
      expect(
        Object.prototype.hasOwnProperty.call(one, "unacknowledgedSignature"),
      ).toBe(false);

      connection.sendRawTransaction.mockRejectedValueOnce(reused);
      const second = versioned();
      const two = await client.sendAndConfirm(second).catch((e) => e);

      expect(two).not.toBe(reused);
      expect(two).toBeInstanceOf(Error);
      expect(two.message).toBe("rate limited");
      expect(two.unacknowledgedSignature).toBe(idOf(second));
      expect(two.cause).toBe(reused);
      expect(
        Object.prototype.hasOwnProperty.call(one, "unacknowledgedSignature"),
      ).toBe(false);
    });

    it("leaves an Error it threw when the id could not be read as it was when the RPC refuses a later send with it", async () => {
      const hiding = hidingSignatures();
      const reused = new Error("rate limited");
      hiding.connection.sendRawTransaction.mockRejectedValueOnce(reused);
      const one = await hiding.client
        .sendAndConfirm(versioned())
        .catch((e) => e);
      expect(one).toBe(reused);
      expect(
        Object.prototype.hasOwnProperty.call(one, "unacknowledgedSignature"),
      ).toBe(false);

      const { client, connection } = listening();
      connection.sendRawTransaction.mockRejectedValueOnce(reused);
      const second = versioned();
      const two = await client.sendAndConfirm(second).catch((e) => e);

      expect(two).not.toBe(reused);
      expect(two).toBeInstanceOf(Error);
      expect(two.message).toBe("rate limited");
      expect(two.unacknowledgedSignature).toBe(idOf(second));
      expect(two.cause).toBe(reused);
      expect(
        Object.prototype.hasOwnProperty.call(one, "unacknowledgedSignature"),
      ).toBe(false);
    });

    it("leaves a function it threw after the acknowledgement as it was when the RPC refuses a later send with it", async () => {
      const { client, connection } = listening();
      const thrown = Object.setPrototypeOf(
        function rejection() {},
        Error.prototype,
      ) as Error;
      thrown.message = "rate limited";
      (client as any).confirmTransaction.mockRejectedValueOnce(thrown);
      const one = await client.sendAndConfirm(versioned()).catch((e) => e);
      expect(one).toBe(thrown);
      expect(
        Object.prototype.hasOwnProperty.call(one, "unacknowledgedSignature"),
      ).toBe(false);

      connection.sendRawTransaction.mockRejectedValueOnce(thrown);
      const second = versioned();
      const two = await client.sendAndConfirm(second).catch((e) => e);

      expect(two).not.toBe(thrown);
      expect(two).toBeInstanceOf(Error);
      expect(two.message).toBe("rate limited");
      expect(two.unacknowledgedSignature).toBe(idOf(second));
      expect(two.cause).toBe(thrown);
      expect(
        Object.prototype.hasOwnProperty.call(one, "unacknowledgedSignature"),
      ).toBe(false);
    });

    it("leaves the cause of a new Error it threw as it was when the RPC refuses a later send with it", async () => {
      const { client, connection } = listening();
      const reused = new Error("rate limited");
      // A property of the same name that other code set.
      (reused as any).unacknowledgedSignature = "set elsewhere";
      (client as any).confirmTransaction.mockRejectedValueOnce(reused);
      const one = await client.sendAndConfirm(versioned()).catch((e) => e);
      expect(one).not.toBe(reused);
      expect(one.cause).toBe(reused);
      expect(
        Object.prototype.hasOwnProperty.call(one, "unacknowledgedSignature"),
      ).toBe(false);

      connection.sendRawTransaction.mockRejectedValueOnce(reused);
      const second = versioned();
      const two = await client.sendAndConfirm(second).catch((e) => e);

      expect(two).not.toBe(reused);
      expect(two).toBeInstanceOf(Error);
      expect(two.message).toBe("rate limited");
      expect(two.unacknowledgedSignature).toBe(idOf(second));
      expect(two.cause).toBe(reused);
      expect((reused as any).unacknowledgedSignature).toBe("set elsewhere");
    });

    it("leaves a new Error it threw as it was when the RPC refuses a later send with it", async () => {
      const { client, connection } = listening();
      const reused = new Error("rate limited");
      // A property of the same name that other code set.
      (reused as any).unacknowledgedSignature = "set elsewhere";
      (client as any).confirmTransaction.mockRejectedValueOnce(reused);
      const one = await client.sendAndConfirm(versioned()).catch((e) => e);
      expect(one).not.toBe(reused);
      expect(
        Object.prototype.hasOwnProperty.call(one, "unacknowledgedSignature"),
      ).toBe(false);

      connection.sendRawTransaction.mockRejectedValueOnce(one);
      const second = versioned();
      const two = await client.sendAndConfirm(second).catch((e) => e);

      expect(two).not.toBe(one);
      expect(two).toBeInstanceOf(Error);
      expect(two.message).toBe("rate limited");
      expect(two.unacknowledgedSignature).toBe(idOf(second));
      expect(two.cause).toBe(one);
      expect(
        Object.prototype.hasOwnProperty.call(one, "unacknowledgedSignature"),
      ).toBe(false);
    });

    it("leaves an Error that refused the id once as it was when the RPC refuses a later send with it", async () => {
      const { client, connection } = listening();
      const original = new Error("rate limited");
      // Refuses the first property defined on it and takes the next.
      let refuse = true;
      const reused = new Proxy(original, {
        defineProperty: (target, key, descriptor) => {
          if (refuse) {
            refuse = false;
            return false;
          }
          return Reflect.defineProperty(target, key, descriptor);
        },
      });
      connection.sendRawTransaction.mockRejectedValueOnce(reused);
      const first = versioned();
      const one = await client.sendAndConfirm(first).catch((e) => e);
      expect(one).not.toBe(reused);
      expect(one.unacknowledgedSignature).toBe(idOf(first));
      expect(one.cause).toBe(reused);

      connection.sendRawTransaction.mockRejectedValueOnce(reused);
      const second = versioned();
      const two = await client.sendAndConfirm(second).catch((e) => e);

      expect(two).not.toBe(reused);
      expect(two).toBeInstanceOf(Error);
      expect(two.message).toBe("rate limited");
      expect(two.unacknowledgedSignature).toBe(idOf(second));
      expect(two.cause).toBe(reused);
      expect(
        Object.prototype.hasOwnProperty.call(
          original,
          "unacknowledgedSignature",
        ),
      ).toBe(false);
    });

    it("throws a new Error without an earlier send's id for a reused Error when the next send's id cannot be read", async () => {
      const { client, connection } = listening();
      const reused = new Error("rate limited");
      connection.sendRawTransaction.mockRejectedValue(reused);
      const first = versioned();
      const one = await client.sendAndConfirm(first).catch((e) => e);
      expect(one).toBe(reused);
      expect(one.unacknowledgedSignature).toBe(idOf(first));

      const other = hidingSignatures();
      other.connection.sendRawTransaction.mockRejectedValue(reused);

      const two = await other.client
        .sendAndConfirm(versioned())
        .catch((e) => e);

      expect(two).not.toBe(reused);
      expect(two).toBeInstanceOf(Error);
      expect(two.message).toBe("rate limited");
      expect(two.cause).toBe(reused);
      expect(
        Object.prototype.hasOwnProperty.call(two, "unacknowledgedSignature"),
      ).toBe(false);
      expect((reused as any).unacknowledgedSignature).toBe(idOf(first));
    });

    it("throws a new Error without an earlier send's id for a reused Error that the confirmation throws", async () => {
      const { client, connection } = listening();
      const reused = new Error("rate limited");
      connection.sendRawTransaction.mockRejectedValueOnce(reused);
      const first = versioned();
      const one = await client.sendAndConfirm(first).catch((e) => e);
      expect(one).toBe(reused);
      expect(one.unacknowledgedSignature).toBe(idOf(first));

      // The RPC acknowledges the second send with its own id, and the
      // confirmation then throws the same Error.
      (client as any).confirmTransaction.mockRejectedValueOnce(reused);
      const second = versioned();
      const two = await client.sendAndConfirm(second).catch((e) => e);

      expect(connection.sendRawTransaction).toHaveBeenCalledTimes(2);
      expect(two).not.toBe(reused);
      expect(two).toBeInstanceOf(Error);
      expect(two.message).toBe("rate limited");
      expect(two.cause).toBe(reused);
      expect(
        Object.prototype.hasOwnProperty.call(two, "unacknowledgedSignature"),
      ).toBe(false);
      expect((reused as any).unacknowledgedSignature).toBe(idOf(first));
    });

    it("throws a new Error without the id for a reused Error that the confirmation of an acknowledged resend throws", async () => {
      const { client, connection, heard } = listening();
      const reused = new Error("rate limited");
      connection.sendRawTransaction.mockRejectedValueOnce(reused);
      const tx = versioned();
      const one = await client.sendAndConfirm(tx).catch((e) => e);
      const a = idOf(tx);
      expect(one).toBe(reused);
      expect(one.unacknowledgedSignature).toBe(a);

      // The RPC acknowledges the resend of the same signed transaction with
      // its id, and the confirmation then throws the same Error.
      (client as any).confirmTransaction.mockRejectedValueOnce(reused);
      const two = await client.sendAndConfirm(tx).catch((e) => e);

      expect(connection.sendRawTransaction).toHaveBeenCalledTimes(2);
      expect(idOf(tx)).toBe(a);
      expect(heard).toEqual([a]);
      expect(two).not.toBe(reused);
      expect(two).toBeInstanceOf(Error);
      expect(two.message).toBe("rate limited");
      expect(two.cause).toBe(reused);
      expect(
        Object.prototype.hasOwnProperty.call(two, "unacknowledgedSignature"),
      ).toBe(false);
      expect((reused as any).unacknowledgedSignature).toBe(a);
    });

    it("throws a new Error without the id for a reused Error that the wallet throws before a resend is sent", async () => {
      const { client, connection } = listening();
      const reused = new Error("rate limited");
      connection.sendRawTransaction.mockRejectedValueOnce(reused);
      const first = versioned();
      const one = await client.sendAndConfirm(first).catch((e) => e);
      expect(one).toBe(reused);
      expect(one.unacknowledgedSignature).toBe(idOf(first));

      // A resend of the signed transaction, whose wallet now throws the same
      // Error before anything is sent.
      (client.wallet.signTransaction as jest.Mock).mockRejectedValueOnce(
        reused,
      );
      const two = await client.sendAndConfirm(first).catch((e) => e);

      expect(connection.sendRawTransaction).toHaveBeenCalledTimes(1);
      expect(two).not.toBe(reused);
      expect(two).toBeInstanceOf(Error);
      expect(two.message).toBe("rate limited");
      expect(two.cause).toBe(reused);
      expect(
        Object.prototype.hasOwnProperty.call(two, "unacknowledgedSignature"),
      ).toBe(false);
      expect((reused as any).unacknowledgedSignature).toBe(idOf(first));
    });

    it("throws a new Error without an earlier send's id for a thrown function that the confirmation throws", async () => {
      const { client, connection } = listening();
      const thrown = Object.setPrototypeOf(
        function rejection() {},
        Error.prototype,
      ) as Error;
      thrown.message = "rate limited";
      connection.sendRawTransaction.mockRejectedValueOnce(thrown);
      const first = versioned();
      const one = await client.sendAndConfirm(first).catch((e) => e);
      expect(one).toBe(thrown);
      expect((thrown as any).unacknowledgedSignature).toBe(idOf(first));

      // The RPC acknowledges the second send, and the confirmation then
      // throws the same function.
      (client as any).confirmTransaction.mockRejectedValueOnce(thrown);
      const two = await client.sendAndConfirm(versioned()).catch((e) => e);

      expect(connection.sendRawTransaction).toHaveBeenCalledTimes(2);
      expect(two).not.toBe(thrown);
      expect(two).toBeInstanceOf(Error);
      expect(two.message).toBe("rate limited");
      expect(two.cause).toBe(thrown);
      expect(
        Object.prototype.hasOwnProperty.call(two, "unacknowledgedSignature"),
      ).toBe(false);
    });

    it("takes the message of a thrown object that is not an Error", async () => {
      const { client, connection } = listening();
      const rejection = { message: "rate limited", code: 429 };
      connection.sendRawTransaction.mockRejectedValueOnce(rejection);
      const tx = versioned();

      const error = await client.sendAndConfirm(tx).catch((e) => e);

      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe("rate limited");
      expect(error.unacknowledgedSignature).toBe(idOf(tx));
      expect(error.cause).toBe(rejection);
    });

    it("carries the id when String() throws for the thrown value", async () => {
      const { client, connection } = listening();
      const rejection = Object.assign(Object.create(null), { code: 429 });
      expect(() => String(rejection)).toThrow(TypeError);
      connection.sendRawTransaction.mockRejectedValueOnce(rejection);
      const tx = versioned();

      const error = await client.sendAndConfirm(tx).catch((e) => e);

      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe("[object Object]");
      expect(error.unacknowledgedSignature).toBe(idOf(tx));
      expect(error.cause).toBe(rejection);
    });

    it("carries the id on a new Error when the thrown value is a revoked proxy", async () => {
      const { client, connection } = listening();
      const { proxy, revoke } = Proxy.revocable(new Error("rate limited"), {});
      revoke();
      expect(() => proxy instanceof Error).toThrow(TypeError);
      connection.sendRawTransaction.mockRejectedValueOnce(proxy);
      const tx = versioned();

      const error = await client.sendAndConfirm(tx).catch((e) => e);

      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe(
        "An error with no readable message; the original is the cause",
      );
      expect(error.unacknowledgedSignature).toBe(idOf(tx));
      expect(error.cause).toBe(proxy);
    });

    it("carries the id on a new Error when the thrown value does not read it back", async () => {
      const { client, connection } = listening();
      const proxy = new Proxy(new Error("rate limited"), {
        get: (target, key, receiver) =>
          key === "unacknowledgedSignature"
            ? undefined
            : Reflect.get(target, key, receiver),
      });
      connection.sendRawTransaction.mockRejectedValueOnce(proxy);
      const tx = versioned();

      const error = await client.sendAndConfirm(tx).catch((e) => e);

      expect(error).not.toBe(proxy);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe("rate limited");
      expect(error.unacknowledgedSignature).toBe(idOf(tx));
      expect(error.cause).toBe(proxy);
    });

    it("rethrows a frozen Error as it is when the id it signed cannot be read", async () => {
      const { client, connection } = hidingSignatures();
      const frozen = Object.freeze(new Error("socket hang up"));
      connection.sendRawTransaction.mockRejectedValueOnce(frozen);

      const error = await client.sendAndConfirm(versioned()).catch((e) => e);

      expect(error).toBe(frozen);
      expect(
        Object.prototype.hasOwnProperty.call(error, "unacknowledgedSignature"),
      ).toBe(false);
    });

    it("rethrows a thrown string as it is when the id it signed cannot be read", async () => {
      const { client, connection } = hidingSignatures();
      connection.sendRawTransaction.mockRejectedValueOnce("socket hang up");

      const error = await client.sendAndConfirm(versioned()).catch((e) => e);

      expect(error).toBe("socket hang up");
    });

    it("rethrows null as it is when the id it signed cannot be read", async () => {
      const { client, connection } = hidingSignatures();
      connection.sendRawTransaction.mockRejectedValueOnce(null);

      const error = await client.sendAndConfirm(versioned()).then(
        () => "resolved",
        (e) => e,
      );

      expect(error).toBeNull();
    });

    it("throws a new Error for a revoked proxy when the id it signed cannot be read", async () => {
      const { client, connection } = hidingSignatures();
      const { proxy, revoke } = Proxy.revocable(new Error("rate limited"), {});
      revoke();
      connection.sendRawTransaction.mockRejectedValueOnce(proxy);

      const error = await client.sendAndConfirm(versioned()).catch((e) => e);

      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe(
        "An error with no readable message; the original is the cause",
      );
      expect(error.cause).toBe(proxy);
      expect(Object.keys(error)).toEqual([]);
      expect(
        Object.prototype.hasOwnProperty.call(error, "unacknowledgedSignature"),
      ).toBe(false);
    });

    it("throws a new Error when the confirmation throws an Error whose id cannot be read", async () => {
      const { client, heard } = listening();
      const unreadable = Object.defineProperty(
        new Error("rate limited"),
        "unacknowledgedSignature",
        {
          get() {
            throw new TypeError("unreadable");
          },
        },
      );
      (client as any).confirmTransaction.mockRejectedValueOnce(unreadable);
      const tx = versioned();

      const error = await client.sendAndConfirm(tx).catch((e) => e);

      expect(heard).toEqual([idOf(tx)]);
      expect(error).not.toBe(unreadable);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe("rate limited");
      expect(error.cause).toBe(unreadable);
      expect(Object.keys(error)).toEqual([]);
      expect(
        Object.prototype.hasOwnProperty.call(error, "unacknowledgedSignature"),
      ).toBe(false);
    });

    it("refuses an answer that names another transaction, and confirms nothing", async () => {
      const { client, connection, heard } = listening();
      connection.sendRawTransaction.mockResolvedValueOnce("another");
      const tx = versioned();

      const error = await client.sendAndConfirm(tx).catch((e) => e);

      expect(error.message).toBe(
        `The RPC answered the send of ${idOf(tx)} with the signature another, of another transaction`,
      );
      expect(error.unacknowledgedSignature).toBe(idOf(tx));
      expect(heard).toEqual([]);
      expect((client as any).confirmTransaction).not.toHaveBeenCalled();
    });

    it("tells the listeners the id once the RPC acknowledges it", async () => {
      const { client, heard } = listening();
      const tx = versioned();

      const sig = await client.sendAndConfirm(tx);

      expect(sig).toBe(idOf(tx));
      expect(heard).toEqual([sig]);
    });
  });
});
