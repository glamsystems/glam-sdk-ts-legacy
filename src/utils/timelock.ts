import { PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { IntegrationAcl, DelegateAcl } from "../models";
import {
  parseProtocolsBitmask,
  parseProtocolPermissionsBitmask,
} from "./bitmask";
import { PkMap } from "./pkmap";
import { PkSet } from "./pkset";

/**
 * Get protocol names from a bitmask for a given integration program
 * Uses the SDK's parseProtocolsBitmask function
 */
export function getProtocolNamesFromBitmask(
  integrationProgram: PublicKey,
  bitmask: number,
  staging: boolean,
): string[] {
  const { protocols } = parseProtocolsBitmask(
    integrationProgram,
    bitmask,
    staging,
  );
  return protocols.map((p) => p.name);
}

/**
 * Get permission names from a permissions bitmask for a protocol
 * Uses the SDK's parseProtocolPermissionsBitmask function
 */
export function getPermissionNamesFromBitmask(
  integrationProgram: PublicKey,
  protocolBitflag: number,
  permissionsBitmask: BN,
  staging: boolean,
): string[] {
  const { permissions } = parseProtocolPermissionsBitmask(
    integrationProgram,
    protocolBitflag,
    permissionsBitmask,
    staging,
  );
  return permissions.map((p) => p.name);
}

/**
 * Compare current and staged PublicKey arrays and return added/removed keys
 */
export function comparePublicKeyArrays(
  current: PublicKey[] | null,
  staged: PublicKey[],
): { added: PublicKey[]; removed: PublicKey[] } {
  const currentSet = new PkSet(current || []);
  const stagedSet = new PkSet(staged);
  return {
    added: [...stagedSet].filter((pk) => !currentSet.has(pk)),
    removed: [...currentSet].filter((pk) => !stagedSet.has(pk)),
  };
}

/**
 * A protocol whose policy glam_protocol reads differently from the staged
 * integration list than from the live one: added, dropped, or with other
 * bytes.
 */
export type ProtocolPolicyChange = {
  integrationProgram: PublicKey;
  /** The protocol's bit, one bit even where a stored policy holds several. */
  protocolBitflag: number;
  /** The protocol's name, or "Unknown" for a bit the SDK does not list. */
  protocolName: string;
  /** The bytes read from the live list, or null when it holds none. */
  current: Buffer | null;
  /** The bytes read from the staged list, or null when it holds none. */
  staged: Buffer | null;
};

/**
 * A list's entries by program, as glam_protocol reads them. Its
 * `check_integration` accepts a protocol that any entry for the program
 * enables, and its `get_protocol_policy` reads the policies of the first
 * entry alone. So a program the list holds more than once is one entry here,
 * with every entry's protocols and the first entry's policies.
 */
function entriesByProgram(
  acls: IntegrationAcl[] | null,
): PkMap<IntegrationAcl> {
  const byProgram = new PkMap<IntegrationAcl>();
  (acls || []).forEach((acl) => {
    const first = byProgram.get(acl.integrationProgram);
    byProgram.set(
      acl.integrationProgram,
      first
        ? new IntegrationAcl({
            ...first,
            protocolsBitmask: first.protocolsBitmask | acl.protocolsBitmask,
          })
        : acl,
    );
  });
  return byProgram;
}

/**
 * The policy `get_protocol_policy` reads for a protocol: the first one whose
 * bitflag holds the protocol's bit. A later policy for the bit is never read.
 */
function policyRead(
  acl: IntegrationAcl | undefined,
  protocolBit: number,
): Buffer | null {
  const policy = (acl?.protocolPolicies ?? []).find(
    (entry) => (Number(entry.protocolBitflag) & protocolBit) !== 0,
  );
  return policy ? Buffer.from(policy.data) : null;
}

/** The protocol bits an entry stores a policy under, lowest first. */
function policyBits(acl: IntegrationAcl | undefined): number[] {
  const stored = (acl?.protocolPolicies ?? []).reduce(
    (bits, policy) => bits | Number(policy.protocolBitflag),
    0,
  );
  // A protocol bitflag is a u16.
  return Array.from({ length: 16 }, (_, index) => 1 << index).filter(
    (bit) => (stored & bit) !== 0,
  );
}

function compareProtocolPolicies(
  currentMap: PkMap<IntegrationAcl>,
  stagedMap: PkMap<IntegrationAcl>,
  staging: boolean,
): ProtocolPolicyChange[] {
  const changes: ProtocolPolicyChange[] = [];
  const programs = new PkSet([...currentMap.pkKeys(), ...stagedMap.pkKeys()]);

  programs.forEach((integrationProgram) => {
    const current = currentMap.get(integrationProgram);
    const staged = stagedMap.get(integrationProgram);
    const bits = new Set([...policyBits(current), ...policyBits(staged)]);

    [...bits]
      .sort((a, b) => a - b)
      .forEach((protocolBitflag) => {
        const before = policyRead(current, protocolBitflag);
        const after = policyRead(staged, protocolBitflag);
        if (before && after && before.equals(after)) {
          return;
        }
        changes.push({
          integrationProgram,
          protocolBitflag,
          protocolName:
            getProtocolNamesFromBitmask(
              integrationProgram,
              protocolBitflag,
              staging,
            )[0] || "Unknown",
          current: before,
          staged: after,
        });
      });
  });

  return changes;
}

/** Whether two lists store the same entries in the same order. */
function storeTheSame(
  current: IntegrationAcl[],
  staged: IntegrationAcl[],
): boolean {
  return (
    current.length === staged.length &&
    current.every((acl, index) => {
      const other = staged[index];
      const policies = acl.protocolPolicies ?? [];
      const others = other.protocolPolicies ?? [];
      return (
        acl.integrationProgram.equals(other.integrationProgram) &&
        acl.protocolsBitmask === other.protocolsBitmask &&
        policies.length === others.length &&
        policies.every(
          (policy, at) =>
            Number(policy.protocolBitflag) ===
              Number(others[at].protocolBitflag) &&
            Buffer.from(policy.data).equals(Buffer.from(others[at].data)),
        )
      );
    })
  );
}

/**
 * Compare current and staged integrationAcls and return the differences.
 *
 * `added`, `removed` and `modified` compare the integrations and the protocols
 * each one enables. `policyChanges` compares the policy of every protocol on
 * either list, so a staged change that only edits a policy, such as a mint's
 * minimum subscription, shows there and nowhere else.
 *
 * Both follow glam_protocol's own lookups, which matters for a list that
 * holds a program or a protocol's policy more than once: a protocol counts as
 * enabled when any entry for its program enables it, and its policy is the
 * first one for its bit in the program's first entry.
 *
 * `identical` says whether the two lists store the same entries in the same
 * order. It is false with nothing else reported when they differ only in what
 * those lookups never reach: the order of the entries, a policy behind
 * another for the same bit, the policies of a program's later entry.
 */
export function compareIntegrationAcls(
  current: IntegrationAcl[] | null,
  staged: IntegrationAcl[] | null,
  staging: boolean,
): {
  added: IntegrationAcl[];
  removed: IntegrationAcl[];
  modified: Array<{
    integrationProgram: PublicKey;
    currentBitmask: number;
    stagedBitmask: number;
    enabledProtocols: string[];
    disabledProtocols: string[];
  }>;
  policyChanges: ProtocolPolicyChange[];
  identical: boolean;
} {
  const added: IntegrationAcl[] = [];
  const removed: IntegrationAcl[] = [];
  const modified: Array<{
    integrationProgram: PublicKey;
    currentBitmask: number;
    stagedBitmask: number;
    enabledProtocols: string[];
    disabledProtocols: string[];
  }> = [];

  const currentMap = entriesByProgram(current);
  const stagedMap = entriesByProgram(staged);

  // Find added integrations
  stagedMap.forEach((stagedAcl, integrationProgram) => {
    if (!currentMap.has(integrationProgram)) {
      added.push(stagedAcl);
    }
  });

  // Find removed integrations
  currentMap.forEach((currentAcl, integrationProgram) => {
    if (!stagedMap.has(integrationProgram)) {
      removed.push(currentAcl);
    }
  });

  // Find modified integrations (changed bitmask)
  currentMap.forEach((currentAcl, integrationProgram) => {
    const stagedAcl = stagedMap.get(integrationProgram);
    if (
      stagedAcl &&
      currentAcl.protocolsBitmask !== stagedAcl.protocolsBitmask
    ) {
      const currentProtocols = getProtocolNamesFromBitmask(
        currentAcl.integrationProgram,
        currentAcl.protocolsBitmask,
        staging,
      );
      const stagedProtocols = getProtocolNamesFromBitmask(
        stagedAcl.integrationProgram,
        stagedAcl.protocolsBitmask,
        staging,
      );

      const enabledProtocols = stagedProtocols.filter(
        (p) => !currentProtocols.includes(p),
      );
      const disabledProtocols = currentProtocols.filter(
        (p) => !stagedProtocols.includes(p),
      );

      modified.push({
        integrationProgram: currentAcl.integrationProgram,
        currentBitmask: currentAcl.protocolsBitmask,
        stagedBitmask: stagedAcl.protocolsBitmask,
        enabledProtocols,
        disabledProtocols,
      });
    }
  });

  const policyChanges = compareProtocolPolicies(currentMap, stagedMap, staging);
  const identical = storeTheSame(current || [], staged || []);

  return { added, removed, modified, policyChanges, identical };
}

/**
 * Compare current and staged delegateAcls and return the differences
 */
export function compareDelegateAcls(
  current: DelegateAcl[] | null,
  staged: DelegateAcl[] | null,
  staging: boolean,
): {
  added: DelegateAcl[];
  removed: DelegateAcl[];
  modified: Array<{
    pubkey: PublicKey;
    currentExpiresAt: BN;
    stagedExpiresAt: BN;
    permissionChanges: Array<{
      integrationProgram: PublicKey;
      protocolName: string;
      addedPermissions: string[];
      removedPermissions: string[];
    }>;
  }>;
} {
  const added: DelegateAcl[] = [];
  const removed: DelegateAcl[] = [];
  const modified: Array<{
    pubkey: PublicKey;
    currentExpiresAt: BN;
    stagedExpiresAt: BN;
    permissionChanges: Array<{
      integrationProgram: PublicKey;
      protocolName: string;
      addedPermissions: string[];
      removedPermissions: string[];
    }>;
  }> = [];

  const currentMap = new PkMap<DelegateAcl>();
  (current || []).forEach((acl) => {
    currentMap.set(acl.pubkey, acl);
  });

  const stagedMap = new PkMap<DelegateAcl>();
  (staged || []).forEach((acl) => {
    stagedMap.set(acl.pubkey, acl);
  });

  // Find added delegates
  stagedMap.forEach((stagedAcl, pubkey) => {
    if (!currentMap.has(pubkey)) {
      added.push(stagedAcl);
    }
  });

  // Find removed delegates
  currentMap.forEach((currentAcl, pubkey) => {
    if (!stagedMap.has(pubkey)) {
      removed.push(currentAcl);
    }
  });

  // Find modified delegates
  currentMap.forEach((currentAcl, pubkey) => {
    const stagedAcl = stagedMap.get(pubkey);
    if (!stagedAcl) return;

    const permissionChanges: Array<{
      integrationProgram: PublicKey;
      protocolName: string;
      addedPermissions: string[];
      removedPermissions: string[];
    }> = [];

    // Create maps for easier comparison
    const currentPermissionsMap = new PkMap<Map<number, BN>>();
    currentAcl.integrationPermissions.forEach((intPerm) => {
      const protocolMap = new Map<number, BN>();
      intPerm.protocolPermissions.forEach((protPerm) => {
        protocolMap.set(protPerm.protocolBitflag, protPerm.permissionsBitmask);
      });
      currentPermissionsMap.set(intPerm.integrationProgram, protocolMap);
    });

    const stagedPermissionsMap = new PkMap<Map<number, BN>>();
    stagedAcl.integrationPermissions.forEach((intPerm) => {
      const protocolMap = new Map<number, BN>();
      intPerm.protocolPermissions.forEach((protPerm) => {
        protocolMap.set(protPerm.protocolBitflag, protPerm.permissionsBitmask);
      });
      stagedPermissionsMap.set(intPerm.integrationProgram, protocolMap);
    });

    // Check all integration programs and protocols
    const allProgramIds = new PkSet([
      ...currentPermissionsMap.pkKeys(),
      ...stagedPermissionsMap.pkKeys(),
    ]);

    allProgramIds.forEach((integrationProgram) => {
      const currentProtocols =
        currentPermissionsMap.get(integrationProgram) || new Map();
      const stagedProtocols =
        stagedPermissionsMap.get(integrationProgram) || new Map();

      const allProtocolBitflags = new Set([
        ...currentProtocols.keys(),
        ...stagedProtocols.keys(),
      ]);

      allProtocolBitflags.forEach((protocolBitflag) => {
        const current = currentProtocols.get(protocolBitflag);
        const staged = stagedProtocols.get(protocolBitflag);

        if (!current && staged) {
          // Protocol permissions added
          const protocolNames = getProtocolNamesFromBitmask(
            integrationProgram,
            protocolBitflag,
            staging,
          );
          const addedPermissions = getPermissionNamesFromBitmask(
            integrationProgram,
            protocolBitflag,
            staged,
            staging,
          );

          if (addedPermissions.length > 0) {
            permissionChanges.push({
              integrationProgram,
              protocolName: protocolNames[0] || "Unknown",
              addedPermissions,
              removedPermissions: [],
            });
          }
        } else if (current && !staged) {
          // Protocol permissions removed
          const protocolNames = getProtocolNamesFromBitmask(
            integrationProgram,
            protocolBitflag,
            staging,
          );
          const removedPermissions = getPermissionNamesFromBitmask(
            integrationProgram,
            protocolBitflag,
            current,
            staging,
          );

          if (removedPermissions.length > 0) {
            permissionChanges.push({
              integrationProgram,
              protocolName: protocolNames[0] || "Unknown",
              addedPermissions: [],
              removedPermissions,
            });
          }
        } else if (current && staged && !current.eq(staged)) {
          // Protocol permissions modified
          const protocolNames = getProtocolNamesFromBitmask(
            integrationProgram,
            protocolBitflag,
            staging,
          );
          const currentPermissions = getPermissionNamesFromBitmask(
            integrationProgram,
            protocolBitflag,
            current,
            staging,
          );
          const stagedPermissions = getPermissionNamesFromBitmask(
            integrationProgram,
            protocolBitflag,
            staged,
            staging,
          );

          const addedPermissions = stagedPermissions.filter(
            (p) => !currentPermissions.includes(p),
          );
          const removedPermissions = currentPermissions.filter(
            (p) => !stagedPermissions.includes(p),
          );

          if (addedPermissions.length > 0 || removedPermissions.length > 0) {
            permissionChanges.push({
              integrationProgram,
              protocolName: protocolNames[0] || "Unknown",
              addedPermissions,
              removedPermissions,
            });
          }
        }
      });
    });

    // Check if there are any changes (expiration or permissions)
    if (
      !currentAcl.expiresAt.eq(stagedAcl.expiresAt) ||
      permissionChanges.length > 0
    ) {
      modified.push({
        pubkey: currentAcl.pubkey,
        currentExpiresAt: currentAcl.expiresAt,
        stagedExpiresAt: stagedAcl.expiresAt,
        permissionChanges,
      });
    }
  });

  return { added, removed, modified };
}
