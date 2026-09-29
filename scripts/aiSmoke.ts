import assert from "assert";
import { accountIdFrom, needsRefresh } from "../src/lib/codexAuth";
import { evaluateJobDetail, findIrrelevantJobIds, jevJudgment, route } from "../src/lib/aiEvaluator";

// Offline checks, then a live check of the title filter and the final decision.
(async () => {
  const jwt = (claims: object) => `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;
  assert.strictEqual(
    accountIdFrom({ access_token: "x", id_token: jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acc-1" } }) }),
    "acc-1"
  );
  const auth = { access: "a", refresh: "r", accountId: "acc-1" };
  assert.ok(needsRefresh({ ...auth, expires: Date.now() + 60_000 }), "token inside margin must refresh");
  assert.ok(!needsRefresh({ ...auth, expires: Date.now() + 3_600_000 }), "fresh token must not refresh");
  const j = jevJudgment({ choice: "accept", probabilities: { accept: 0.4, seniority: 0.35, non_us: 0.25 } }, "accept");
  assert.strictEqual(j.reason, "Jev: seniority (p=0.60)", "reject odds sum every reason");
  assert.strictEqual(route(0.9, true), "reject");
  assert.strictEqual(route(0.1, true), "pass");
  assert.strictEqual(route(0.6, true), "unsure", "unsure band goes to the model");
  assert.strictEqual(route(0.6, false), "reject", "without a model Jev decides at 0.5");

  const titles = await findIrrelevantJobIds([
    { title: "React Developer", company: "Acme", location: "Remote", url: "https://example.com/1", job_id: "keep-1" },
    { title: "Registered Nurse - ICU", company: "Mercy", location: "Dallas, TX", url: "https://example.com/2", job_id: "drop-1" },
  ]);
  console.log("Title filter:", [...titles.reasons]);
  assert.ok(titles.removalSet.has("drop-1"), "nurse role should be filtered out");
  assert.ok(!titles.removalSet.has("keep-1"), "React role should be kept");

  const detail = await evaluateJobDetail({
    title: "Full Stack Developer (React/Node.js)",
    company: "Acme",
    location: "Remote, US",
    url: "https://example.com/3",
    description: "C2C contract, 12 months, remote. React, TypeScript, Node.js/Express, AWS. Corp-to-corp accepted.",
  });
  console.log("Detail eval:", detail);
  assert.strictEqual(typeof detail.accepted, "boolean");
  console.log("AI smoke passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
