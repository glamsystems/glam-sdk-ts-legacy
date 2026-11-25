import { PublicKey } from "@solana/web3.js";

/**
 * Validates if a string is a valid EVM address (40 hex characters)
 */
export const isValidEvmAddress = (addr: string): boolean => {
  const cleanAddr = addr.startsWith("0x") ? addr.slice(2) : addr;
  return /^[0-9a-fA-F]{40}$/.test(cleanAddr);
};

/**
 * The 32 bytes CCTP takes for a recipient, as 0x and 64 hexadecimal digits:
 * an EVM address, 40 digits, left-padded with zeros, or a recipient's own 32
 * bytes, 64 digits, each with 0x, 0X or neither before them. Any other text
 * is refused: the bytes are read two digits at a time, and other text gave
 * another recipient.
 */
export const evmAddressToBytes32 = (address: string): string => {
  const hex = /^0[xX]/.test(address) ? address.slice(2) : address;
  if (!/^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(hex)) {
    throw new Error(
      `Invalid EVM address ${address}: an address is 40 hexadecimal digits, or 64 for a 32-byte recipient, with or without 0x`,
    );
  }
  return `0x${hex.padStart(64, "0")}`;
};

export const hexToBytes = (hex: string) => {
  if (hex.startsWith("0x")) hex = hex.slice(2);
  let bytes = [];
  for (let c = 0; c < hex.length; c += 2)
    bytes.push(parseInt(hex.slice(c, c + 2), 16));
  return bytes;
};

export const evmAddressToPublicKey = (address: string): PublicKey => {
  return new PublicKey(hexToBytes(evmAddressToBytes32(address)));
};

export const bytesToHex = (bytes: number[] | Uint8Array): string => {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

export const publicKeyToEvmAddress = (publicKey: PublicKey): string => {
  const bytes = publicKey.toBytes();
  const hex = bytesToHex(bytes);
  // EVM addresses are the last 20 bytes (40 hex characters) of the 32-byte public key
  const evmAddress = hex.slice(-40);
  return `0x${evmAddress}`;
};
