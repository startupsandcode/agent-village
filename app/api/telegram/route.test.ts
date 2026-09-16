import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { POST } from "./route.ts";

const originalFetch = globalThis.fetch;
const originalEnv = {
  TELEGRAM_WEBHOOK_SECRET: process.env.TELEGRAM_WEBHOOK_SECRET,
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_MODEL: process.env.OPENAI_MODEL,
  TELEGRAM_ALLOWED_USER_ID: process.env.TELEGRAM_ALLOWED_USER_ID,
};

beforeEach(() => {
  process.env.TELEGRAM_ALLOWED_USER_ID = "42";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function telegramRequest(
  secret?: string,
  text = "Help me scope a feature",
  fromId: number | undefined = 42,
  chatType = "private",
) {
  return new Request("http://localhost/api/telegram", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(secret ? { "x-telegram-bot-api-secret-token": secret } : {}),
    },
    body: JSON.stringify({ message: { chat: { id: 123, type: chatType }, from: fromId === undefined ? undefined : { id: fromId }, text } }),
  });
}

test("ignores messages from a different Telegram user without network calls", async () => {
  process.env.TELEGRAM_WEBHOOK_SECRET = "hook-secret";
  globalThis.fetch = async () => { throw new Error("Unauthorized message reached the network"); };

  const response = await POST(telegramRequest("hook-secret", "Hello Maya", 99));
  assert.equal(response.status, 200);
});

test("ignores group messages even when the sender is allowed", async () => {
  process.env.TELEGRAM_WEBHOOK_SECRET = "hook-secret";
  globalThis.fetch = async () => { throw new Error("Group message reached the network"); };

  const response = await POST(telegramRequest("hook-secret", "Hello Maya", 42, "group"));
  assert.equal(response.status, 200);
});

test("ignores messages when the allowed user ID is not configured", async () => {
  process.env.TELEGRAM_WEBHOOK_SECRET = "hook-secret";
  delete process.env.TELEGRAM_ALLOWED_USER_ID;
  globalThis.fetch = async () => { throw new Error("Unconfigured bot reached the network"); };

  const response = await POST(telegramRequest("hook-secret"));
  assert.equal(response.status, 200);
});

test("/whoami returns the sender ID during setup without calling the model", async () => {
  process.env.TELEGRAM_WEBHOOK_SECRET = "hook-secret";
  process.env.TELEGRAM_BOT_TOKEN = "bot-token";
  delete process.env.TELEGRAM_ALLOWED_USER_ID;
  let calls = 0;
  globalThis.fetch = async (input, init) => {
    calls += 1;
    assert.equal(String(input), "https://api.telegram.org/botbot-token/sendMessage");
    assert.deepEqual(JSON.parse(String(init?.body)), { chat_id: 123, text: "Your Telegram user ID is 42." });
    return Response.json({ ok: true });
  };

  const response = await POST(telegramRequest("hook-secret", "/whoami"));
  assert.equal(response.status, 200);
  assert.equal(calls, 1);
});

test("rejects a request when the webhook secret is not configured", async () => {
  delete process.env.TELEGRAM_WEBHOOK_SECRET;
  const response = await POST(telegramRequest());
  assert.equal(response.status, 503);
});

test("routes /theo to the architect and removes the command from the question", async () => {
  process.env.TELEGRAM_WEBHOOK_SECRET = "hook-secret";
  process.env.TELEGRAM_BOT_TOKEN = "bot-token";
  process.env.OPENAI_API_KEY = "api-key";
  let modelInput: Record<string, unknown> | undefined;
  let deliveredText: string | undefined;

  globalThis.fetch = async (input, init) => {
    if (String(input) === "https://api.openai.com/v1/responses") {
      modelInput = JSON.parse(String(init?.body));
      return Response.json({
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: "Keep the boundary small." }] }],
      });
    }
    if (String(input) === "https://api.telegram.org/botbot-token/sendMessage") {
      deliveredText = JSON.parse(String(init?.body)).text;
      return Response.json({ ok: true });
    }
    throw new Error(`Unexpected URL: ${input}`);
  };

  const response = await POST(telegramRequest("hook-secret", "/theo Define the auth boundary"));

  assert.equal(response.status, 200);
  assert.equal(modelInput?.input, "Define the auth boundary");
  assert.match(String(modelInput?.instructions), /Theo.*architect/i);
  assert.doesNotMatch(String(modelInput?.instructions), /You are Maya/);
  assert.equal(deliveredText, "Theo: Keep the boundary small.");
});

for (const [command, role, question] of [
  ["/sam", "builder", "Implement the login form"],
  ["/quinn", "reviewer", "Review the auth change"],
  ["/maya", "engineering lead", "Scope the release"],
] as const) {
  test(`routes ${command} to the ${role}`, async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = "hook-secret";
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.OPENAI_API_KEY = "api-key";
    let modelInput: Record<string, unknown> | undefined;
    globalThis.fetch = async (input, init) => {
      if (String(input) === "https://api.openai.com/v1/responses") {
        modelInput = JSON.parse(String(init?.body));
        return Response.json({
          status: "completed",
          output: [{ type: "message", content: [{ type: "output_text", text: "Here is my take." }] }],
        });
      }
      return Response.json({ ok: true });
    };

    const response = await POST(telegramRequest("hook-secret", `${command} ${question}`));

    assert.equal(response.status, 200);
    assert.equal(modelInput?.input, question);
    assert.match(String(modelInput?.instructions), new RegExp(role, "i"));
  });
}

