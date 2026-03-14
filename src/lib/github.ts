import crypto from "crypto";
import { Octokit } from "octokit";

const GITHUB_APP_ID = process.env.GITHUB_APP_ID!;
const GITHUB_APP_PRIVATE_KEY = process.env.GITHUB_APP_PRIVATE_KEY!;
const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET!;

/**
 * Verify GitHub webhook signature using HMAC SHA-256 and timing-safe comparison.
 */
export function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string = GITHUB_WEBHOOK_SECRET
): boolean {
  const expected =
    "sha256=" +
    crypto.createHmac("sha256", secret).update(payload, "utf8").digest("hex");

  if (signature.length !== expected.length) {
    return false;
  }

  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expected)
  );
}

/**
 * Create an authenticated Octokit instance for a given GitHub App installation.
 * Uses the App's private key to mint a short-lived installation access token.
 */
export async function getInstallationOctokit(
  installationId: number
): Promise<Octokit> {
  // Build a JWT for the GitHub App
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ iat: now - 60, exp: now + 600, iss: GITHUB_APP_ID })
  ).toString("base64url");

  const signing = crypto.createSign("RSA-SHA256");
  signing.update(`${header}.${payload}`);
  const jwtSignature = signing.sign(GITHUB_APP_PRIVATE_KEY, "base64url");
  const jwt = `${header}.${payload}.${jwtSignature}`;

  // Exchange JWT for an installation access token
  const appOctokit = new Octokit({ auth: jwt });
  const { data } = await appOctokit.rest.apps.createInstallationAccessToken({
    installation_id: installationId,
  });

  return new Octokit({ auth: data.token });
}

/**
 * Post a comment on a GitHub issue (or pull request).
 */
export async function postIssueComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
  body: string
): Promise<void> {
  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body,
  });
}

/**
 * Create a pull request.
 */
export async function createPullRequest(
  octokit: Octokit,
  owner: string,
  repo: string,
  params: { title: string; head: string; base: string; body?: string }
): Promise<{ number: number; html_url: string }> {
  const { data } = await octokit.rest.pulls.create({
    owner,
    repo,
    ...params,
  });

  return { number: data.number, html_url: data.html_url };
}
