import express from "express";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getSupabase } from "./supabase";
import { dashboardRouter } from "./dashboard";
import { hasValidSession } from "./auth";
import { verifyIngest, AUTH_HEADERS } from "./adapters";
import { getSource, sourceScheme, sourceSecret, SOURCE_PATTERN, validateDestination } from "./sources";
import type { SignatureScheme } from "./adapters";
import { asyncRoute } from "./asyncRoute";
import { gatewayMetrics, hasMetricsBearer } from "./metrics";
import { clientRetryAfterSeconds, recordClientAuthFailure, sourceRetryAfterSeconds } from "./ingestLimiter";
export { SOURCE_PATTERN } from "./sources";

// Chosen deliberately rather than inherited. express.json() defaults to 100 KB,
// which this project relied on by accident until it was measured; real providers
// occasionally exceed that. 1 MB accommodates them while still bounding how much
// memory one request can consume.
export const MAX_BODY_BYTES = 1024 * 1024;

// `source` is a label, not free text. It becomes half of the idempotency identity
// and appears in dashboard URLs, so it is constrained to characters that are
// unambiguous in both roles. Unvalidated, it accepted values like `../../etc`.


// Requests carry their raw bytes through for signature verification. The signature
// is computed over exactly what was sent — re-serialising the parsed object can
// reorder keys or alter whitespace and would break otherwise-valid signatures.
interface RawBodyRequest extends express.Request {
  rawBody?: string;
}

// Separate from index.ts so tests can import the app without starting a real server.
export const app = express();

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      // Keep HTTP localhost usable in development (including Safari).
      "upgrade-insecure-requests": process.env.NODE_ENV === "production" ? [] : null,
    },
  },
}));

// req.ip is the socket peer unless Express is told which proxies to trust. Behind
// a reverse proxy that is the proxy's address, so every client would share one
// login-throttle and ingest-limit bucket. TRUST_PROXY takes Express's forms:
// a hop count ("1"), "loopback", a CIDR or comma-separated list, or "true"
// (trust every X-Forwarded-For, only safe when nothing can reach the port
// directly). Unset means no proxy is trusted.
export function configureTrustProxy(target: express.Express, value: string | undefined): void {
  const v = (value ?? "").trim();
  if (v === "" || v.toLowerCase() === "false") { target.set("trust proxy", false); return; }
  if (v.toLowerCase() === "true") { target.set("trust proxy", true); return; }
  if (/^\d+$/.test(v)) { target.set("trust proxy", Number(v)); return; }
  target.set("trust proxy", v);
}
configureTrustProxy(app, process.env.TRUST_PROXY);

// Non-2xx ingest answers by status code, including the 400/413 the body parser
// produces before the route runs. Status codes only: no source or client labels.
app.use("/webhooks/:source", (_req, res, next) => {
  res.on("finish", () => {
    if (res.statusCode >= 300) gatewayMetrics.count("webhook_ingest_rejected_total", String(res.statusCode));
  });
  next();
});

app.use(
  express.json({
    limit: MAX_BODY_BYTES,
    verify: (req, _res, buf) => {
      (req as RawBodyRequest).rawBody = buf.toString("utf8");
    },
  })
);
app.use(cookieParser());

