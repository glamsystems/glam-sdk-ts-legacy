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
