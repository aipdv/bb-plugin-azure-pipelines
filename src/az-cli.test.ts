import assert from "node:assert/strict";
import test from "node:test";
import { getAzBearerToken, parseAzDevopsDefaults, parseAzTokenJson } from "./az-cli";

test("reads the az devops default organization and project", () => {
  const parsed = parseAzDevopsDefaults(`
[defaults]
organization = https://dev.azure.com/acme-org
project = 00000000-0000-0000-0000-000000000001
`);
  assert.deepEqual(parsed, {
    organization: "acme-org",
    project: "00000000-0000-0000-0000-000000000001",
  });
});

test("parses an access token and ignores the raw secret in errors", async () => {
  const token = `eyJ${"a".repeat(30)}.bbb.ccc`;
  const parsed = parseAzTokenJson(
    JSON.stringify({ accessToken: token, expires_on: 2_000 }),
    0,
  );
  assert.equal(parsed?.token, token);
  assert.equal(parsed?.expiresAt, 2_000_000);

  const outcome = await getAzBearerToken(new AbortController().signal, async () => ({
    stdout: "not-json",
    stderr: `login failed ${token}`,
  }));
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.message.includes(token), false);
});
