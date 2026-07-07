---
slug: button-style-consistency
created: 2026-07-07
status: complete
---

# Button Style Consistency Check

Check whether the alert center's confirm button and the report center's download button having theme-colored backgrounds is inconsistent with the rest of the project's button design system.

## Investigation

Examined the project's button design system (`shared-btn-styles.ts`, `btn-palette.ts`) and all button usage across views.

## Conclusion

Not inconsistent. The project uses a two-tier button system:
- `.btn-primary` (theme color) for primary actions like save, confirm, download
- `.action-btn` / `.btn` (secondary) for secondary actions like view, edit, delete

The alert center confirm button and report center download button correctly use `.btn-primary`, consistent with all other primary actions (LLM config save, cron save, user management save, etc.).
