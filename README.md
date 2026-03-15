# @plurity/toll

Open source SDK for [Plurity Toll](https://toll.plurity.ai) — AI agent traffic tracking and llms.txt management.

## What it does

- **Detects AI agents** visiting your website (GPTBot, ClaudeBot, PerplexityBot, etc.)
- **Tracks agent traffic** — non-blocking, batched event reporting
- **Serves llms.txt** — auto-generated from your Q&A content in your dashboard
- **Captures agent questions** — agents can submit questions they couldn't find answers to

## Installation

```bash
# Core (framework-agnostic)
npm install @plurity/toll

# Next.js
npm install @plurity/toll @plurity/toll-nextjs

# Express
npm install @plurity/toll @plurity/toll-express
```

## Quick start

### Next.js

```typescript
// middleware.ts
import { createTollMiddleware } from '@plurity/toll-nextjs'
import { PlurityBackend } from '@plurity/toll'

const toll = createTollMiddleware({
  siteId: process.env.TOLL_SITE_ID!,
  backend: new PlurityBackend({ siteKey: process.env.TOLL_SITE_KEY! }),
})

export async function middleware(request: NextRequest) {
  const tollResponse = await toll(request)
  if (tollResponse) return tollResponse
  return NextResponse.next()
}
```

### Express

```typescript
import { createTollMiddleware, createLlmsTxtHandler } from '@plurity/toll-express'
import { PlurityBackend } from '@plurity/toll'

const backend = new PlurityBackend({ siteKey: process.env.TOLL_SITE_KEY! })
app.use(createTollMiddleware({ siteId: process.env.TOLL_SITE_ID!, backend }))
app.get('/llms.txt', createLlmsTxtHandler({ siteId: process.env.TOLL_SITE_ID!, backend }))
```

### Self-hosted / air-gapped

```typescript
import { Toll, LocalBackend } from '@plurity/toll'

const toll = new Toll({
  siteId: 'my-site',
  backend: new LocalBackend({
    config: {
      siteName: 'My Site',
      qaPairs: [
        { question: 'What do you do?', answerUrl: '/about' },
      ],
    },
    eventSink: (events) => myAnalytics.track(events),
  }),
})
```

## Packages

| Package | Description |
|---|---|
| `@plurity/toll` | Core: Toll class, PlurityBackend, LocalBackend, types |
| `@plurity/toll-nextjs` | Next.js middleware adapter |
| `@plurity/toll-express` | Express middleware adapter |

## License

MIT — see [LICENSE](./LICENSE)
