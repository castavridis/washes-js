Washes — conversation transcripts
==================================

This is the multi-session conversation arc that built the Washes
watercolor library from v0.1 through v0.98. The work spans 21
individual Claude sessions: Claude has limited context per session,
so longer projects hand off context via session summaries.

How to read these
-----------------
journal.txt        Index of all 21 sessions in chronological order,
                   with a brief summary of what each session worked
                   on. Start here for a roadmap.

Each session is a .txt file named:
  YYYY-MM-DD-HH-MM-SS-<slug>.txt

The slug indicates what shipped in that session (e.g.
"v064-deluge-cross-fix" was the v0.64 release that fixed a deluge
direction cross-artifact).

The files are raw JSON-serialized conversation logs — each turn is
a Content block. Search-friendly for finding specific discussions;
reading start-to-finish is possible but long (~25 MB of text).

What is NOT in here
-------------------
- The current in-progress session where you asked me to package
  this. That turn isn't a transcript yet — it's still live.
- Any other unrelated conversations.

Companion archive
-----------------
For the code artifacts these conversations produced (the library,
demos, examples, docs), see washes-bundle.zip in the same outputs
folder.
