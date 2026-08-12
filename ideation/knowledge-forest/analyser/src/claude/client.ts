import Anthropic from "@anthropic-ai/sdk";

export interface ClaudeCaller {
  (systemPrompt: string, userContent: string): Promise<string>;
}

/**
 * Thin wrapper so the rest of the pipeline depends on `ClaudeCaller`
 * (a plain function type), not the SDK directly — makes every other
 * module trivially testable with a fake, without touching the network.
 * See test/buildPrompt.test.ts and test/merge.test.ts for the pattern.
 */
export function createClaudeCaller(apiKey = process.env.ANTHROPIC_API_KEY, model = "claude-sonnet-5"): ClaudeCaller {
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. This pipeline calls the Anthropic API directly and deliberately requires " +
        "an explicit, human-provided key — see PLAN.md 'Privacy boundary.' It will never run implicitly."
    );
  }
  const client = new Anthropic({ apiKey });

  return async (systemPrompt: string, userContent: string): Promise<string> => {
    const response = await client.messages.create({
      model,
      max_tokens: 8192,
      system: systemPrompt,
      messages: [{ role: "user", content: userContent }]
    });
    const textBlock = response.content.find((block) => block.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new Error("Claude response contained no text block.");
    }
    return textBlock.text;
  };
}
