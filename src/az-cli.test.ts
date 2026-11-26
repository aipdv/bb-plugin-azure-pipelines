import assert from "node:assert/strict";
import test from "node:test";
import { azCandidates, getAzBearerToken, parseAzDevopsDefaults, parseAzTokenJson } from "./az-cli";

test("runs az through its bundled python on Windows and directly elsewhere", () => {
  const [first] = azCandidates("win32", { ProgramFiles: "C:\\Program Files" });
  assert.match(first?.[0] ?? "", /Microsoft SDKs[\\/]Azure[\\/]CLI2[\\/]python\.exe$/);
  assert.deepEqual(first?.[1], ["-IBm", "azure.cli"]);
  assert.deepEqual(azCandidates("darwin", {})[0], ["/opt/homebrew/bin/az", []]);
});

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
