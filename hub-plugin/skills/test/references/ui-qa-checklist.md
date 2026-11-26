# UI QA checklist

Run it on every screen in the ticket's flow, not only the ones the ticket
names. Note each check as pass, fail or not applicable in `report.md`.

| Area | Checks |
| --- | --- |
| Window size | Common widths (390 mobile, 768 tablet, 1280 laptop, 1920 wide); shrink the window live from wide to narrow; the minimum width; 200% zoom |
| Overflow | Long text and names, many items, huge numbers, no items; text clipped, wrapped or given an ellipsis as designed; nothing spills out of its container |
| Alignment | Components line up on the grid; spacing is consistent; icons are centred; nothing shifts when content loads |
| Scrolling | Scroll containers, sticky headers, nested scroll, the scroll position after navigating back |
| Loading | Skeletons and spinners; a slow network (throttled); refresh mid-load; a hard refresh keeps the state it should |
| States | Empty, loading, error, disabled, success: each one can be reached and is styled |
| Interaction | Double click; keyboard only; tab order; visible focus; Esc closes dialogs; hover and active states |
| Forms | Validation messages, paste, very long input, submit twice, submit with the network off |
| Navigation | Back and forward, deep links, refresh on every route, an unsaved-changes prompt |
| Errors | Console errors and warnings, failed network requests, 4xx/5xx from the API shown sensibly |
| Visual | Fonts load; dark mode if the app has it; images are sized; no layout shift |
| Accessibility basics | Labels on inputs and icon buttons, contrast, alt text |

- Make the data for a check where you can: a long name, many items. Use the
  app's own UI or a seed script. Data you make is cleaned up after the run,
  or left marked as test data.
- A check that can't be done here, such as a real mobile device, goes in
  the report as not tested, with the reason.
