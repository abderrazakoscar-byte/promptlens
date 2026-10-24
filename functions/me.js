// Returns the logged-in user's remaining credits.
// Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Netlify environment variables.

const reply = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

async function getUser(authHeader) {
  const token = (authHeader || "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  try {
    const r = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return null;
    const u = await r.json();
    return u && u.id ? u : null;
  } catch {
    return null;
  }
}

async function rpc(name, args) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/${name}`, {
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

exports.handler = async (event) => {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY)
    return reply(500, { error: "Server is missing Supabase settings." });
  const user = await getUser(event.headers.authorization || event.headers.Authorization);
  if (!user) return reply(401, { error: "Not logged in." });
  const credits = await rpc("get_credits", { uid: user.id });
  if (!credits) return reply(500, { error: "Couldn't read credits." });
  return reply(200, credits);
};
