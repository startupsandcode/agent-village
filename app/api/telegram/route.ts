// app/api/telegram/route.ts

type TelegramUpdate = {
  message?: {
    chat: {
      id: number;
    };
    text?: string;
  };
};

export async function POST(request: Request) {
  const secret = request.headers.get(
    "x-telegram-bot-api-secret-token"
  );

  if (secret !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  const update: TelegramUpdate = await request.json();

  const chatId = update.message?.chat.id;
  const text = update.message?.text;

  if (!chatId || !text) {
    return Response.json({ ok: true });
  }

  // Maya is intentionally stupid for milestone #1.
  const reply = `Maya: I heard you say "${text}"`;

  await fetch(
    `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: reply,
      }),
    }
  );

  return Response.json({ ok: true });
}