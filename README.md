# Agent Village

Maya is the default engineering lead in the Telegram bot. In a direct chat with the bot, you can also address [Theo](lib/theo.ts) (architect), [Sam](lib/sam.ts) (builder), [Quinn](lib/quinn.ts) (reviewer), or [Susie](lib/susie.ts) (product designer) with a command at the start of a message:

```text
/theo Define the auth boundary
/sam Sketch the smallest implementation
/quinn Review these acceptance criteria
/susie Improve this onboarding flow
/maya Help me scope the release
```

Messages without a command go to Maya. A command by itself returns usage guidance. Each question makes one independent OpenAI Responses API request, and the answer goes back to the same Telegram chat. Model answers from the other personas include their names so you know who answered.

## Run locally

Use Node.js 24 and install dependencies with `npm ci`. Create `.env.local` with:

```env
TELEGRAM_BOT_TOKEN=your-telegram-bot-token
TELEGRAM_WEBHOOK_SECRET=your-telegram-webhook-secret
OPENAI_API_KEY=your-openai-api-key
TELEGRAM_ALLOWED_USER_ID=your-numeric-telegram-user-id
# Optional. Defaults to gpt-4.1-mini.
OPENAI_MODEL=gpt-4.1-mini
```

Run `npm run dev`. Telegram needs a public HTTPS webhook, so local testing requires a tunnel or a Vercel deployment. Add the same environment variables to Vercel and register `https://YOUR-DOMAIN/api/telegram` as the bot webhook with the matching `secret_token`.

The bot has no conversation memory, repository access, coding tools, or ability to delegate yet. These personas are conversational specialists, not autonomous workers. Their instructions tell them not to claim capabilities they do not have. OpenAI response storage is disabled with `store: false`.

The webhook accepts model requests only from `TELEGRAM_ALLOWED_USER_ID` in a private chat. It silently ignores other senders and group messages. If the ID is missing, the bot ignores all normal messages. To set it up, deploy the webhook without the ID, send `/whoami` in your private bot chat, then add the returned ID to `.env.local` and the Vercel Production environment and redeploy. `/whoami` does not call the model. Keep the webhook secret configured as well; it authenticates Telegram's delivery, while the user ID restricts who can use the bot.

## Check changes

```bash
npm test
npm run lint
npm run build
```
