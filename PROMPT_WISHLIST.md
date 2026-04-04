# Command Wishlist

Prompts that Wrap should handle well but doesn't yet. Each entry has the prompt and a short description of what it should do.

---

- **"In my Global Claude skills, there is an interview skill. Can you show it to me?"**
  Should probe where global Claude skills live, list available skills, find the matching file, and `cat` it.

- **"how was my week compared to last week according to git? what were some of the major things I accomplished each week"**
  Should probe `git log` for both weeks, synthesize a comparison, and answer with highlights and themes — not just list commits.
