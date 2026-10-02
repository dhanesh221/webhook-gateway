import request from "supertest";
import { buildSignatureHeader, SIGNATURE_HEADER } from "../src/signature";
export const TEST_SOURCE_SECRET = "test-only-source-secret-at-least-32-bytes";
// Existing pipeline tests now exercise signed ingest instead of the retired
// unsigned mode. Explicit signature tests use ordinary supertest directly.
export default function signedRequest(app: Parameters<typeof request>[0]) {
  const agent = request(app);
  const originalPost = agent.post.bind(agent);
  agent.post = ((url: string) => {
    const test = originalPost(url);
    if (url.startsWith("/webhooks/")) {
      const send = test.send.bind(test);
      test.send = ((body: string | object | undefined) => {
        const raw = typeof body === "string" ? body : JSON.stringify(body);
        test.set(SIGNATURE_HEADER, buildSignatureHeader(TEST_SOURCE_SECRET, Math.floor(Date.now()/1000), raw));
        return send(body);
      }) as typeof test.send;
    }
    return test;
  }) as typeof agent.post;
  return agent;
}
