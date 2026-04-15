# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)
- **AI**: Google Gemini (`@google/generative-ai`) using free `gemini-1.5-flash` model via `GOOGLE_API_KEY`

## Artifacts

### Policy Extractor (`artifacts/policy-extractor`)
- React + Vite frontend at `/`
- URL input to extract housing policies from student accommodation sites
- Backend scrapes pages (same-domain only) and uses Gemini AI to extract structured policy data
- Extracts 12 Cancellation Policies and 6 Payment Policies

### API Server (`artifacts/api-server`)
- Express 5 backend at `/api`
- `POST /api/extract-policies` — scrapes URL + Gemini extraction

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

## Environment Variables

- `GOOGLE_API_KEY` — Google Gemini API key (required for policy extraction)
- `SESSION_SECRET` — Session secret

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
