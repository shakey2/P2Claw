# P2 Claw — Credits & Attributions

> Giving credit where it's due. This file tracks all inspirations,
> contributions, and attributions for the P2 Claw project.

---

## Project

**P2 Claw** — A lean, secure personal AI agent powered by Player2.

**Developer:** Zardov

---

## Inspirations & Origins

### Jack Roberts ([@Itssssss_Jack](https://www.youtube.com/@Itssssss_Jack))
- **Contribution:** Original prompt concept for building a personal AI agent
- **Project:** [Gravity Claw](https://www.youtube.com/@Itssssss_Jack) — the direct inspiration for P2 Claw
- **Note:** The original prompt was modified and adapted by Zardov for the Player2 platform and P2 Claw's architecture

### OpenClaw (formerly ClawdBot/Moltbot)
- **Author:** Peter Steinberger ([@steipete](https://github.com/steipete))
- **Repository:** [github.com/steipete/openclaw](https://github.com/steipete/openclaw)
- **Contribution:** Architectural inspiration — agentic tool loop, Telegram integration, heartbeat concept, local-first philosophy
- **Note:** P2 Claw is built from scratch, not a fork. We studied OpenClaw's strengths and weaknesses to inform our design (see DESIGN.md §1)

---

## Platform

### Player2
- **Website:** [player2.game](https://player2.game)
- **Role:** AI model provider — LLM, TTS, STT, image, video, 3D, and music generation via local API
- **Mascot:** Ellie the elephant — namesake of P2 Claw's default personality

---

## Libraries

| Package | Author/Org | License | Usage |
|---|---|---|---|
| [grammY](https://grammy.dev/) | grammY contributors | MIT | Telegram bot framework |
| [openai-node](https://github.com/openai/openai-node) | OpenAI | Apache-2.0 | SDK for Player2 API |
| [dotenv](https://github.com/motdotla/dotenv) | motdotla | BSD-2-Clause | Environment variable loading |
| [tsx](https://github.com/privatenumber/tsx) | Hiroki Osame | MIT | TypeScript execution |

---

## AI Assistance

This project was built with AI pair-programming assistance. The developer reviewed, approved, and takes responsibility for all generated code.

---

*This file is updated as new attributions are needed. If you believe your work*
*is used in this project and not credited, please open an issue.*
