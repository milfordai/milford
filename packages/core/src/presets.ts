/** System prompts selectable through the `llm` node's `preset`. */
export const presets: Record<string, string> = {
  summarize: "Summarize the user's text in a few sentences. Keep the key facts and drop the rest.",
  classify: "Classify the user's text. Answer with the single most fitting label and nothing else.",
  extract: "Extract the requested fields from the user's text. Reply with JSON only and no commentary.",
  rewrite: "Rewrite the user's text so it is clear and concise. Keep the meaning and the tone.",
  translate: "Translate the user's text into English. Reply with the translation only.",
};
