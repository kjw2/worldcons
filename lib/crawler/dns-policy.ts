import dns from "node:dns";

export function applyIpv4FirstForSource(sourceKey?: string) {
  const enabled =
    sourceKey === "de-bverfg" &&
    (process.env.BVERFG_USE_IPV4_FIRST ?? "true").toLowerCase() !== "false" &&
    !process.execArgv.some((arg) => arg.includes("--dns-result-order"));

  if (enabled) {
    dns.setDefaultResultOrder("ipv4first");
  }

  return enabled;
}
