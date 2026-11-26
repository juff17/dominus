# Terminal screenshots

Proof for backend and eval runs is a picture of the terminal output. Render
it from the saved output; never screenshot or drive a live terminal, a tmux
pane, or the user's hub.

1. **Run and save.** Run the command with colour on, saving its raw output
   and the command line:
   `FORCE_COLOR=1 <command> 2>&1 | tee <run>/terminal/NN-<name>.ansi`.
   Use the tool's own colour flag where `FORCE_COLOR` isn't read.
2. **Blank secrets.** Remove tokens, passwords and auth headers from the
   `.ansi` file before rendering. Search it for the values you used, and for
   `Bearer`, `Authorization`, `token=` and `password`.
3. **Header.** Put a header line above the output: the command, the branch,
   and the short commit (`git rev-parse --short HEAD`).
4. **Render to HTML.** Turn the ANSI into HTML in a dark terminal style:
   monospace, about 100 columns, line breaks kept. Use a converter if one
   is installed (`aha`, `ansi2html`); otherwise a short script in the run
   folder.
5. **Screenshot it.** Open the HTML in the browser (`frontend.md`) and take
   full-page screenshots.
6. **Split long output.** Output taller than about 60 lines is split into
   consecutive pages, top to bottom: `NN-<name>-1.png`, `-2.png`, and so
   on. Together they show the whole run, the "scroll".
7. **Check them.** The first image shows the command, branch and commit;
   the last shows the pass count. Look at every image before it goes into
   the report.

Only a fully passing run is captured for Jira. A failing run's output stays
as text in the run folder.
