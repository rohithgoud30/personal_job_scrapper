import { env } from "../src/lib/env";

console.log("Verifying Environment Variables:");
console.log(`AI_MODEL: ${env.aiModel}`);
console.log(`AI_BASE_URL: ${env.aiBaseUrl}`);
console.log(`GEMINI_MODEL: ${env.geminiModel}`);
console.log(`AI_DEFAULT_PROVIDER: ${env.aiDefaultProvider}`);

const validProviders = ["deepinfra", "gemini", "both"];
if (!validProviders.includes(env.aiDefaultProvider)) {
  console.error(
    `FAILURE: AI_DEFAULT_PROVIDER must be one of: ${validProviders.join(", ")}. Got: '${env.aiDefaultProvider}'`
  );
  process.exit(1);
}

console.log("SUCCESS: Environment variables are correctly loaded.");
