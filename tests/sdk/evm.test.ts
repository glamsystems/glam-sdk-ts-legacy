import { Keypair, PublicKey } from "@solana/web3.js";

import {
  evmAddressToBytes32,
  evmAddressToPublicKey,
  hexToBytes,
  publicKeyToEvmAddress,
} from "../../src/utils/evm";

const ADDRESS = "aB".repeat(20);
const BYTES32 = `0x${"00".repeat(12)}${"aB".repeat(20)}`;
const RECIPIENT = "cD".repeat(32);

// The decoder this one replaced, kept as the oracle of what used to work: it
// dropped the first 0x anywhere and read the rest two digits at a time.
function previous(address: string): PublicKey {
  return new PublicKey(
    hexToBytes(`0x000000000000000000000000${address.replace("0x", "")}`),
  );
}

describe("an EVM address or a recipient as the 32 bytes CCTP takes for it", () => {
  it.each([
    ["an address with 0x", `0x${ADDRESS}`, BYTES32],
    ["an address alone", ADDRESS, BYTES32],
    ["an address with 0X", `0X${ADDRESS}`, BYTES32],
    ["32 bytes with 0x", `0x${RECIPIENT}`, `0x${RECIPIENT}`],
    ["32 bytes alone", RECIPIENT, `0x${RECIPIENT}`],
    ["32 bytes with 0X", `0X${RECIPIENT}`, `0x${RECIPIENT}`],
    ["an address padded to 32 bytes", BYTES32.slice(2), BYTES32],
  ])("reads %s as those 32 bytes", (_name, address, bytes32) => {
    expect(evmAddressToBytes32(address)).toBe(bytes32);
    const key = evmAddressToPublicKey(address);
    expect(
      key.equals(new PublicKey(Buffer.from(bytes32.slice(2), "hex"))),
    ).toBe(true);
    // Each of these worked before, and reads as the same key.
    expect(key.equals(previous(address))).toBe(true);
  });

  // The previous decoder read each of these as some other key, shifted,
  // padded or cut, or as the key of all zeros.
  it.each([
    ["a digit that is no hex", `0x${"11".repeat(19)}1g`],
    ["38 digits", `0x${"11".repeat(19)}`],
    ["39 digits", `0x${"1".repeat(39)}`],
    ["41 digits", `0x${"1".repeat(41)}`],
    ["42 digits", `0x${"11".repeat(21)}`],
    ["63 digits", `0x${"1".repeat(63)}`],
    ["65 digits", `0x${"1".repeat(65)}`],
    ["0x inside the address", `${"11".repeat(10)}0x${"11".repeat(9)}`],
    ["space around it", ` 0x${ADDRESS} `],
    ["0x alone", "0x"],
    ["an empty address", ""],
  ])("refuses %s", (_name, address) => {
    const message = `Invalid EVM address ${address}: an address is 40 hexadecimal digits, or 64 for a 32-byte recipient, with or without 0x`;
    expect(() => evmAddressToBytes32(address)).toThrow(message);
    expect(() => evmAddressToPublicKey(address)).toThrow(message);
  });

  it("gives back the key an address was read from", () => {
    // A key whose first 12 bytes are zero is an EVM address padded.
    const bytes = Keypair.generate().publicKey.toBytes();
    bytes.fill(0, 0, 12);
    const key = new PublicKey(bytes);
    expect(evmAddressToPublicKey(publicKeyToEvmAddress(key)).equals(key)).toBe(
      true,
    );
  });
});
