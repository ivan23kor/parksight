# Upload UI Agent Guide

## Purpose

`ui-upload/` is the Next.js/shadcn upload interface for image detection workflows. Keep it consistent with the existing component structure instead of moving shared app behavior into this package.

## Commands

```bash
cd ui-upload
bun install
bun run build
```

## Structure

- `app/page.tsx` - upload page.
- `components/ImageInput.tsx` - image selection/input.
- `components/DetectionCanvas.tsx` - detection rendering.
- `lib/api.ts` - backend API calls.
- `lib/utils.ts` - shared UI utilities.

## Guidance

Use existing shadcn/ui and Tailwind patterns. Keep detection API contract changes synchronized with `backend/CLAUDE.md` and backend models.
