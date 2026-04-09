# Command Wishlist

Prompts that Wrap should handle well but doesn't yet. Each entry has the prompt and a short description of what it should do.

---

- **"In my Global Claude skills, there is an interview skill. Can you show it to me?"**
  Should probe where global Claude skills live, list available skills, find the matching file, and `cat` it.

- **"how was my week compared to last week according to git? what were some of the major things I accomplished each week"**
  Should probe `git log` for both weeks, synthesize a comparison, and answer with highlights and themes — not just list commits.

- **"explain the command first"** (typed as feedback in the dialog after Wrap proposes a command)

  Example: `w run tests and pipe the output to output.log` opens a dialog with the proposed command. User types `explain the command first` as feedback in the dialog. Today Wrap answers with the explanation and exits, killing the command. Wanted: the explanation appears inside the same dialog with the command still proposed, so the user can type `ok run it` as feedback to confirm.
