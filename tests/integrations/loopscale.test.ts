import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

import {
  GlamClient,
  LOOPSCALE_BORROW_PROTOCOL,
  LoopscaleBorrowMarketPolicy,
  LoopscaleBorrowPolicy,
  USDC,
  USDT,
  getLoopscaleEventAuthorityPda,
  getLoopscaleLoanPda,
  LOOPSCALE_PROGRAM_ID,
  nameToChars,
} from "../../src";
import {
  createGlamStateForTest,
  defaultInitStateParams,
} from "../glam_protocol/setup";

const LOOPSCALE_MARKET_INFORMATION = new PublicKey(
  "Go6kfCbT9f1R1MFSfbh9uYviWE4TAG9MFrTWot8s7rCB",
);

describe("loopscale sdk", () => {
  const glamClient = new GlamClient();
  const fixtureNonce = new BN("1776462797");

  beforeAll(async () => {
    await createGlamStateForTest(glamClient, {
      ...defaultInitStateParams,
      name: nameToChars(`Loopscale SDK ${Date.now()}`),
      baseAssetMint: USDC,
      assets: [USDC, USDT],
      integrationAcls: [
        {
          integrationProgram: glamClient.extLoopscaleProgram.programId,
          protocolsBitmask: LOOPSCALE_BORROW_PROTOCOL,
          protocolPolicies: [],
        },
      ],
    });

    // The policy setter is the one ext_loopscale instruction this suite sends.
    // Every instruction that invokes the Loopscale program needs Loopscale's
    // bs_auth co-signature, which only its remote service provides.
    await glamClient.loopscaleBorrow.setPolicy(
      new LoopscaleBorrowPolicy(
        [USDT],
        [USDC],
        [
          new LoopscaleBorrowMarketPolicy(
            LOOPSCALE_MARKET_INFORMATION,
            new BN(1_000_000_000), // maxBorrowAmount
            new BN(1_000_000_000), // maxTotalBorrowAmount
            10_000, // maxLtvBps (100%)
            [0], // duration index 0 = 1 day
          ),
        ],
      ),
    );
  }, 45_000);

  it("derives the fixture loan PDA from borrower and nonce", () => {
    const borrower = new PublicKey(
      "gLJHKPrZLGBiBZ33hFgZh6YnsEhTVxuRT17UCqNp6ff",
    );
    const loan = getLoopscaleLoanPda(borrower, fixtureNonce);

    expect(loan.toBase58()).toBe(
      "HF7r2z8Phx668weASuUnpVYdMd3Ge1bmC7o45doNmr8N",
    );
  });

  it("derives the loopscale event authority PDA", () => {
    expect(getLoopscaleEventAuthorityPda(LOOPSCALE_PROGRAM_ID).toBase58()).toBe(
      "6sbyEiDvcYELrqoxurz3XTTLLg5wpe8dHCXi4uTvSSTV",
    );
  });
});
