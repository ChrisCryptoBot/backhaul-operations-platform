Redesign the desktop dispatch desk in this code base (the folder `dispatch-desk/`).

Start with `dispatch-desk/docs/DESK_REDESIGN_BRIEF.md`. It tells you what the desk is, what it has to keep saying, where every screen, component, stylesheet, data model, sample dataset and doc lives, and what to hand back. It is context, not direction: the look is yours.

What I want, in my words: I don't know how to really explain this look, but I want to adopt it. It looks serious and not like AI slop. My edges are so rounded that everything looks like Pixar, or too silly to be taken seriously. The look I'm pointing at is professional and intentional, and even though my system is built on real mechanics, it could be mistaken for AI slop. How can we reconcile? I like what I have, but I'm not so in love with it that I wouldn't give it up for a Bloomberg-type look. Redesign what I have to fit that, based on what this product actually is.

The reference is the Bloomberg Terminal; a screenshot is at `dispatch-desk/docs/design-reference/bloomberg-terminal-clone-reference.png`. I can't tell you which parts matter. Work that out.

Do two things, in this order:
1. Tell me how to reconcile. Looking at this code and its styles, what specifically makes the desk read as generic or machine-made despite real mechanics, and what does reconciling mean for this product? Short, specific, pointing at files and screens.
2. Redesign the whole desk, every screen and state in the brief, as real code that uses the actual data shapes and seed data.

Ground rules:
- Desktop dispatch desk only. Do not change or redesign the mobile app or the marketing site; read them for context.
- The "Design System" attached to this project is the phone app's. Ignore it.
- Keep what numbers are called and what the verdict means (brief section 4). Don't change the audited math.
- Never open or quote any `.env*` file or secret.
- Hand back: your answer to (1), the screens, the shared system, and an `INTEGRATION.md` mapping each screen to the existing files it replaces. Flag anything the code can't do today. Don't invent it. List behaviour changes as proposals, separately.
