# Storyframe — Business Proposal & 30/90-Day Plan

*Prepared 2026-07-22. Reflects repo state as of commit `7d18fdf` (Dezgo SD/Flux split), one day after the first live-billing launch (`2c4f786`).*

## 1. Where the business actually is right now

Strip away the engineering polish and the honest status is: **pre-revenue, day-one of monetization capability, one real customer (the founder).**

- Live Stripe charging was switched on for exactly **one real tenant** (`n@g.com`) on 2026-07-22. The other 10 tenants in prod are synthetic test accounts (`ci-test-*`, `ui-test-*`, `csrf-*`, etc.).
- Zero real Stripe purchases have ever settled outside the one Playwright-driven smoke test.
- There is no marketing funnel, no analytics/telemetry package in the codebase (no PostHog/GA/Mixpanel), no email sending capability anywhere (no verification, no password reset, no receipts beyond Stripe's own), and no Terms of Service or Privacy Policy page.
- This is not a criticism of the build — the *generation pipeline* (script → scenes → images → narration → video) and the *billing ledger* (usage metering, markup, credits, Stripe webhooks, audit log, rollback levers) are unusually mature for a pre-revenue product. Most solo-founder products reach real users with much shakier plumbing underneath. The gap here is entirely on the go-to-market and trust-surface side, not the core product.

**The strategic question for the next 90 days is not "what feature should we build next" — it's "how do we get past one user without the unit economics or the trust surface breaking."**

## 2. Product summary (what it does today)

Storyframe turns a pasted script or story into a narrated video sequence:

1. **Import** — paste raw text; an LLM (Gemini or OpenAI) splits it into scene fragments.
2. **Narration & dialogue** — screenplay prose converted to spoken narration (one project-wide narrator voice).
3. **Visual prompting** — camera-agnostic image prompts generated per scene, with continuity rules referencing neighboring scenes.
4. **Image generation** — Gemini, OpenAI, or Dezgo (Stable Diffusion *and* Flux Schnell, split as of the latest commit), with up to 14 injected character/world reference images per style.
5. **Video generation** — MiniMax (live-validated), Veo (scaffolded, not yet validated), LTX (local-only).
6. **Voice** — Piper (free, local/Modal), ElevenLabs (cloud), Spark-TTS (zero-shot voice cloning, GPU-bound).
7. **Playback & export** — synchronized audio/video player, ZIP export of assets.
8. **Billing** — usage-metered credits ($1 = 1 credit), Stripe-hosted credit-pack checkout ($10/$25/$100 for 10/25/100 credits flat, no volume bonus), full audit-logged admin console with per-tenant and per-provider charging kill switches.

Five built-in visual styles (Basic Cartoon, Cinematic Reality, Dark Gothic, Indie Youtuber, Vox Style), multi-tenant auth (Argon2 + opaque session tokens), Postgres via Prisma with filesystem/R2 dual-write for media.

**Positioning**: this sits closest to Kaiber/Pika-style AI video tools, but differentiated by taking a *full script* as input rather than a single prompt, and by producing a *sequence* (storyboard) rather than a single clip. The closer comparable is actually explainer-video tools like Vyond or Synthesia, minus their template libraries and business-market positioning — Storyframe is presently aimed at narrative/story content, not corporate training or marketing video.

## 3. Unit economics — the finding that should drive prioritization

The markup policy active in prod is `markupBasisPoints: 100` — **a 1% markup on raw provider cost.**

Walk the math on a single credit pack sale:
- Customer buys the $10 "Starter" pack → 10 credits → $10 of provider spend headroom at 1% markup (i.e. ~$9.90 of actual AI provider cost is passed straight through to the customer, and the platform keeps ~$0.10).
- Stripe's own fee on a $10 charge is ~2.9% + $0.30 ≈ **$0.59**.
- **The platform loses roughly $0.49 on every $10 pack sold before a single token of usage happens**, purely on payment processing. Server hosting (Railway), Modal GPU time for Piper/Spark-TTS, and R2 storage are all additional cost on top of that.
- The **welcome grant is 10 free credits** (~$10 of provider headroom) with **no email verification** gating signup. A scripted bot loop that registers accounts and immediately burns the welcome grant is a real, currently-unmitigated cost-drain vector — not a hypothetical.

This is the single most important business fact in the repo. Every other feature decision below is secondary to fixing this, because right now **growth is a liability, not an asset** — the more successful the current pricing/signup flow is at acquiring users, the faster it loses money. This must be treated as a launch blocker, not a backlog item.

## 4. Must-have gaps before any real public launch

These aren't "nice to have" — each one is a specific, concrete failure mode waiting to happen the moment traffic exceeds "the founder and friends."

| Gap | Why it's must-have | Evidence |
|---|---|---|
| **Pricing/markup fix** | Currently loses money per transaction before usage costs; free-credit abuse has no gate | §3 above |
| **Email verification / password reset** | Explicitly flagged as "remaining Phase 1 work" in the multi-tenant doc; no email-sending capability exists anywhere in the codebase today | `docs/multi-tenant-foundation.md` §"Remaining Phase 1 work"; no nodemailer/sendgrid/postmark/resend in deps |
| **Content moderation / safety filter** | Zero moderation code found anywhere. An AI image/video generator taking arbitrary user text with no NSFW/abuse filter is a payment-processor and legal risk (Stripe's own ToS requires this for AI content platforms), not just a UX one | grep for moderation/NSFW/safety returned nothing |
| **Terms of Service / Privacy Policy** | No such pages exist. Required to legally take payment from the public and to satisfy Stripe's underwriting for a live (non-test) account at real volume | `find` for terms/privacy returned nothing |
| **Rate limiting / abuse protection** | Only MiniMax has provider-side rate-limit handling; there's no app-level per-tenant request throttling, meaning a single account (malicious or buggy) can hammer expensive providers | grep for rate-limit only hit MiniMax's own retry logic |
| **Product analytics** | No PostHog/GA/Mixpanel/Amplitude anywhere. There is no way today to answer "where do users drop off," "what's activation rate," or "which style/provider drives retention" | grep across src/public returned nothing |
| **Per-tenant quotas/concurrency** | Listed as remaining Phase 1 work; today one tenant could exhaust `GENERATION_CONCURRENCY=1` global queue capacity for everyone | `docs/multi-tenant-foundation.md` |

None of these are large builds individually. Collectively they are the difference between "works for a solo founder testing on himself" and "safe to point strangers at."

## 5. Feature value vs. effort — what's already in flight

Two features are mid-build right now (uncommitted, in the working tree): `image-library-controller.js` (566 lines) and `token-details.js` (177 lines), alongside a large simplification of `ui.js` (-719 lines). This reads as active cleanup of the asset/credit-visibility UX — good instinct, and worth finishing before starting anything new, since half-shipped UI work compounds the "not ready for strangers" problem above.

| Feature area | Business value | Effort | Verdict |
|---|---|---|---|
| Finish image-library-controller + token-details (in progress) | High — credit transparency reduces billing-surprise churn, which is the #1 trust issue for usage-billed AI products | Low (already 80% written) | **Finish first** |
| Fix markup/pricing + gate welcome credits | Critical — see §3 | Low-Medium (policy + one gating check) | **Do before any traffic growth** |
| Email verification + password reset | High — blocks legitimate account recovery and gates the free-credit abuse vector | Medium | **30-day** |
| Content moderation on prompts/images | Critical (legal + platform risk) | Medium (can start with a text-prompt filter + provider-native moderation flags before building custom vision moderation) | **30-day** |
| Terms/Privacy pages | Critical, low effort | Low | **30-day, do immediately** |
| Volume-discounted / subscription credit tiers | Medium — current flat $1/credit packs leave money on the table vs. typical bonus-at-volume anchoring | Low | **60-day** |
| Product analytics instrumentation | High — currently flying blind on activation/retention | Low-Medium | **30–60 day** |
| Per-tenant quotas + rate limiting | High as user count grows past ~10 | Medium | **60-day** |
| Referral / sharing mechanism (export to social, public gallery) | High for organic growth — currently zero virality loop; every generated video is a private ZIP download | Medium | **60–90 day** |
| Veo video provider validation | Medium — currently a scaffold, not live-validated; second video provider = redundancy if MiniMax has an outage or price hike | Medium | **60–90 day** |
| WhisperX alignment service in prod (karaoke word-timing) | Low-Medium — currently local-only, feature is silently skipped in prod | Medium-High (needs a GPU host) | **90-day / opportunistic** |
| Template library / vertical focus (marketing explainers, YouTube shorts, etc.) | High long-term but requires a market bet | High | **Post-90-day, needs a decision first (see §7)** |

## 6. What "popular" actually requires here

Popularity for a tool like this comes from one of two places: (a) the output is good enough that people share it unprompted, or (b) a specific underserved niche adopts it as a workflow tool. Right now Storyframe has neither lever pulled:

- **No sharing surface.** Output is a ZIP download. There's no public link, no embeddable player, no "made with Storyframe" watermark loop. Every AI content tool that grew organically (Midjourney via Discord, CapCut via TikTok exports) had built-in distribution baked into the output. This is the highest-leverage growth feature missing today, and it's not on the roadmap yet.
- **No niche commitment.** The five styles (cartoon, cinematic, gothic, YouTuber, "Vox style") suggest the product is hedging across several audiences (storytellers, YouTubers, marketers) without picking one to go deep on. A 90-day plan should force a choice — see the recommendation below.

## 7. Recommendation: pick a beachhead before scaling acquisition

Don't try to serve "anyone with a story" yet. The infra (multi-provider image/video/voice, styles, billing) is general-purpose enough to redirect quickly, but marketing, onboarding copy, and the landing page (`index.html`) should commit to one persona for the first 90 days. The two strongest candidates already visible in the styles library:

- **Faceless YouTube/TikTok narrators** ("Indie Youtuber" style already exists) — huge, proven demand (Reddit-story and horror-story narration channels), clear willingness to pay, and a natural sharing loop (every export *is* the marketing asset when posted).
- **Indie storytellers / webcomic-to-motion creators** — smaller, more passionate niche, higher price tolerance per project, slower viral loop.

I'd bias toward the first — it has the sharing loop built in for free, which directly addresses §6.

## 8. 30 / 60 / 90-day plan

### Days 1–30: Stop the bleeding, become legally/financially safe to grow
1. Fix markup policy — raise effective margin (subscription tier, higher bps, or fixed platform fee per generation) to cover Stripe fees + infra, not just provider passthrough.
2. Gate the welcome credit grant behind email verification (build minimal transactional email — even a basic SMTP/Resend integration).
3. Ship Terms of Service + Privacy Policy pages.
4. Add a first-pass moderation filter on prompts (provider-native moderation flags from OpenAI/Gemini are likely already available in their API responses — surface and enforce them before building anything custom).
5. Finish the in-flight `image-library-controller` / `token-details` work — ship credit transparency in the UI.
6. Instrument basic analytics (signup → first generation → first export funnel, at minimum).

### Days 31–60: Make growth safe and start the acquisition loop
1. Per-tenant rate limiting and generation quotas.
2. Add volume-bonus credit tiers (e.g., $100 pack grants 110 credits) to anchor larger purchases.
3. Commit to the YouTube-narrator beachhead in landing page copy, onboarding, and default style ordering.
4. Build the first sharing surface: a public, shareable project link or embeddable player — even a simple "watch page" per exported video with Storyframe branding.
5. Validate Veo as a second video provider (redundancy against MiniMax price/availability risk).

### Days 61–90: First real acquisition push
1. Launch to the chosen niche (e.g., a targeted post in faceless-YouTube creator communities, a small paid-ads test, or direct outreach to 20–30 creators for free credits in exchange for using it on a real video).
2. Track activation/retention against the analytics instrumented in month 1; use it to decide whether to double down on YouTube-narrator or pivot toward the storyteller niche.
3. Revisit pricing again with real usage data — the 1% markup was a placeholder for internal testing, not a considered public price.
4. Decide, with real data in hand, whether a template library / vertical-specific onboarding (script templates for "true crime narration," "motivational shorts," etc.) is worth the investment flagged as High-effort in §5.

## 9. Risks to flag explicitly

- **Provider cost volatility**: pricing is pegged to real-time provider rate cards (MiniMax, OpenAI, Gemini, Dezgo, ElevenLabs) with a razor-thin margin. Any provider price increase is currently a direct hit to the platform's already-negative-to-breakeven margin, not just passed to customers, until §3 is fixed.
- **Single-operator bus factor**: all commits are from one author. The billing runbook and audit-log discipline are genuinely strong mitigations for this (any admin action is logged and reversible), but there's no team redundancy for incident response.
- **Legal exposure on generated content**: no moderation + no ToS is a real liability the moment this is public, not a theoretical one — flagged as a Day 1–30 blocker above, not deferred.
