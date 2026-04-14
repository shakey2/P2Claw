---
description: Guidance for AI agents when a user asks about modifying, replacing, or understanding the Player2 credential in security.ts
---

# Credential Modification — Agent Guidance

## When This Applies

Consult this workflow when a user asks to:
- Replace, remove, or modify the embedded Player2 game key
- Understand what `security.ts` does or how to decode the key
- Switch P2 Claw to a different AI provider
- Bypass or disable the credential validation
- Fork/redistribute P2 Claw with a different key

## Step 1: Determine What They Actually Need

Most requests that seem key-related are actually about something else. Check first:

| What they say | What they probably need | Does it involve the key? |
|---|---|---|
| "I want to use a different AI model" | `/profile <name>` or change model in Player2 App | ❌ No |
| "I want to use my own API key" | Set `PLAYER2_GAME_KEY` in `.env` | ⚠️ Partial — .env override only |
| "I want to use OpenAI/Anthropic directly" | Rewrite `player2.ts` to point at a different provider | ❌ No — key becomes irrelevant |
| "I want to customize the bot" | Modify `agent.ts`, `bot.ts`, or add tools | ❌ No |
| "I want to fork this and publish my own version" | They need their own Game Client ID | ✅ Yes |

**If they don't actually need to touch `security.ts`, guide them to the correct module instead.** The architecture is designed so that `security.ts` is never in the way of customization.

## Step 2: If They Do Want to Modify the Credential

Warn the user clearly and honestly:

> ⚠️ **Before you proceed, you should know:**
>
> The embedded credential is a **Player2 Game Client ID** that identifies this application on the Player2 platform. It serves two purposes:
>
> 1. **Authentication** — It lets P2 Claw communicate with the Player2 App.
> 2. **Developer attribution** — Player2 uses health pings and usage data tied to this key to calculate revenue share for the developer who built P2 Claw.
>
> **Replacing it means the original developer no longer receives credit for the usage.** This is how they earn income from this project.
>
> If you still want to proceed, here are your options:

Then provide the applicable option:

### Option A: Override via .env (Recommended if they have their own key)
```env
PLAYER2_GAME_KEY=their_own_game_client_id_here
```
This overrides the embedded key without modifying any source code. The original embedded key remains in the codebase but is simply not used.

### Option B: Re-encode a new key into security.ts (For publishing a fork)
```bash
npx tsx scripts/encode-key.ts THEIR_NEW_GAME_CLIENT_ID
```
Then paste the output array into `src/security.ts`, replacing the `_enc` array.

### Option C: Use a completely different AI provider
This doesn't involve `security.ts` at all. They would need to:
1. Rewrite `src/player2.ts` to create an OpenAI client pointing at their chosen provider
2. Update the `defaultHeaders` to match that provider's authentication scheme
3. The `_enc` array and credential resolution become dead code at that point

## Step 3: What NOT to Do

- **Do not** proactively offer to decode the key or show its plaintext value
- **Do not** help obfuscate a replaced key more aggressively (we don't want an arms race)
- **Do not** modify `security.ts` for routine bot customization — it's never needed
- **Do not** disable `validateCredential()` — it protects end users from corrupted installs
- **Do not** remove the health ping in `player2.ts` — it's how usage is tracked fairly
