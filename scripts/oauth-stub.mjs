// Local stand-in for SnapTrade's OAuth 2.0 + OIDC endpoints, for tests and for
// exercising sign-in without a registered OAuth app. It mirrors the documented
// contract: discovery, authorization code + PKCE (S256), HTTP Basic client
// auth, RS256 id_tokens, rotating refresh tokens, and revocation.
// It is never used by a deployed app: point SNAPTRADE_ISSUER at it locally.
//
//   node scripts/oauth-stub.mjs   # http://127.0.0.1:4010
//   POST /__stub/deny-next        # next authorization is denied
//   POST /__stub/revoke-all       # every refresh token becomes invalid_grant
//   GET  /__stub/stats            # request counters

import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

import { SignJWT, exportJWK, generateKeyPair } from "jose";

export const STUB_USER = {
  sub: "00000000-0000-4000-8000-000000000001",
  email: "stub-user@example.com",
  email_verified: true,
  name: "Stub User",
};

const token = () => randomBytes(24).toString("base64url");

export async function startOAuthStub({
  port = 0,
  clientId,
  clientSecret,
  redirectUri,
  accessTtlSeconds = 36_000,
  refreshDelayMs = 0,
}) {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const kid = "stub-key-1";
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" };
  const basic = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
  const codes = new Map();
  const refreshTokens = new Map();
  const stats = { authorize: 0, token: 0, refresh: 0, revoke: 0 };
  let denyNext = false;
  let issuer = "";

  const json = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  const readForm = async (req) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    return new URLSearchParams(body);
  };
  const issueTokens = (scope) => {
    const refresh = token();
    refreshTokens.set(refresh, { scope });
    return {
      access_token: token(),
      refresh_token: refresh,
      expires_in: accessTtlSeconds,
      token_type: "Bearer",
      scope,
    };
  };

  async function handle(req, res) {
    const url = new URL(req.url, issuer);
    switch (`${req.method} ${url.pathname}`) {
      case "GET /.well-known/openid-configuration":
        return json(res, 200, {
          issuer,
          authorization_endpoint: `${issuer}/oauth/authorize`,
          token_endpoint: `${issuer}/oauth/token/`,
          revocation_endpoint: `${issuer}/oauth/revoke_token/`,
          jwks_uri: `${issuer}/.well-known/jwks.json`,
          scopes_supported: ["openid", "profile", "email", "read", "trade", "webhook"],
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          authorization_response_iss_parameter_supported: true,
          token_endpoint_auth_methods_supported: ["client_secret_basic"],
          id_token_signing_alg_values_supported: ["RS256"],
        });

      case "GET /.well-known/jwks.json":
        return json(res, 200, { keys: [jwk] });

      case "GET /oauth/authorize": {
        stats.authorize++;
        const q = url.searchParams;
        // Like a real provider, never redirect to an unregistered redirect_uri.
        if (q.get("client_id") !== clientId || q.get("redirect_uri") !== redirectUri) {
          return json(res, 400, { error: "invalid_request" });
        }
        const back = new URL(redirectUri);
        back.searchParams.set("state", q.get("state") ?? "");
        back.searchParams.set("iss", issuer);
        const scope = q.get("scope") ?? "";
        const valid =
          q.get("response_type") === "code" &&
          q.get("code_challenge_method") === "S256" &&
          q.get("code_challenge") &&
          scope.split(" ").includes("read");
        if (!valid) {
          back.searchParams.set("error", "invalid_request");
        } else if (denyNext) {
          denyNext = false;
          back.searchParams.set("error", "access_denied");
        } else {
          const code = token();
          codes.set(code, {
            challenge: q.get("code_challenge"),
            nonce: q.get("nonce"),
            scope,
            expiresAt: Date.now() + 60_000,
          });
          back.searchParams.set("code", code);
        }
        res.writeHead(302, { location: back.toString() });
        return res.end();
      }

      case "POST /oauth/token/": {
        if (req.headers.authorization !== basic) return json(res, 401, { error: "invalid_client" });
        const form = await readForm(req);
        if (form.get("grant_type") === "authorization_code") {
          stats.token++;
          const code = form.get("code") ?? "";
          const entry = codes.get(code);
          codes.delete(code);
          const challenge = createHash("sha256")
            .update(form.get("code_verifier") ?? "")
            .digest("base64url");
          if (
            !entry ||
            entry.expiresAt < Date.now() ||
            form.get("redirect_uri") !== redirectUri ||
            challenge !== entry.challenge
          ) {
            return json(res, 400, { error: "invalid_grant" });
          }
          const now = Math.floor(Date.now() / 1000);
          const { sub, ...profile } = STUB_USER;
          const idToken = await new SignJWT({ ...profile, nonce: entry.nonce, auth_time: now })
            .setProtectedHeader({ alg: "RS256", kid })
            .setIssuer(issuer)
            .setSubject(sub)
            .setAudience(clientId)
            .setIssuedAt(now)
            .setExpirationTime(now + 600)
            .sign(privateKey);
          return json(res, 200, { ...issueTokens(entry.scope), id_token: idToken });
        }
        if (form.get("grant_type") === "refresh_token") {
          stats.refresh++;
          await new Promise((resolve) => setTimeout(resolve, refreshDelayMs));
          const refresh = form.get("refresh_token") ?? "";
          const entry = refreshTokens.get(refresh);
          if (!entry) return json(res, 400, { error: "invalid_grant" });
          refreshTokens.delete(refresh);
          return json(res, 200, issueTokens(entry.scope));
        }
        return json(res, 400, { error: "unsupported_grant_type" });
      }

      case "POST /oauth/revoke_token/": {
        if (req.headers.authorization !== basic) return json(res, 401, { error: "invalid_client" });
        stats.revoke++;
        refreshTokens.delete((await readForm(req)).get("token") ?? "");
        return json(res, 200, {});
      }

      case "POST /__stub/deny-next":
        denyNext = true;
        return json(res, 200, { denyNext });

      case "POST /__stub/revoke-all":
        refreshTokens.clear();
        return json(res, 200, {});

      case "GET /__stub/stats":
        return json(res, 200, stats);

      default:
        return json(res, 404, { error: "not_found" });
    }
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(() => json(res, 500, { error: "server_error" }));
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  issuer = `http://127.0.0.1:${server.address().port}`;

  return {
    issuer,
    stats,
    denyNextAuthorization: () => {
      denyNext = true;
    },
    revokeAllRefreshTokens: () => refreshTokens.clear(),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const stub = await startOAuthStub({
    port: Number(process.env.STUB_PORT ?? 4010),
    clientId: process.env.SNAPTRADE_OAUTH_CLIENT_ID ?? "stub-client",
    clientSecret: process.env.SNAPTRADE_OAUTH_CLIENT_SECRET ?? "stub-secret",
    redirectUri:
      process.env.SNAPTRADE_OAUTH_REDIRECT_URI ?? "http://127.0.0.1:3000/api/auth/callback",
    accessTtlSeconds: Number(process.env.STUB_ACCESS_TTL_SECONDS ?? 36_000),
  });
  console.log(`Stub SnapTrade OAuth provider listening at ${stub.issuer}`);
}
