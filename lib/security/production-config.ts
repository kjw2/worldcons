const REQUIRED_PRODUCTION_SECRET_NAMES = [
  "ADMIN_PASSWORD",
  "ADMIN_SESSION_SECRET",
  "CRON_SECRET",
  "LLM_SETTINGS_SECRET",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;

export function validateProductionSecurityConfig(env: Record<string, string | undefined> = process.env) {
  const errors: string[] = [];
  if (env.NODE_ENV !== "production") {
    return { ok: true, errors };
  }

  const values = new Map<string, string>();
  for (const name of REQUIRED_PRODUCTION_SECRET_NAMES) {
    const value = env[name]?.trim();
    if (!value) {
      errors.push(`${name} is required in production.`);
      continue;
    }

    if (Buffer.byteLength(value, "utf8") < 32) {
      errors.push(`${name} must be at least 32 bytes long in production.`);
    }

    values.set(name, value);
  }

  const seen = new Map<string, string>();
  for (const [name, value] of values) {
    const previousName = seen.get(value);
    if (previousName) {
      errors.push(`${name} must not reuse the same value as ${previousName}.`);
    } else {
      seen.set(value, name);
    }
  }

  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith("NEXT_PUBLIC_") || !value) {
      continue;
    }

    if (/(SERVICE_ROLE|SECRET|ADMIN_PASSWORD)/i.test(name)) {
      errors.push(`${name} must not expose a server-side secret.`);
      continue;
    }

    const matchedSecretName = [...values.entries()].find(([, secretValue]) => value === secretValue)?.[0];
    if (matchedSecretName) {
      errors.push(`${name} must not expose ${matchedSecretName}.`);
    }
  }

  return { ok: errors.length === 0, errors };
}

export function assertProductionSecurityConfig(env: Record<string, string | undefined> = process.env) {
  const result = validateProductionSecurityConfig(env);
  if (!result.ok) {
    throw new Error(`Production security configuration is invalid:\n- ${result.errors.join("\n- ")}`);
  }
}
