# Terminal screenshots

The proof for backend and eval runs is a picture of the terminal output.
Render it from saved output. Never screenshot or drive a live terminal, a
tmux pane, or the user's hub.

1. Run the command with colour on, and save its output with a header line
   naming the command, the branch and the short commit:
   `FORCE_COLOR=1 <command> 2>&1 | tee <run>/terminal/NN-<name>.ansi`.
2. Remove tokens, passwords and auth headers from the file.
3. Turn it into HTML in a dark terminal style (`aha` or `ansi2html` if
   installed, else a short script in the run folder), open it in the
   browser, and take full-page screenshots. Output too tall for one page
   goes in consecutive pages, top to bottom, so together they show the whole
   run.

Look at each image before it goes in the report. Only a fully passing run is
captured. A failing run's output stays as text in the run folder.
