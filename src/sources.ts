import { getSupabase } from "./supabase";
import { DEFAULT_SIGNATURE_SCHEME, isSignatureScheme, SIGNATURE_SCHEMES, type SignatureScheme } from "./adapters";

export const SOURCE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const SECRET_ENV_PATTERN = /^WG_SOURCE_[A-Z0-9_]+_SECRET$/;
export interface SourceConfig {
  name: string;
  destination_url: string;
  secret_env: string;
  enabled: boolean;
  // Absent on rows read from a database without migration 011: means gateway.
  signature_scheme?: string | null;
}

// How this source's sender signs. Rows from before migration 011 carry no
// scheme and keep the gateway protocol; an unknown value is a configuration
// fault (503 at ingest), never a fallback to a weaker check.
export function sourceScheme(source: SourceConfig): SignatureScheme {
  const scheme = source.signature_scheme ?? DEFAULT_SIGNATURE_SCHEME;
  if (!isSignatureScheme(scheme)) throw new Error("Unknown signature scheme");
  return scheme;
}

// Routes are operator-controlled, never taken from webhook payloads. This is
// not an SSRF sandbox: do not give untrusted tenants access to source management.
export function validateDestination(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.hash || !url.hostname) {
    throw new Error("Destination must not contain credentials or a fragment");
  }
  if (url.protocol !== "https:" &&
      !(process.env.NODE_ENV !== "production" && url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
    throw new Error("Destination requires HTTPS (loopback HTTP allowed outside production)");
  }
  return url.toString();
}

export async function getSource(name: string): Promise<SourceConfig | null> {
  const { data, error } = await getSupabase().rpc("get_webhook_source", { p_name: name });
  if (error) throw new Error("Failed to read source registry");
  const row = (Array.isArray(data) ? data[0] : data) as SourceConfig | undefined;
  return row ?? null;
}

export function sourceSecret(source: SourceConfig): string {
  if (!SECRET_ENV_PATTERN.test(source.secret_env)) throw new Error("Invalid source secret reference");
  const secret = process.env[source.secret_env];
  if (!secret || Buffer.byteLength(secret) < 32) throw new Error("Source signing secret missing or too short");
  return secret;
}

export async function saveSource(
  name: string, destination: string, secretEnv: string, scheme: string = DEFAULT_SIGNATURE_SCHEME
) {
  if (!SOURCE_PATTERN.test(name)) throw new Error("Invalid source name");
  if (!isSignatureScheme(scheme)) {
    throw new Error(`Invalid signature scheme; expected one of: ${SIGNATURE_SCHEMES.join(", ")}`);
  }
  const config = {
    name, destination_url: validateDestination(destination), secret_env: secretEnv, enabled: true,
    signature_scheme: scheme,
  };
  sourceSecret(config); // fail before registering an unusable route
  // Needs migration 011 (4-argument upsert_webhook_source).
  const { error } = await getSupabase().rpc("upsert_webhook_source", {
    p_name: name, p_destination_url: config.destination_url, p_secret_env: secretEnv, p_signature_scheme: scheme,
  });
  if (error) throw new Error("Failed to save source");
}

export async function listSources(): Promise<SourceConfig[]> {
  const { data, error } = await getSupabase().rpc("list_webhook_sources");
  if (error) throw new Error("Failed to list sources");
  return data ?? [];
}

export async function disableSource(name: string) {
  if (!SOURCE_PATTERN.test(name)) throw new Error("Invalid source name");
  const { data, error } = await getSupabase().rpc("disable_webhook_source", { p_name: name });
  if (error) throw new Error("Failed to disable source");
  if (!data) throw new Error("Source not found");
}
