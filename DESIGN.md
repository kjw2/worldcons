# WORLD CONS public design system

WORLD CONS is a legal research archive, not a SaaS landing page. Public pages should feel like a calm institutional index: dense enough for research, easy to scan, and visually subordinate to the legal material.

## Typography

- Use the system Korean sans stack already defined by `--font-system-sans`.
- Use weight, size, spacing, and rules for hierarchy; do not simulate editorial authority with uppercase eyebrow/kicker labels.
- Keep functional text at 12px or larger. Body copy should normally be 14–16px with generous line height.
- Avoid crushed tracking. Headings may use only mild negative tracking.
- Keep long explanatory copy within a readable measure (roughly 65–75ch).

## Color

- Public surfaces use neutral white / cool gray with one restrained navy accent (`archive-accent`).
- Use solid colors only. No gradients, radial glows, neon, glassmorphism, or decorative transparency.
- Do not use beige/cream as a public-page aesthetic. Legacy parchment tokens are admin-only.
- Muted text must retain sufficient contrast against its actual background.

## Shape and elevation

- Public containers use square or 2px corners (`rounded-sm`) when a radius is needed.
- Tags may be compact pills only when the shape conveys taxonomy; ordinary buttons and panels are not pills.
- Prefer borders and whitespace over shadows. Public cards must not combine hairline borders with diffuse shadows.
- Avoid decorative side tabs, thick accent stripes, and repeated 2px top accents.

## Layout

- Prefer lists, tables, definition lists, and section rules for legal data.
- Avoid repeated same-size feature/KPI card grids, nested cards, and card-inside-card layouts.
- Use tighter spacing inside a semantic group and larger spacing between sections.
- Icons are supporting affordances, never oversized decoration.
- Country flags are small identifiers, not hero artwork.

## Motion

- Motion must communicate state. Loading progress may animate, but do not add glow, bounce, blur, floating status pills, marquees, or decorative movement.
- Hover should change text, border, or background subtly; do not scale content or add elevation.

## Copy

- Say each thing once. Avoid label + sublabel + helper copy that repeats the same meaning.
- Section titles should be descriptive Korean phrases. Do not prepend generic labels such as `FEATURES`, `LATEST CASES`, `RELATED CASES`, or numbered editorial kickers.

## Public-page review checklist

Before shipping a public UI change, verify that it introduces none of the following: gradients, glow, backdrop blur, diffuse card shadows, eyebrow/kicker headings, side-tab accents, repetitive metric cards, nested cards, oversized icons, decorative animation, redundant copy, or undersized functional text.
