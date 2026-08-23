// Public tunnel to the local ingest server.
//
// Tool: localtunnel. Cloudflare quick tunnels would have been the better choice
// (no interstitial, more reliable), but `cloudflared` is not installed on this
// machine and installing it needs a system package manager and sudo, which is
// out of scope here. localtunnel is a plain npm dependency with a programmatic
// Node API and no signup, so it works with what's actually available.
//
// The caveat that comes with that choice: loca.lt shows a one-time "click to
// continue" interstitial page to a visitor's IP the first time it sees it. A
// browser gets past it with one click; a fully automated sender like Stripe
// hitting the URL directly can receive that HTML page instead of reaching the
// gateway. Sending the `bypass-tunnel-reminder` header (any value) skips it,
// and so does visiting the URL once in a browser from the same IP. Documented
// in the README.
import localtunnel from "localtunnel";

export interface TunnelHandle {
  url: string;
  close(): Promise<void>;
}

export async function openTunnel(port: number): Promise<TunnelHandle> {
  const tunnel = await localtunnel({ port });

  // A tunnel can drop long after it opened (loca.lt restarting, network blip).
  // Without a listener that surfaces as an unhandled 'error' event, which kills
  // the whole process — taking the ingest server down with it over something
  // that is only a development convenience. Log it and keep serving locally.
  tunnel.on("error", (err: Error) => {
    console.error(`[tunnel] error: ${err.message}`);
  });

  return {
    url: tunnel.url,
    close: async () => {
      tunnel.close();
    },
  };
}
