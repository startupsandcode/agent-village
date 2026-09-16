type OpenAIResponse = {
  status?: string;
  incomplete_details?: { reason?: string } | null;
  output?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string }>;
  }>;
};

export async function askPersona(text: string, instructions: string, apiKey: string, model: string) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      instructions,
      input: text,
      max_output_tokens: 350,
      store: false,
    }),
    signal: AbortSignal.timeout(25000),
  });

  if (!response.ok) throw new Error(`OpenAI returned ${response.status}`);

  const data = (await response.json()) as OpenAIResponse;
  if (data.status !== "completed") {
    throw new Error(`OpenAI response was ${data.status ?? "unknown"}: ${data.incomplete_details?.reason ?? "no reason"}`);
  }
  const answer = data.output
    ?.flatMap((item) => item.type === "message" ? item.content ?? [] : [])
    .filter((part) => part.type === "output_text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();

  if (!answer) throw new Error("OpenAI returned no text");
  return answer;
}