test("routes /susie to the designer and labels her answer", async () => {
  process.env.TELEGRAM_WEBHOOK_SECRET = "hook-secret";
  process.env.TELEGRAM_BOT_TOKEN = "bot-token";
  process.env.OPENAI_API_KEY = "api-key";
  let modelInput: Record<string, unknown> | undefined;
  let deliveredText: string | undefined;
  globalThis.fetch = async (input, init) => {
    if (String(input) === "https://api.openai.com/v1/responses") {
      modelInput = JSON.parse(String(init?.body));
      return Response.json({
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: "Simplify the first screen." }] }],
      });
    }
    deliveredText = JSON.parse(String(init?.body)).text;
    return Response.json({ ok: true });
  };

  const response = await POST(telegramRequest("hook-secret", "/susie Improve onboarding"));

  assert.equal(response.status, 200);
  assert.equal(modelInput?.input, "Improve onboarding");
  assert.match(String(modelInput?.instructions), /Susie.*designer/i);
  assert.equal(deliveredText, "Susie: Simplify the first screen.");
});

test("a command without a question replies with usage without calling the model", async () => {
  process.env.TELEGRAM_WEBHOOK_SECRET = "hook-secret";
  process.env.TELEGRAM_BOT_TOKEN = "bot-token";
  process.env.OPENAI_API_KEY = "api-key";
  const calls: string[] = [];
  globalThis.fetch = async (input, init) => {
    calls.push(String(input));
    assert.equal(String(input), "https://api.telegram.org/botbot-token/sendMessage");
    const body = JSON.parse(String(init?.body));
    assert.match(body.text, new RegExp("/theo .*question", "i"));
    return Response.json({ ok: true });
  };

  const response = await POST(telegramRequest("hook-secret", "/theo"));

  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
});

test("usage guidance works even when the model key is not configured", async () => {
  process.env.TELEGRAM_WEBHOOK_SECRET = "hook-secret";
  process.env.TELEGRAM_BOT_TOKEN = "bot-token";
  delete process.env.OPENAI_API_KEY;
  let deliveredText: string | undefined;
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "https://api.telegram.org/botbot-token/sendMessage");
    deliveredText = JSON.parse(String(init?.body)).text;
    return Response.json({ ok: true });
  };

  const response = await POST(telegramRequest("hook-secret", "/susie"));

  assert.equal(response.status, 200);
  assert.equal(deliveredText, "Send /susie followed by your question.");
});

test("asks the model as Maya and sends its answer to Telegram", async () => {
  process.env.TELEGRAM_WEBHOOK_SECRET = "hook-secret";
  process.env.TELEGRAM_BOT_TOKEN = "bot-token";
  process.env.OPENAI_API_KEY = "api-key";
  const calls: { url: string; body: Record<string, unknown> }[] = [];

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body));
    calls.push({ url, body });
    if (url === "https://api.openai.com/v1/responses") {
      assert.equal(init?.headers && (init.headers as Record<string, string>).Authorization, "Bearer api-key");
      return Response.json({
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: "Let's define done first." }] }],
      });
    }
    if (url === "https://api.telegram.org/botbot-token/sendMessage") {
      return Response.json({ ok: true });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const response = await POST(telegramRequest("hook-secret"));

  assert.equal(response.status, 200);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.input, "Help me scope a feature");
  assert.match(String(calls[0].body.instructions), /Maya.*engineering lead/i);
  assert.match(String(calls[0].body.instructions), /Theo, Sam, Quinn, and Susie/);
  assert.doesNotMatch(String(calls[0].body.instructions), /There are no other agents/);
  assert.match(String(calls[0].body.instructions), /at most 100 words/i);
  assert.equal(calls[0].body.model, "gpt-4.1-mini");
  assert.equal(calls[0].body.reasoning, undefined);
  assert.equal(calls[0].body.max_output_tokens, 350);
  assert.equal(calls[0].body.store, false);
  assert.deepEqual(calls[1].body, { chat_id: 123, text: "Let's define done first." });
});

test("does not acknowledge delivery when the model fails", async () => {
  process.env.TELEGRAM_WEBHOOK_SECRET = "hook-secret";
  process.env.TELEGRAM_BOT_TOKEN = "bot-token";
  process.env.OPENAI_API_KEY = "api-key";
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("failed", { status: 500 });
  };

  const response = await POST(telegramRequest("hook-secret"));
  assert.equal(response.status, 502);
  assert.equal(calls, 1);
});

test("does not acknowledge delivery when Telegram rejects the message", async () => {
  process.env.TELEGRAM_WEBHOOK_SECRET = "hook-secret";
  process.env.TELEGRAM_BOT_TOKEN = "bot-token";
  process.env.OPENAI_API_KEY = "api-key";
  globalThis.fetch = async (input) => {
    if (String(input) === "https://api.openai.com/v1/responses") {
      return Response.json({
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: "I'll scope it." }] }],
      });
    }
    return Response.json({ ok: false, description: "chat not found" });
  };

  const response = await POST(telegramRequest("hook-secret"));
  assert.equal(response.status, 502);
});

test("does not send a truncated model response", async () => {
  process.env.TELEGRAM_WEBHOOK_SECRET = "hook-secret";
  process.env.TELEGRAM_BOT_TOKEN = "bot-token";
  process.env.OPENAI_API_KEY = "api-key";
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json({
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [{ type: "message", content: [{ type: "output_text", text: "A partial answer" }] }],
    });
  };

  const response = await POST(telegramRequest("hook-secret"));
  assert.equal(response.status, 502);
  assert.equal(calls, 1);
});
