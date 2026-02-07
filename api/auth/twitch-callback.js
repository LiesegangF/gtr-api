import admin from "firebase-admin";

function getFirebaseAdmin() {
  if (!admin.apps.length) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  }
  return admin;
}

export default async function handler(req, res) {
  const { code } = req.query;
  const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173";

  if (!code) {
    return res.redirect(`${frontendUrl}/auth?error=no_code`);
  }

  try {
    // 1. Code gegen Access Token tauschen
    const tokenRes = await fetch("https://id.twitch.tv/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.TWITCH_CLIENT_ID,
        client_secret: process.env.TWITCH_CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
        redirect_uri: process.env.TWITCH_REDIRECT_URI,
      }),
    });

    const tokenData = await tokenRes.json();

    if (!tokenRes.ok) {
      console.error("Twitch token error:", tokenData);
      return res.redirect(`${frontendUrl}/auth?error=token_failed`);
    }

    // 2. Twitch User-Info holen
    const userRes = await fetch("https://api.twitch.tv/helix/users", {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        "Client-Id": process.env.TWITCH_CLIENT_ID,
      },
    });

    const userData = await userRes.json();
    const twitchUser = userData.data?.[0];

    if (!twitchUser) {
      return res.redirect(`${frontendUrl}/auth?error=no_user`);
    }

    // 3. Firebase Admin initialisieren
    const fb = getFirebaseAdmin();
    const db = fb.firestore();
    const uid = `twitch_${twitchUser.id}`;

    // 4. User in Firestore erstellen/aktualisieren
    const userRef = db.collection("users").doc(uid);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      // Neuer User
      await userRef.set({
        username: twitchUser.display_name.toLowerCase(),
        twitchId: twitchUser.id,
        twitchUsername: twitchUser.display_name,
        profilePicture: twitchUser.profile_image_url || null,
        isAdmin: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        singleplayerStats: {
          gamesPlayed: 0,
          totalScore: 0,
          bestScore: 0,
          answeredClips: [],
        },
        survivalStats: { highScore: 0, gamesPlayed: 0 },
      });
    } else {
      // Bestehendem User Twitch-Profilbild updaten (nur wenn kein eigenes gesetzt)
      const existing = userDoc.data();
      const updates = {
        twitchUsername: twitchUser.display_name,
      };
      // Nur Profilbild updaten wenn noch keins manuell gesetzt wurde
      if (!existing.profilePicture || existing.profilePicture.includes("twitch")) {
        updates.profilePicture = twitchUser.profile_image_url || null;
      }
      await userRef.update(updates);
    }

    // 5. Firebase Custom Token erstellen
    const customToken = await fb.auth().createCustomToken(uid);

    // 6. Redirect zum Frontend mit Token
    res.redirect(`${frontendUrl}/auth?token=${encodeURIComponent(customToken)}`);
  } catch (err) {
    console.error("Twitch callback error:", err);
    res.redirect(`${frontendUrl}/auth?error=server_error`);
  }
}
