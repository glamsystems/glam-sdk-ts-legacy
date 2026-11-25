# GLAM SDK

![NPM Version](https://img.shields.io/npm/v/%40glamsystems%2Fglam-sdk)

A TypeScript SDK for building applications on the GLAM Protocol.

**Note:** This repository is automatically synced from GLAM's private monorepo. Pull requests cannot be accepted here, but we welcome bug reports and feature requests through GitHub Issues.

## Installation

```bash
npm i --save-exact @glamsystems/glam-sdk
```

## Versioning

Minor releases can include breaking changes, including within 1.x. Patch
releases contain fixes. Breaking changes are identified in the release notes.
Pin an exact SDK version and read those notes before upgrading. A range such
as `^1.1.2` can accept a breaking minor release.

## Upgrading to 1.3.0

1.3.0 is a minor release with breaking changes. Each entry says which 1.2.2
code is affected and what to write now. Code that uses none of these names
needs no change.

### Loopscale borrow terms carry their duration

`BorrowMarketAccounts`, `LoopscaleBorrowPrincipalTerms` and
`LoopscaleBorrowQuoteTerms` require `duration`, a `LoopscaleLoanDuration`
that names the term `durationIndex` stands for. Values the SDK returns carry
it. A value you build yourself, such as a test fixture, does not compile
without it.

```ts
// 1.2.2
const accounts: BorrowMarketAccounts = {
  marketInformation,
  principalMint,
  durationIndex: 2,
  assetIndexGuidance,
};

// 1.3.0
const accounts: BorrowMarketAccounts = {
  marketInformation,
  principalMint,
  durationIndex: 2,
  duration: { durationType: 2, duration: 1 },
  assetIndexGuidance,
};
```

`durationIndex` 0 to 4 stands for one day `{ durationType: 0, duration: 1 }`,
one week `{ durationType: 1, duration: 1 }`, one month
`{ durationType: 2, duration: 1 }`, three months
`{ durationType: 2, duration: 3 }` and one year
`{ durationType: 4, duration: 1 }`.

A strategy can lend several terms at one APY. `resolveBorrowMarketAccounts`
and `resolveBorrowTermsFromStrategy` took the first `durationIndex` that
lends at `expectedApy`. They now throw when more than one does and the call
passes no `duration`. Pass the term as `duration`.

```ts
const terms = await client.loopscaleBorrow.resolveBorrowTermsFromStrategy({
  strategy,
  principalMint,
  assetIdentifier,
  expectedApy,
  expectedLqt,
  duration: { durationType: 2, duration: 1 },
});
```

With `duration` the call throws when no `durationIndex` stands for that term,
when the strategy does not lend that term for the collateral, and when it
lends that term at another APY.

`resolveBorrowTermsFromQuote` now uses the term of the quote, where 1.2.2
took the first `durationIndex` that lends at the quoted APY. It throws in the
same three cases.

### Pricing instructions left the bundled `glam_mint` IDL

This change reaches only integrations that have no production deployment:
Jupiter Earn and Borrow, Marginfi, Orca, registered positions, the bridge,
Loopscale, Neutral and Phoenix. Their programs run on staging and on a
localnet. `priceKaminoObligations`, `priceKaminoVaultShares`,
`priceSingleAssetVault` and `priceVaultTokens` stay in the `glam_mint` IDL,
and `priceStakeAccounts` stays in its staging and control IDLs. Kamino pricing
stays on `client.mintProgram`.

`priceJupiterBorrowPositions`, `priceJupiterEarnPositions`,
`priceMarginfiAccounts`, `priceOrcaWhirlpoolPositions` and
`priceRegisteredPositions` left the bundled `glam_mint` IDL and its
`GlamMint` type. A call to one of them on `client.mintProgram.methods` no
longer compiles.

The staging IDL, which a client with `useStaging: true` loads, also loses
`priceBridgeManagedTransfers`, `priceLoopscaleLoans`,
`priceLoopscaleStrategies`, `priceLoopscaleVaultPositions`,
`priceNeutralBundleDepositors` and `pricePhoenixTraders`. The `GlamMint` type
never had these six, so a call to one of them went through a cast, and it
now throws a `TypeError`. The `glam_mint-control` IDL loses the same eleven.

`client.price` builds every pricing instruction as before and needs no
change. `extPricerIx` and `extRegisteredPositionsPricerIx` did not change
either. Code that called a pricing instruction on `client.mintProgram` calls
it on the program of its integration, whose IDL now has it.

```ts
// 1.2.2
client.mintProgram.methods.priceMarginfiAccounts();

// 1.3.0, on staging or a localnet
client.extMarginfiProgram.methods.priceMarginfiAccounts();
```

The programs are `client.extJupiterProgram` for the two Jupiter instructions,
`client.extLoopscaleProgram` for the three Loopscale ones,
`client.extMarginfiProgram`, `client.extNeutralProgram`,
`client.extOrcaProgram`, `client.extPhoenixProgram` and, for
`priceRegisteredPositions`, `client.extRpiProgram`. Each instruction keeps
its name and arguments. It takes no `signer`, `eventAuthority` or
`eventProgram` account, and `glamProtocol` is named `glamProtocolProgram`.

`priceBridgeManagedTransfers` is
`client.extBridgeProgram.methods.priceManagedTransfers()`, which 1.2.2
already had. It takes `bridgeRegistry` and no `glamVault`. The bundled
`ext_bridge` IDL fixes `glamProtocolProgram` to the production
`glam_protocol`, where the `glam_mint` call named the staging one. Anchor
resolves `bridgeRegistry` and `glamProtocolProgram`, so neither compiles in
`.accounts()` (TS2353). On a client with `useStaging: true`, pass the
staging program through `.accountsPartial()`.

```ts
client.extBridgeProgram.methods.priceManagedTransfers().accountsPartial({
  glamProtocolProgram: client.protocolProgram.programId,
});
```

The `glam_mint` call read no registry and always wrote a record with an
amount of 0. `priceManagedTransfers` fails for a vault that has no registry
account and while an active transfer is not `Validated`, and it writes no
record when the registry has no active transfer.

The accounts of the `glam_mint` call do not carry over to the new call:

- `integrationAuthority` is the PDA of the integration program, for example
  `getIntegrationAuthorityPda(client.extMarginfiProgram.programId)`. The
  `glam_mint` call took the PDA of `glam_mint`. Anchor derives the account
  when the call leaves it out.
- `priceManagedTransfers` takes as remaining accounts one oracle of the source
  mint for each active transfer, in the order of the bridge registry.
- `pricePhoenixTraders` takes as remaining accounts the Phoenix global config,
  the perp asset map and the instructions sysvar, then the traders, then the
  USDC oracle when the base asset of the vault is not USDC. It refuses a
  trader with a resting order unless a Phoenix `updateTraderState` for that
  trader comes before it in the same transaction, with only other such
  instructions between them. This layout holds only where `ext_phoenix` has
  that rule. The staging `ext_phoenix` of the mainnet cluster predates the
  rule and reads its first trader at remaining account index 2, where this
  layout puts the instructions sysvar, so a call with this layout fails there.

`client.price.priceVaultIxs()` builds these accounts and the Phoenix syncs.
It throws for a vault that enables Phoenix and tracks a Phoenix trader on the
staging programs of the mainnet cluster.

The pricing instructions of the integration programs emit no
`PricedProtocolRecord` event. `client.price` already called them in 1.2.2, so
this affects code that moves a direct call, and an indexer that reads the
event for a vault on staging. Each of them passes its record to
`glam_protocol` in an `updatePricedProtocol` inner instruction of the
transaction. Its data starts with the bytes `0a6a5eab76d93e62`, and the Borsh
`PricedProtocol` follows. `priceManagedTransfers` is the exception: it writes
no record when the registry has no active transfer.
`client.price.priceVaultIxs()` can add it for a vault that enables a bridge
protocol and has a registry, so its transaction can hold a
`priceManagedTransfers` with no `updatePricedProtocol` under it.

`connection.getTransaction` returns inner instructions in
`meta.innerInstructions`. Pass it `maxSupportedTransactionVersion: 1`, because
the SDK builds version 1 transactions by default on every cluster but
localnet. A failed transaction lists its inner instructions there too, and
none of their writes happened: a pricing instruction can pass its record
before a later instruction of the same transaction, such as `validateAum`,
fails. Keep a record only from a transaction whose `meta.err` is `null`.
`glam_mint` emits `PricedProtocolRecord` as a CPI event, an inner instruction
in `meta.innerInstructions` as well, so an indexer of that event needs the
same check. Anchor's `program.addEventListener` reads only the logs of a
transaction, so it never delivers that event.

A simulation returns inner instructions only with `innerInstructions: true`,
which `connection.simulateTransaction` takes with a `VersionedTransaction`
only. Simulate a version 1 transaction as the `V1Transaction` that
`client.intoVersionedTransaction()` returns, because `@solana/web3.js` 1.99.0
cannot serialize a version 1 message. A simulation writes nothing, so its
records are only a preview.

```ts
import { BorshInstructionCoder, type IdlTypes, utils } from "@coral-xyz/anchor";
import type { GlamProtocolProgram } from "@glamsystems/glam-sdk";

const tx = await connection.getTransaction(signature, {
  maxSupportedTransactionVersion: 1,
});
if (tx?.meta?.err === null) {
  // `data` is the data of an inner instruction of `glam_protocol` in
  // `tx.meta.innerInstructions`, in base58 as the RPC returns it.
  const coder = new BorshInstructionCoder(client.protocolProgram.idl);
  const decoded = coder.decode(Buffer.from(utils.bytes.bs58.decode(data)));
  if (decoded?.name === "updatePricedProtocol") {
    // Anchor declares `data` as `Object`, so give it the IDL type.
    const { pricedProtocol } = decoded.data as {
      pricedProtocol: IdlTypes<GlamProtocolProgram["idl"]>["pricedProtocol"];
    };
    // pricedProtocol has rent, amount, decimals, lastUpdatedSlot,
    // integrationProgram, protocolBitflag and positions.
  }
}
```

The SDK does not re-export `BorshInstructionCoder`, `IdlTypes` or `utils`, so
code like this lists `@coral-xyz/anchor` 0.31.1, the version the SDK depends
on, among its own dependencies.

The state account is no substitute. `subscribe`, `subscribeWithRefNav`,
`fulfill` and `fulfillWithRefNav` clear its `pricedProtocols`. So does
`claimFees` when it has a fee to pay, and so does `cpiProxy`, through which an
integration instruction acts for the vault.

The `ObservationState` account and the types `Denomination`,
`DenominationSpec`, `Observation`, `ObservationState`, `PositionObservation`
and `StoredI128` left the `glam_mint` IDL too. They are in the `ext_rpi` IDL,
for example `IdlTypes<ExtRpiProgram["idl"]>["observationState"]`. Read the
account with `client.rpi.fetchObservationState()` or
`client.extRpiProgram.account.observationState`.

### Eight integration program IDLs no longer declare the `StateAccount` account

The IDLs of `ext_bridge`, `ext_jupiter`, `ext_loopscale`, `ext_marginfi`,
`ext_neutral`, `ext_orca`, `ext_phoenix` and `ext_rpi` no longer list the
`StateAccount` account, so their programs have no `account.stateAccount`.
Read the state through `glam_protocol`.

```ts
// 1.2.2
await client.extJupiterProgram.account.stateAccount.fetch(statePda);

// 1.3.0
await client.protocolProgram.account.stateAccount.fetch(statePda);
```

`client.fetchStateAccount(statePda)` reads the same account. For `ext_bridge`,
`ext_loopscale`, `ext_phoenix` and `ext_rpi` the 1.2.2 line no longer
compiles. For `ext_jupiter`, `ext_marginfi`, `ext_neutral` and `ext_orca` it
still compiles and throws a `TypeError` when it runs.

### `ext_phoenix` IDL changes

`registerTrader` takes `maxPositions` as a number and requires
`traderPreferenceBits`, which the program accepts only as 0.
`client.phoenix.registerTrader` and the `registerTraderIx` and
`registerTraderTx` builders of `client.phoenix.txBuilder` still accept a `BN`
and default the bits to 0. A call on
`client.extPhoenixProgram.methods` in the 1.2.2 form no longer compiles.

```ts
// 1.2.2
client.extPhoenixProgram.methods.registerTrader({
  maxPositions: new BN(64),
  traderPdaIndex: 0,
  traderSubaccountIndex: 0,
});

// 1.3.0
client.extPhoenixProgram.methods.registerTrader({
  maxPositions: 64,
  traderPreferenceBits: 0,
  traderPdaIndex: 0,
  traderSubaccountIndex: 0,
});
```

`PhoenixRegisterTraderParams.maxPositions` is `number | BN`. Code that reads
it as a `BN` checks it with `BN.isBN` first. In 1.2.2 the type was the IDL
type of the argument. A value of it no longer compiles as the argument of
`client.extPhoenixProgram.methods.registerTrader`, which takes
`IdlTypes<ExtPhoenixProgram["idl"]>["registerTraderParams"]`.

`client.extPhoenixProgram.methods.transferCollateralChildToParent()` drops
its `{ amount }` argument and moves all free collateral of the child to its
parent. The IDL type `transferCollateralChildToParentInstruction` is removed.

### Calls that refuse input they used to accept

- `evmAddressToBytes32` and `evmAddressToPublicKey` accept 40 hexadecimal
  digits, or 64 for a 32-byte recipient, after `0x`, `0X` or no prefix. They
  throw for any other text. 1.2.2 turned most such text into another
  recipient. For 64 digits or a `0X` prefix `evmAddressToBytes32` now returns
  `0x` and 64 digits.
- `client.bridge.oft.send`, `client.bridge.oft.buildSendTx` and
  `client.bridge.buildLayerzeroOftSendTx` throw for a negative amount,
  `minAmountLd` or fee, a `minAmountLd` above the amount, a `minAmountLd`
  under the lowest quote the cost bound of the live route admits, and an
  amount outside the range of the live route on the destination chain. The
  program refuses the last three. 1.2.2 sent a negative value as its
  magnitude. The live route is now read for every send.
- `resolveLayerzeroOftMinAmountLd` throws for a negative amount or
  `minAmountLd`, a `minAmountLd` above the amount, and a `minAmountLd` under
  the lowest quote its `maxCostBps` admits.
- `client.phoenix.registerTrader` and the `registerTraderIx` and
  `registerTraderTx` builders of `client.phoenix.txBuilder` throw for a
  `maxPositions` that is not an integer from 0 to 4294967295.
- `client.kaminoFarm.unstake` and `client.kaminoFarm.txBuilder.unstakeTx`
  throw for a farm with a withdrawal cooldown. They unstake and withdraw in
  one transaction, which such a farm refuses.
- `client.kaminoFarm.parseFarmState` rejects with a `RangeError` for data
  shorter than 7408 bytes, which 1.2.2 parsed.
  `client.kaminoFarm.fetchAndParseFarmStates` rejects the same way when a
  listed address holds such an account, where 1.2.2 resolved with an entry for
  it. A farm account has 8336 bytes.
- `client.sendAndConfirm` throws when the RPC answers a send with the
  signature of another transaction. A test double of `sendRawTransaction`
  must return the first signature of the transaction it was given. A value
  that `sendRawTransaction` throws and that is not an `Error` is rethrown as
  an `Error` with that text. All of this holds only when the first signature,
  the fee payer's, is set once the wallet and the additional signers have
  signed, which means present and not all zero. When it is not, the SDK does
  not compare the answer of the RPC, and it rethrows what `sendRawTransaction`
  threw as it is.

### Kamino farm types

`ParsedFarmState` requires `totalStakedAmount`, `totalActiveStakeScaled`,
`withdrawalCooldownPeriod`, `timeUnit`, `lockingMode`,
`lockingStartTimestamp`, `lockingDuration` and
`lockingEarlyWithdrawalPenaltyBps`. `ParsedFarmUser` requires
`activeStakeScaled` and `lastStakeTs`. Values the SDK returns carry them. A
value you build yourself needs them. `KaminoFarmClient` has a private member
now, so an object you build in its place needs a cast.

### Files no longer in the package

The package no longer ships the `target/idl` and `target/types` files of the
localnet mock programs `mock_layerzero_endpoint`, `mock_layerzero_oft` and
`mock_wormhole_verify_vaa_shim`.

### Fixes

- `client.timelock.apply()` applies the staged changes of a single-asset
  vault. 1.2.2 threw `Unsupported account type`.
- `client.kaminoVaults.withdraw` takes the reserve and its ctoken vault from
  the same allocation, the first one that is not empty. 1.2.2 could pair a
  reserve with the ctoken vault of another allocation. A vault with no
  allocation throws `Kamino vault <address> has no reserve allocation`.
- `client.kaminoFarm.fetchAndParseFarmStates` reads more than 100 farms.
- `resolveBorrowTermsFromTargetStrategy` resolves the requested
  `durationIndex` when a lower one lends at the same APY. 1.2.2 threw.

### New in 1.3.0

- `client.rpi.fetchPolicy()` returns the `ext_rpi` policy of the vault as an
  `RpiPolicy`, or `null` when the vault stores none.
  `RpiPolicy.position(positionId)` returns the `RpiPositionConfig` of a
  registered position, or `undefined`.
- `resolveBorrowMarketAccounts` and `resolveBorrowTermsFromStrategy` take an
  optional `duration`. Their results carry it, and so do those of
  `resolveBorrowTermsFromTargetStrategy` and `resolveBorrowTermsFromQuote`.
- `client.bridge.oft.resolveMinAmountLd(params)` returns the `minAmountLd` a
  send with those parameters carries at the time of the call. A send without
  `minAmountLd` resolves it again from the live route, which can change in
  between. To send the minimum that was shown, pass it, as in
  `client.bridge.oft.send({ ...params, minAmountLd })`. The send throws if the
  live route no longer admits it.
- `client.kaminoFarm.findAndParseFarmUserStates(owner, directFarms)` reads the
  direct stake of the owner in each listed farm by address, without a program
  scan. It leaves out a farm where the owner has no user state and does not
  find delegated stakes. It throws when the account at that address is not
  the user state of that owner in that farm, and when it is a delegated
  stake.
- `client.phoenix.registerTrader` accepts `maxPositions` as a number and an
  optional `traderPreferenceBits`.
- When the RPC does not acknowledge a send, the error that
  `client.sendAndConfirm` throws has an `unacknowledgedSignature` property,
  the signature of the signed transaction. No declared type has the
  property. That transaction can still land, so check it onchain before a
  retry. The SDK sets the property only when the first signature, the fee
  payer's, is set once the wallet and the additional signers have signed. An
  error without the property says nothing about whether the transaction was
  sent.
- The `ext_jupiter`, `ext_loopscale`, `ext_marginfi`, `ext_neutral`,
  `ext_orca`, `ext_phoenix` and `ext_rpi` IDLs have the pricing instructions
  named above.
- The `ext_phoenix` IDL adds `depositNativeSol`, `withdrawNativeSol`,
  `transferNativeSol`, `transferNativeSolFromChildToParent`,
  `placeMultiLimitOrderV2`, `placeLimitOrderWithConditionals`,
  `placeAttachedConditionalOrder`, `placePositionConditionalOrder`,
  `cancelConditionalOrder` and `cancelAllPlusConditional`, with their types
  and the errors 6030 to 6034.

### Dependencies

Five exact dependency versions changed: `@ellipsis-labs/rise` 0.4.66 to
0.4.78, `@glamsystems/ix-mapper` 0.2.4 to 0.2.5,
`@glamsystems/sanctum-lst-list` 0.2.55 to 0.2.57,
`@marinade.finance/marinade-ts-sdk` 5.0.15 to 5.0.18 and `@solana/spl-token`
0.4.13 to 0.4.15. The supported Node versions did not change.

## Getting Started

- [GLAM docs](https://docs.glam.systems/v1)

## Examples

[GLAM CLI](https://github.com/glamsystems/glam-cli-legacy) is built with the GLAM SDK.

See other [examples](./examples).
