# Contributing to plurity-toll-sdk

Thank you for your interest in contributing! This SDK is open source (MIT) and community contributions are welcome.

## What lives here

This repo contains the JavaScript/TypeScript SDK for Plurity Toll:

- `packages/core` — `@plurity/toll` — framework-agnostic core
- `packages/nextjs` — `@plurity/toll-nextjs` — Next.js middleware adapter
- `packages/express` — `@plurity/toll-express` — Express middleware adapter

## How to contribute

1. Fork the repo and create a feature branch
2. `pnpm install` to install dependencies
3. Make your changes with tests
4. `pnpm build` to verify everything compiles
5. Open a PR with a clear description

## Adding a new framework adapter

1. Create `packages/<framework>/` with `package.json`, `tsup.config.ts`, `tsconfig.json`
2. Add `@plurity/toll` as a dependency
3. Implement the middleware/handler pattern (see `packages/nextjs/src/middleware.ts`)
4. Export a `createTollMiddleware` function
5. Add usage examples to README

## Reporting bugs

Open an issue at https://github.com/plurity/toll-sdk/issues

## Backend compatibility

The SDK is backend-agnostic. The `TollBackend` interface allows any backend implementation:
- `PlurityBackend` — talks to toll.plurity.ai (default)
- `LocalBackend` — fully local, no network calls
- Custom — implement `TollBackend` yourself
