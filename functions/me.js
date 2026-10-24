// Cloudflare Pages Function: GET /me  (returns the logged-in user's remaining credits)
// Variables: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

const reply = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

async function getUser(env, authHeader) {
  const token = (authHeader || "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  try {
    const r = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return null;
    const u = await r.json();
    return u && u.id ? u : null;
  } catch {
    return null;
  }
}

async function rpc(env, name, args) {
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    const r = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(args),
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

export async function onRequest({ request, env }) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY)
    return reply(500, { error: "Server is missing Supabase settings." });
  const user = await getUser(env, request.headers.get("authorization"));
  if (!user) return reply(401, { error: "Not logged in." });
  const credits = await rpc(env, "get_credits", { uid: user.id });
  if (!credits) return reply(500, { error: "Couldn't read credits." });
  return reply(200, credits);
}
