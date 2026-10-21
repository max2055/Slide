---
name: image-to-code
description: "Implement a website or UI from supplied screenshots or selected visual references, preserving the reference and the existing project design system."
---

# Image to Code

Use for screenshot/reference implementation tasks. Use the user's reference as the primary visual source; do not replace it with a new generated design.

## Reference analysis

Inspect the reference before implementation. Record the visible layout, component hierarchy, alignment, gutters, type scale, line wrapping, colors, borders, image treatment and viewport size. Read original images at useful resolution; inspect sections or crops when that reveals detail. Do not infer functional behavior solely from pixels.

Separate observed details from assumptions. For unreadable labels, use supplied copy or existing product text. Ask only when missing reference content materially affects the intended result; continue independent implementation while awaiting it.

## Optional image generation

Generate a design reference only when the task requests or benefits from creating a new visual direction and the relevant image tool is available. Use enough resolution to inspect the requested sections; there is no fixed per-section image quota. Generation is optional and must not block coding from a usable supplied reference. If the user explicitly requires generated artwork as a deliverable, report its actual status and do not claim it was produced when unavailable.

## Implementation

1. Inspect the existing framework, shared components, tokens and asset paths.
2. Map the reference to existing components and tokens. In Slide, use Lit and the shared components in AGENTS.md; preserve data density, behavior and accessibility. Explain material differences where an exact visual match conflicts with the project contract.
3. Build real semantic controls and responsive layout. Preserve accurate content and asset proportions. Avoid unnecessary nested containers and decorative labels.
4. Verify the rendered result at the reference viewport and a relevant narrower viewport. Compare alignment, text wrapping, spacing, overflow and interactive states. Correct material deviations within scope.
5. Deliver the implementation and describe verified fidelity and remaining limitations. A mockup alone does not complete an implementation request.
