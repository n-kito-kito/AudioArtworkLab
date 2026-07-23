# Design QA

- Source visual truth: Figma desktop UI screenshot attached in the user request on 2026-07-23
- Implementation screenshot: unavailable
- Intended viewport: desktop, 2048 × 1080 reference
- Source pixel dimensions: 2048 × 1080
- Implementation pixel dimensions: unavailable
- CSS viewport and density normalization: unavailable
- State: dark workspace with a selected canvas layer

## Full-view comparison evidence

Blocked. The reference screenshot is available in the conversation, but this execution environment
reports no connected browser, so a browser-rendered implementation screenshot could not be captured.

## Focused region comparison evidence

Blocked for the same reason. The intended focused regions are the floating object toolbar, the
resizable left Source/Layers split, the top toolbar, and the right Design/Effects inspector.

## Implemented design changes

- Reorganized the right inspector into Design and Effects tabs.
- Moved the effect chain from the bottom bar into a vertical Effect Stack.
- Removed Modifier as a separate left-panel category and grouped those processors with effects.
- Moved Image, Circle, Wave, Text, Rectangle, Line, Polygon, and Draw into a compact floating
  toolbar at the bottom of the canvas.
- Split the left panel into an independently scrollable source/control area above and Layers area
  below.
- Added a pointer-draggable and keyboard-accessible divider for resizing the two left-panel areas.
- Converted panel headings and control copy from all caps to sentence case.
- Removed Composition from the left panel and placed Artwork at the top of the Effects inspector.
- Added a None artwork state so a fresh workspace starts as an empty black canvas.
- Made layer canvas texture changes request an immediate WebGL render for live transform, style,
  add, delete, and reorder feedback.
- Reconnects the overlay textures when an object property becomes dirty, matching the refresh path
  that previously occurred only after changing Artwork.
- Added a Figma-style selection box with eight resize handles and direct drag-to-move behavior.
- Replaced transform sliders with Figma-style numeric X, Y, W, H, rotation, and opacity fields.
- Standardized object position and size editing on a 1600 × 1600 px canvas coordinate system.
- Added independent Fill and Stroke controls, including color, enable state, and pixel stroke width.
- Added a Figma-style color popover for Fill, Stroke, and text color.
- Added synchronized native palette, Hex code, RGB channel, and reusable swatch inputs.
- Added per-layer Apply effects routing and a clean overlay pass after the global effect chain.
- New text layers use the global effect stack by default and can opt out independently with
  Apply global effects.
- Replaced the font source/free-form pair with one grouped font selector containing a broad set of
  Google Fonts and common system fonts.
- Retained Custom font as a fallback for exact local font-family names, with availability feedback
  and preset persistence for font source and effect routing.
- Replaced the long, scroll-dependent effect inspector with a compact Effect Stack and contextual
  floating settings popover.
- The effect popover keeps Enabled, Intensity, React to, effect order, and Quick looks together,
  and supports outside-click, close-button, and Escape dismissal.
- Added direct layer reordering from the six-dot handle, with a visible insertion line, immediate
  canvas stack synchronization, and keyboard Arrow Up/Down support on the handle.
- Added schema-driven Effect controls so number, boolean, color, and select parameters render
  without Effect-specific StudioControls code.
- Added per-number-parameter Audio Mapping controls for source, amount, min/max, smoothing, and
  inversion, allowing one Effect to react to multiple audio bands independently.
- Added common Dry/Wet, Effect opacity, and Normal/Add/Screen/Multiply/Difference blend controls
  through a shared shader wrapper, with neutral defaults that preserve existing output.
- Added automatic migration from legacy percentage-based layer presets to pixel coordinates.
- Replaced the fluorescent green UI accent with a Figma-like blue selection color.
- Kept Export PNG as the visually prominent blue primary action.
- Tightened toolbar, panel, row, button, label, and control spacing to match a dense desktop editor.

## Required fidelity surfaces

- Fonts and typography: code-reviewed only; browser rendering unavailable.
- Spacing and layout rhythm: code-reviewed only; browser rendering unavailable.
- Colors and visual tokens: neutral dark gray palette and blue semantic accent implemented.
- Image quality and asset fidelity: no new raster assets required; existing Phosphor icon library retained.
- Copy and content: application terminology retained and normalized to sentence case.

## Findings

- [P1] Visual comparison is unavailable.
  - Evidence: no browser is connected to the execution environment.
  - Impact: per-layer effect bypass, remote/local font loading, font fallback feedback, effect
    popover placement and dismissal, layer drag-and-drop ordering, and inspector layout cannot be
    confirmed in a real browser.
  - Fix: capture the deployed application at the reference viewport and compare it with the supplied
    Figma screenshot.

## Primary interactions tested

- Not browser-tested because no browser is connected.
- TypeScript, ESLint, and Vite production build checks passed.
- Browser console errors could not be checked.

## Comparison history

- Initial implementation: structural and token changes completed.
- Post-fix visual evidence: unavailable because browser capture is blocked.

final result: blocked
