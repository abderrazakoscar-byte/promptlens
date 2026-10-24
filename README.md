# PromptLens

Image-to-prompt web tool with login and credits.
- `index.html` + `config.js`: the page (Supabase login, credit badge)
- `netlify/functions/generate.js`: checks login, uses 1 credit, calls Gemini
- `netlify/functions/me.js`: returns the user's remaining credits
- `supabase.sql`: creates the profiles table and the credit functions

## Limits
Free: 5 prompts per day. Pro: 300 per month. Change the numbers inside `supabase.sql` (`lim := 5` / `lim := 300`).
Until a payment system is connected, make someone Pro by hand: Supabase -> Table Editor -> profiles -> set `plan` to `pro`.

## Environment variables (Netlify)
- `GEMINI_API_KEY`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`  (SECRET: Netlify only, never in config.js or GitHub)
- Optional `GEMINI_MODEL` (default `gemini-2.5-flash-lite`)

## config.js (public values only)
`SUPABASE_URL` and `SUPABASE_ANON_KEY` (anon / publishable key).
