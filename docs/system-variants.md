# System variants

One card per family; the selector picks the launched profile.

## Model

Fields in `packages/catalog/src/profiles.ts`, copied into `OSDefinition` by `systems.ts`:

| Field | Role |
|---|---|
| `variantGroupId` | parent id; absent on the parent |
| `variantName` | short selector label |
| `variantOrder` | ascending priority; lowest = default; absent = after the ordered variants |

Each variant has its own image, profile, readiness and availability.

## Current groups

| Group | Order | Default |
|---|---|---|
| Debian (`debian-12-i386`) | XFCE, X11, CLI | XFCE |
| Windows 7 (`windows-7-x86`) | Professional, Lite | Professional |

## Helpers

`packages/catalog/src/systems.ts`:

- `getDisplaySystems()`: parents and standalone systems;
- `getVariantGroup()`: members sorted by `variantOrder`;
- `getDefaultVariant()`: first member;
- `getVariantParent()` / `getVariantParentId()`: parent resolution;
- `hasVariants()`: group with several entries.

Adding one: image (`images.ts`), profile (`profiles.ts`), `variantGroupId`, `variantName`, `variantOrder`, catalogue/UI/E2E tests. No React component to change.
