import { env } from "../src/lib/env";

console.log("Verifying Environment Variables:");
console.log(`AI_DETAIL_EVAL_MODEL: ${env.aiDetailEvalModel}`);
console.log(`FALLBACK_AI_DETAIL_EVAL_MODEL: ${env.fallbackAiDetailEvalModel}`);
console.log(
  `SECOND_FALLBACK_AI_DETAIL_EVAL_MODEL: ${env.secondFallbackAiDetailEvalModel}`
);

if (
  env.fallbackAiDetailEvalModel === "gemini-3.0-flash-preview" &&
  env.secondFallbackAiDetailEvalModel === "glm-4.5-Air"
) {
  console.log("SUCCESS: Fallback models are correctly loaded.");
} else {
  console.error(`FAILURE: Fallback models verification failed.`);
  console.error(
    `Expected FALLBACK: 'gemini-3.0-flash-preview', Got: '${env.fallbackAiDetailEvalModel}'`
  );
  console.error(
    `Expected SECOND FALLBACK: 'glm-4.5-Air', Got: '${env.secondFallbackAiDetailEvalModel}'`
  );
  process.exit(1);
}
