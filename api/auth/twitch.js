// Erlaubte Frontend-URLs für OAuth-Redirect
const ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:3000",
];

export default function handler(req, res) {
  const clientId = process.env.TWITCH_CLIENT_ID;
  const redirectUri = process.env.TWITCH_REDIRECT_URI;
  const frontendUrl = process.env.FRONTEND_URL || "";

  if (frontendUrl) {
    ALLOWED_ORIGINS.push(frontendUrl);
  }

  if (!clientId || !redirectUri) {
    return res.status(500).json({ error: "Twitch OAuth nicht konfiguriert" });
  }

  // Origin aus Query-Parameter oder Referer lesen
  const origin = req.query.origin || "";

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "user:read:email",
    state: origin,
  });

  res.redirect(`https://id.twitch.tv/oauth2/authorize?${params.toString()}`);
}
