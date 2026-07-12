import { createHash } from "@/lib/utils/hash";
import { P5_OWNER_ROLES, type P5OwnerRole } from "@/lib/admin/p5/types";

export const P5_OWNER_BINDING_ENV_NAMES: Record<P5OwnerRole, { identities: string; actorHashes: string }> = {
  operations: { identities: "ADMIN_P5_OWNER_OPERATIONS_IDENTITIES", actorHashes: "ADMIN_P5_OWNER_OPERATIONS_ACTOR_HASHES" },
  data: { identities: "ADMIN_P5_OWNER_DATA_IDENTITIES", actorHashes: "ADMIN_P5_OWNER_DATA_ACTOR_HASHES" },
  security: { identities: "ADMIN_P5_OWNER_SECURITY_IDENTITIES", actorHashes: "ADMIN_P5_OWNER_SECURITY_ACTOR_HASHES" },
};

function boundedList(value: string | undefined) {
  if (!value || value.length > 4096) return [];
  return Array.from(new Set(value.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0 && entry.length <= 160))).slice(0, 20);
}

export function p5GovernanceActorHash(identity: string) {
  return createHash(`p5-governance:${identity}`, 64);
}

export interface P5OwnerBindingResolution {
  valid: boolean;
  configuredRoles: P5OwnerRole[];
  permittedRoles: P5OwnerRole[];
}

export function resolveP5OwnerRoleBindings(
  identity: string,
  environment: Record<string, string | undefined> = process.env,
): P5OwnerBindingResolution {
  const roleActors = new Map<P5OwnerRole, Set<string>>();
  const actorRoles = new Map<string, Set<P5OwnerRole>>();
  let malformed = false;

  for (const role of P5_OWNER_ROLES) {
    const names = P5_OWNER_BINDING_ENV_NAMES[role];
    const actors = new Set<string>();
    for (const configuredIdentity of boundedList(environment[names.identities])) {
      actors.add(p5GovernanceActorHash(configuredIdentity));
    }
    for (const configuredHash of boundedList(environment[names.actorHashes])) {
      if (!/^[0-9a-f]{64}$/.test(configuredHash)) malformed = true;
      else actors.add(configuredHash);
    }
    roleActors.set(role, actors);
    for (const actor of actors) {
      const roles = actorRoles.get(actor) ?? new Set<P5OwnerRole>();
      roles.add(role);
      actorRoles.set(actor, roles);
    }
  }

  const hasCrossRoleActor = [...actorRoles.values()].some((roles) => roles.size > 1);
  const valid = !malformed && !hasCrossRoleActor;
  const actorHash = p5GovernanceActorHash(identity);
  return {
    valid,
    configuredRoles: P5_OWNER_ROLES.filter((role) => (roleActors.get(role)?.size ?? 0) > 0),
    permittedRoles: valid ? P5_OWNER_ROLES.filter((role) => roleActors.get(role)?.has(actorHash)) : [],
  };
}
