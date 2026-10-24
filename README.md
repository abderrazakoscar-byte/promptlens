# PromptLens (Cloudflare Pages version)

- index.html + config.js : the page
- functions/generate.js  : POST /generate  (login check, 1 credit, Gemini)
- functions/me.js        : /me             (remaining credits)
- supabase.sql           : database (already run in Supabase)

Cloudflare Pages -> Settings -> Variables and Secrets:
GEMINI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (add as Secret). Optional: GEMINI_MODEL.
