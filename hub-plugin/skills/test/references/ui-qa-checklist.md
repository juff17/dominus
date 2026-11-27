# UI QA checklist

Pick the checks that fit what the change touched, the way a QA tester
would. A copy change needs a look at overflow and little else. A new form
needs most of this. Run the picked checks on the screens the change touches,
and say in `report.md` which you ran and why you skipped the rest.

| Area | Run it when the change | Checks |
| --- | --- | --- |
| Window size | Adds or changes layout | The widths the app supports (390 mobile, 1280 laptop, 1920 wide), and shrinking the window live from wide to narrow |
| Overflow | Adds or changes text, lists or numbers | Long text and names, many items, no items, and huge numbers clip, wrap or get an ellipsis as designed, with nothing spilling out |
| Alignment | Adds or moves components | Components line up, spacing is consistent, and nothing shifts as content loads |
| Scrolling | Adds a scroll area, sticky header or long list | Scroll containers, sticky headers, and the scroll position after going back |
| Loading | Fetches data | Skeletons or spinners, a throttled network, and a refresh mid-load |
| States | Adds a view of data | Empty, loading, error, disabled and success can each be reached, and each is styled |
| Interaction | Adds controls | Double click, keyboard only, visible focus, and Esc closing dialogs |
| Forms | Adds or changes a form | Validation messages, paste, very long input, submitting twice, and submitting offline |
| Navigation | Adds or changes routes | Back and forward, deep links, and a refresh on each new route |
| Errors | Always | Console errors and failed requests, and API errors shown sensibly |
| Accessibility | Adds controls or images | Labels on inputs and icon buttons, contrast, and alt text |

Make the data a check needs where you can, like a long name or many items,
through the app's own UI or a seed script. Clean it up after the run, or
leave it marked as test data. A check that can't be done here, such as one
on a real phone, goes in the report as not tested, with the reason.
