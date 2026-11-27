import { inspect } from "node:util";

type ErrorModule = typeof import("../../src/error");

/** A copy of the SDK's error module, loaded apart from every other copy. */
async function loadCopy(): Promise<ErrorModule> {
  let copy!: ErrorModule;
  await jest.isolateModulesAsync(async () => {
    copy = await import("../../src/error");
  });
  return copy;
}

// The package has a CommonJS entry and an ES module entry, and each holds its
// own copy of every class. A process that loads both, as an application with
// a CommonJS dependency and an ES module one does, hands one copy's errors to
// the other copy's functions.
describe("a GlamError read by another copy of the SDK", () => {
  let one: ErrorModule;
  let other: ErrorModule;

  beforeAll(async () => {
    one = await loadCopy();
    other = await loadCopy();
  });

  const message =
    "Transaction failed at instruction 2: custom program error: 0x1967 (6503). The program logs were not available.";
  const failure = (copy: ErrorModule) =>
    new copy.GlamError(
      message,
      { InstructionError: [2, { Custom: 6503 }] },
      [],
    );

  it("is made by a constructor the other copy does not have", () => {
    expect(one.GlamError).not.toBe(other.GlamError);
    expect(failure(one)).not.toBeInstanceOf(other.GlamError);
    expect(failure(other)).not.toBeInstanceOf(one.GlamError);
  });

  it.each([
    ["the first copy", "the second", () => [one, other] as const],
    ["the second copy", "the first", () => [other, one] as const],
  ])(
    "made by %s, is displayed as it is by the parseTxError of %s",
    (_maker, _reader, copies) => {
      const [maker, reader] = copies();

      expect(reader.parseTxError(failure(maker))).toBe(message);
    },
  );

  it("is displayed as it is by its own copy's parseTxError", () => {
    expect(one.parseTxError(failure(one))).toBe(message);
    expect(other.parseTxError(failure(other))).toBe(message);
  });

  it("is told from other values by isGlamError of either copy", () => {
    for (const [maker, reader] of [
      [one, other],
      [other, one],
      [one, one],
    ]) {
      expect(reader.isGlamError(failure(maker))).toBe(true);
    }
    for (const value of [
      new Error(message),
      { message, rawError: null, programLogs: [] },
      message,
      null,
      undefined,
    ]) {
      expect(one.isGlamError(value)).toBe(false);
    }
  });

  it("carries its mark where nothing that prints or serialises it shows it", () => {
    const error = failure(one);
    const [mark] = Object.getOwnPropertySymbols(error);

    expect(Object.getOwnPropertyDescriptor(error, mark)).toEqual({
      value: true,
      writable: false,
      enumerable: false,
      configurable: false,
    });
    expect(mark).toBe(Symbol.for("@glamsystems/glam-sdk/GlamError"));
    // Neither the error's own enumerable properties, nor its JSON, nor what
    // the console prints holds the mark.
    expect(Object.getOwnPropertySymbols({ ...error })).toEqual([]);
    expect(JSON.stringify(error)).not.toContain("GlamError");
    expect(inspect(error)).not.toContain("glam-sdk/GlamError");
    expect(error.name).toBe("Error");
    expect(error).toBeInstanceOf(one.GlamError);
  });

  // A copy of the SDK older than the mark made errors without one. Such an
  // error is read as before, by its message.
  it("reads an error that carries no mark as before", () => {
    const fromOlderCopy = Object.assign(new Error(message), {
      rawError: { InstructionError: [2, { Custom: 6503 }] },
      programLogs: [],
    });

    expect(one.isGlamError(fromOlderCopy)).toBe(false);
    expect(one.parseTxError(fromOlderCopy)).toBe(
      "RPC service unavailable: try again shortly",
    );
  });

  it("answers false for a revoked proxy, and does not throw", () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();

    expect(one.isGlamError(proxy)).toBe(false);
  });

  it("leaves a plain Error whose message holds 503 to the RPC advice", () => {
    for (const copy of [one, other]) {
      expect(copy.parseTxError(new Error(message))).toBe(
        "RPC service unavailable: try again shortly",
      );
    }
  });
});