// Operational counts are private. A separate bearer token allows Prometheus
// to scrape without a dashboard cookie or a database round trip.
app.get("/metrics", asyncRoute(async (req, res) => {
  res.set("Cache-Control", "no-store");
  if (!hasMetricsBearer(req.header("Authorization")) && !await hasValidSession(req)) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  res.set("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
  return res.send(gatewayMetrics.render());
}));

// Readiness, not just process liveness. A zero-row query verifies the ingest
// columns (including migration 009's raw_body) without creating probe events.
// It does not prove INSERT grants, constraints or all worker RPCs are valid.
app.get("/health", asyncRoute(async (_req, res) => {
  try {
    const { error } = await getSupabase()
      .from("webhook_events")
      .select("id, source, idempotency_key, headers, payload, raw_body, status, destination_url")
      .limit(0)
      .abortSignal(AbortSignal.timeout(3_000));
    if (error) throw new Error(error.message);
    return res.json({ status: "ok" });
  } catch {
    // Do not expose database errors, credentials or schema details publicly.
    return res.status(503).json({ status: "unavailable" });
  }
}));

// Receives a webhook from an external provider and stores it for later delivery.
// Responds immediately — actual delivery is the delivery worker's job.
app.post("/webhooks/:source", asyncRoute(async (req, res) => {
  const source = req.params.source;
  const payload = req.body;

  if (!SOURCE_PATTERN.test(source)) {
    return res.status(400).json({
      error: "Source must be 1-64 characters of letters, digits, hyphen or underscore",
    });
  }

  // Only JSON is parsed. Anything else has no raw body to verify, so say so
  // instead of reporting a misleading signature failure.
  if (!req.is("application/json")) {
    return res.status(415).json({ error: "Content-Type must be application/json" });
  }

  // Limits are applied before the registry read so a flood never reaches the
  // database. A client that keeps failing authentication is answered first.
  const client = req.ip ?? "unknown";
  const clientWait = clientRetryAfterSeconds(client);
  if (clientWait > 0) {
    res.set("Retry-After", String(clientWait));
    return res.status(429).json({ error: "Too many failed requests, try again later" });
  }
  const sourceWait = sourceRetryAfterSeconds(source);
  if (sourceWait > 0) {
    res.set("Retry-After", String(sourceWait));
    return res.status(429).json({ error: "Rate limit exceeded for this source" });
  }

  const route = await getSource(source);
  if (!route || !route.enabled) {
    recordClientAuthFailure(client);
    return res.status(404).json({ error: "Source unavailable" });
  }
  // Configuration failures are 503, not an unsigned fallback. Never disclose
  // the environment variable name or secret to the caller.
  let signingSecret: string;
  let destinationUrl: string;
  let scheme: SignatureScheme;
  try {
    signingSecret = sourceSecret(route);
    destinationUrl = validateDestination(route.destination_url);
    scheme = sourceScheme(route);
  } catch {
    return res.status(503).json({ error: "Source unavailable" });
  }
  // Verified the way this source's provider signs (gateway, GitHub or Stripe).
  // The adapter also says which value dedupes a redelivery for that provider.
  const result = verifyIngest({
    scheme, secret: signingSecret,
    header: (name) => req.header(name),
    rawBody: (req as RawBodyRequest).rawBody ?? "",
    payload,
  });
  if (!result.ok) {
    console.warn(`[ingest] rejected ${source}: ${result.reason}`);
    recordClientAuthFailure(client);
    return res.status(401).json({ error: "Invalid signature" });
  }
  const idempotencyKey = result.idempotencyKey;

  if (!payload || typeof payload !== "object" || Array.isArray(payload) || Object.keys(payload).length === 0) {
    return res
      .status(400)
      .json({ error: "Request body must be a non-empty JSON object" });
  }

  // Generate the event ID before storage so the same ID is returned to the sender.
  const id = randomUUID();

  const { error } = await getSupabase()
    .from("webhook_events")
    .insert({
      id,
      source,
      idempotency_key: idempotencyKey,
      // Authentication material must not be retained in event history.
      headers: Object.fromEntries(Object.entries(req.headers).filter(([key]) =>
        !AUTH_HEADERS.includes(key))),
      payload,
      // Exact bytes received. The worker delivers these, so numbers beyond
      // 2^53 and the sender's formatting survive. Needs migrations/009.
      raw_body: (req as RawBodyRequest).rawBody ?? "",
      status: "pending",
      destination_url: destinationUrl,
    });

  if (error) {
    // 23505 is Postgres' unique_violation. Here it means the unique index on
    // (source, idempotency_key) rejected a webhook we already stored. Providers
    // redeliver routinely, so this is expected traffic, not a failure — we
    // acknowledge it so the provider stops retrying.
    if (error.code === "23505") {
      return res
        .status(200)
        .json({ status: "duplicate", message: "already received" });
    }

    return res.status(500).json({ error: "Failed to store webhook event" });
  }

  gatewayMetrics.increment("received", source, destinationUrl);
  return res.status(202).json({ id, status: "pending" });
}));

// Dashboard API. Mounted after the ingest routes so nothing here can shadow
// them, and before express.static so that a stray public/api/... file could
// never shadow the API. See Concepts/Express routing order.
app.use("/api", dashboardRouter);

// The dashboard page itself is served unprotected — it renders nothing until
// its first fetch, and a fetch without a session gets a 401 and bounces the
// browser to the login page. The session gate lives on the data, not the HTML.
// Resolves to <project>/public from both src/ (tsx) and dist/ (compiled).
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/", asyncRoute(async (req, res) => {
  res.redirect(await hasValidSession(req) ? "/dashboard.html" : "/login.html");
}));

// Catch-all error handler. Every error ends up here — nothing falls through to
// Express's default HTML handler, which would leak a stack trace (and absolute
// filesystem paths) to the client. Full detail goes to the server log instead.
app.use(
  (
    err: Error & { status?: number; statusCode?: number },
    _req: express.Request,
    res: express.Response,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _next: express.NextFunction
  ) => {
    const status = err.status || err.statusCode || 500;
    const message =
      status === 400
        ? "Invalid JSON body"
        : status === 413
          ? "Payload too large"
          : "Internal server error";
    console.error(err);
    res.status(status).json({ error: message });
  }
);
