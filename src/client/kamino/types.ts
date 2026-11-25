import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

export const DEFAULT_OBLIGATION_ARGS = { tag: 0, id: 0 };
export const KAMINO_VAULTS_EVENT_AUTHORITY = new PublicKey(
  "24tHwQyJJ9akVXxnvkekGfAoeUJXXS7mE6kQNioNySsK",
);

export interface RefreshObligationAccounts {
  lendingMarket: PublicKey;
  obligation: PublicKey;
  reserves: PublicKey[];
}

export interface RefreshReserveAccounts {
  reserve: PublicKey;
  lendingMarket: PublicKey;
  pythOracle: PublicKey;
  switchboardPriceOracle: PublicKey;
  switchboardTwapOracle: PublicKey;
  scopePrices: PublicKey;
}

export interface RefreshObligationFarmsForReserveArgs {
  mode: number; // 0 collateral farm, 1 debt farm
}

export interface RefreshObligationFarmsForReserveAccounts {
  crank: PublicKey;
  baseAccounts: {
    obligation: PublicKey;
    lendingMarketAuthority: PublicKey;
    reserve: PublicKey;
    reserveFarmState: PublicKey;
    obligationFarmUserState: PublicKey;
    lendingMarket: PublicKey;
  };
  farmsProgram: PublicKey;
  rent: PublicKey;
  systemProgram: PublicKey;
}

export interface ParsedFarmState {
  globalConfig: PublicKey;
  farmTokenMint: PublicKey;
  farmTokenDecimals: BN;
  farmTokenProgram: PublicKey;
  farmVault: PublicKey;
  // The active pool: the farm token staked, in base units, and the stake
  // shares that stand for it. An unstake takes shares and is paid at this rate.
  totalStakedAmount: BN;
  totalActiveStakeScaled: BN;
  // How long an unstake waits before its tokens can be withdrawn, in the
  // farm's time unit: 0 for seconds, 1 for slots.
  withdrawalCooldownPeriod: number;
  timeUnit: number;
  // The lock an unstake pays the early withdrawal penalty inside. Mode 0
  // locks nothing, 1 locks from each user's last stake and 2 from
  // lockingStartTimestamp, each for lockingDuration in the farm's time unit.
  lockingMode: BN;
  lockingStartTimestamp: BN;
  lockingDuration: BN;
  lockingEarlyWithdrawalPenaltyBps: BN;
  rewards: {
    index: number;
    mint: PublicKey;
    minClaimDurationSeconds: BN;
    tokenProgram: PublicKey;
    rewardsVault: PublicKey;
  }[];
}

export interface ParsedFarmUser {
  pubkey: PublicKey;
  farmState: PublicKey;
  unclaimedRewards: BN[];
  // The owner's stake shares in the farm's active pool.
  activeStakeScaled: BN;
  // When the owner last staked, in the farm's time unit.
  lastStakeTs: BN;
}
