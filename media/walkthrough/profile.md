# Personalize Codeep

Codeep can adapt to **how you like to work** — your reply language, how concise
you want answers, your default stack, and "always / never" rules. It reads a
small profile file on every request, so the agent behaves like it knows you.

### Edit your profile

Run **Codeep: Edit Profile** to open (or create) `~/.codeep/profile.md` — your
global profile, used on every project. Fill in a few lines, e.g.:

```md
## Preferences
- Reply language: English
- Response style: concise
## My stack
- Languages: TypeScript, SQL
```

Run **Codeep: Edit Project Profile** for a per-repo profile
(`.codeep/profile.md`) — its role, goals, and constraints.

### Let Codeep learn (optional)

Run **Codeep: Toggle Profile Auto-Learn** and Codeep will quietly pick up your
durable preferences from sessions. Review them anytime with the CLI `/me`, and
clear with `/me forget`. It's off until you turn it on.
