import { env } from "../src/lib/env";

console.log("Verifying Environment Variables:");
console.log(`AI_DETAIL_EVAL_MODEL: ${env.aiDetailEvalModel}`);
console.log(`FALLBACK_AI_DETAIL_EVAL_MODEL: ${env.fallbackAiDetailEvalModel}`);

if (env.fallbackAiDetailEvalModel === "glm-4.5-Air") {
  console.log("SUCCESS: Fallback model is correctly loaded.");
} else {
  console.error(`FAILURE: Fallback model verification failed.`);
  console.error(
    `Expected FALLBACK: 'glm-4.5-Air', Got: '${env.fallbackAiDetailEvalModel}'`
  );
  process.exit(1);
}
