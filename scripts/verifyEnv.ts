import { env } from "../src/lib/env";

console.log("Verifying Environment Variables:");
console.log(`AI_PROVIDER: ${env.aiProvider}`);
console.log(`TYPESAFE_API_KEY: ${env.typesafeApiKey ? "set" : "MISSING"}`);

const validProviders = ["none", "codex", "deepinfra", "gemini"];
if (!validProviders.includes(env.aiProvider)) {
  console.error(
    `FAILURE: AI_PROVIDER must be one of: ${validProviders.join(", ")}. Got: '${env.aiProvider}'`
  );
  process.exit(1);
}
if (!env.typesafeApiKey) {
  console.error("FAILURE: TYPESAFE_API_KEY is required for the Jev final decision.");
  process.exit(1);
}

console.log("SUCCESS: Environment variables are correctly loaded.");
