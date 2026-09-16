import { askPersona } from "../../../lib/model.ts";
import { selectPersona } from "../../../lib/personas.ts";

type TelegramUpdate = {
  message?: {
    chat: {
      id: number;
      type: string;
    };
    from?: { id: number };
    text?: string;
  };
};

export async function POST(request: Request) {
  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!webhookSecret) {
    return new Response("Webhook secret is not configured", { status: 503 });
  }

  const secret = request.headers.get(
    "x-telegram-bot-api-secret-token"
  );

  if (secret !== webhookSecret) {
    return new Response("Unauthorized", { status: 401 });
  }

  const update: TelegramUpdate = await request.json();

  const chatId = update.message?.chat.id;
  const chatType = update.message?.chat.type;
  const senderId = update.message?.from?.id;
  const text = update.message?.text;

  if (!chatId || !text) {
    return Response.json({ ok: true });
  }

  if (chatType !== "private" || !Number.isSafeInteger(senderId)) {
    return Response.json({ ok: true });
  }

  const allowedUserId = process.env.TELEGRAM_ALLOWED_USER_ID?.trim();
  if (allowedUserId && String(senderId) !== allowedUserId) {
    return Response.json({ ok: true });
  }

  const isWhoami = text.trim() === "/whoami";
  if (!allowedUserId && !isWhoami) {
    return Response.json({ ok: true });
  }

  const persona = selectPersona(text);
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const apiKey = process.env.OPENAI_API_KEY || "";
  if (!botToken || (!isWhoami && persona.input && !apiKey)) {
    return new Response("Bot or model is not configured", { status: 503 });
  }

  try {
    const reply = isWhoami
      ? `Your Telegram user ID is ${senderId}.`
      : persona.input
      ? await askPersona(persona.input, persona.instructions, apiKey, process.env.OPENAI_MODEL || "gpt-4.1-mini")
      : `Send /${persona.name} followed by your question.`;
    const deliveredText = isWhoami || persona.name === "maya" || !persona.input
      ? reply
      : `${persona.name[0].toUpperCase()}${persona.name.slice(1)}: ${reply}`;
    const sent = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: deliveredText,
      }),
    });

    const delivery = (await sent.json()) as { ok?: boolean };
    if (!sent.ok || delivery.ok !== true) {
      throw new Error(`Telegram rejected the reply (${sent.status})`);
    }
  } catch (error) {
    console.error("Village could not deliver a reply", error);
    return new Response("Reply delivery failed", { status: 502 });
  }

  return Response.json({ ok: true });
}
