import { execFile } from "child_process";
import crypto from "crypto";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { ConfigError } from "./env";

// ChatGPT OAuth (PKCE), same flow as the Codex CLI and OpenCode.
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const ISSUER = "https://auth.openai.com";
const PORT = 1455;
const REDIRECT_URI = `http://localhost:${PORT}/auth/callback`;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

const AUTH_FILE = path.join(os.homedir(), ".personal_job_scrapper", "auth.json");

export interface StoredAuth {
  access: string;
  refresh: string;
  expires: number;
  accountId: string;
}

interface TokenResponse {
  id_token?: string;
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

export interface CodexCredentials {
  accessToken: string;
  accountId: string;
}

/* ── Token helpers ── */

function jwtClaims(token: string | undefined): Record<string, any> {
  try {
    return JSON.parse(Buffer.from(token!.split(".")[1], "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

export function accountIdFrom(tokens: TokenResponse): string | undefined {
  for (const token of [tokens.id_token, tokens.access_token]) {
    const c = jwtClaims(token);
    const id =
      c.chatgpt_account_id ??
      c["https://api.openai.com/auth"]?.chatgpt_account_id ??
      c.organizations?.[0]?.id;
    if (id) return id;
  }
  return undefined;
}

export function needsRefresh(auth: StoredAuth, now = Date.now()): boolean {
  return auth.expires - REFRESH_MARGIN_MS <= now;
}

async function tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, ...params }).toString(),
  });
  if (!res.ok) {
    throw new Error(`ChatGPT token request failed (${res.status}). Run \`pnpm auth:login\` again.`);
  }
  return res.json() as Promise<TokenResponse>;
}

function save(tokens: TokenResponse, previous?: StoredAuth): StoredAuth {
  const accountId = accountIdFrom(tokens) ?? previous?.accountId;
  if (!accountId) throw new Error("ChatGPT login returned no account id.");
  const auth: StoredAuth = {
    access: tokens.access_token,
    refresh: tokens.refresh_token ?? previous!.refresh,
    expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    accountId,
  };
  fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2), { mode: 0o600 });
  return auth;
}

function load(): StoredAuth {
  if (!fs.existsSync(AUTH_FILE)) {
    throw new ConfigError("Not logged in to ChatGPT. Run `pnpm auth:login` first.");
  }
  return JSON.parse(fs.readFileSync(AUTH_FILE, "utf8"));
}

/* ── Runtime ── */

let inFlight: Promise<StoredAuth> | null = null;

export async function getCodexCredentials(): Promise<CodexCredentials> {
  let auth = load();
  if (needsRefresh(auth)) {
    const current = auth;
    inFlight ??= tokenRequest({ grant_type: "refresh_token", refresh_token: current.refresh })
      .then((tokens) => save(tokens, current))
      .finally(() => (inFlight = null));
    auth = await inFlight;
  }
  return { accessToken: auth.access, accountId: auth.accountId };
}

/* ── Browser login ── */

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  execFile(cmd, [url], () => undefined);
}

export async function login(): Promise<void> {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const state = crypto.randomBytes(32).toString("base64url");

  const authUrl = `${ISSUER}/oauth/authorize?${new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: "openid profile email offline_access",
    code_challenge: challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: "codex_cli_rs",
  })}`;

  const code = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", REDIRECT_URI);
      if (url.pathname !== "/auth/callback") {
        res.writeHead(404).end();
        return;
      }
      const got = url.searchParams.get("code");
      const error = url.searchParams.get("error_description") ?? url.searchParams.get("error");
      const ok = !!got && url.searchParams.get("state") === state;
      res
        .writeHead(ok ? 200 : 400, { "Content-Type": "text/html" })
        .end(ok ? "<h1>Logged in. You can close this tab.</h1>" : "<h1>Login failed.</h1>");
      clearTimeout(timer);
      server.close();
      if (ok) resolve(got!);
      else reject(new Error(error ?? "Invalid OAuth callback (state mismatch or missing code)."));
    });
    const timer = setTimeout(() => {
      server.close();
      reject(new Error("Login timed out after 5 minutes."));
    }, LOGIN_TIMEOUT_MS);
    server.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Cannot listen on port ${PORT} (${err.message}). Close other logins and retry.`));
    });
    server.listen(PORT, () => {
      console.log(`Opening browser to sign in with ChatGPT...\nIf it doesn't open, visit:\n${authUrl}\n`);
      openBrowser(authUrl);
    });
  });

  const tokens = await tokenRequest({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  });
  save(tokens);
  const email = jwtClaims(tokens.id_token).email;
  console.log(`Logged in to ChatGPT${email ? ` as ${email}` : ""}. Saved to ${AUTH_FILE}`);
}

export function status(): void {
  if (!fs.existsSync(AUTH_FILE)) {
    console.log("Not logged in. Run `pnpm auth:login`.");
    return;
  }
  const auth = load();
  const state = needsRefresh(auth) ? "access token expired (refreshes on next run)" : "active";
  console.log(`Logged in to ChatGPT (${state}). Account ${auth.accountId}.`);
}

if (require.main === module) {
  const cmd = process.argv[2];
  if (cmd === "login") {
    login().catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
  } else if (cmd === "status") {
    status();
  } else if (cmd === "logout") {
    fs.rmSync(AUTH_FILE, { force: true });
    console.log("Logged out.");
  } else {
    console.error("Usage: codexAuth.ts login | status | logout");
    process.exit(1);
  }
}
