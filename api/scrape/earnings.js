import admin from "firebase-admin";
import * as cheerio from "cheerio";

function getFirebaseAdmin() {
  if (!admin.apps.length) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  }
  return admin;
}

const USER_AGENT = "GTR-HigherLower/1.0 (guess-the-rank project; contact via Discord @feliiiiix)";
const LIQUIPEDIA_API = "https://liquipedia.net/valorant/api.php";

async function fetchPage(pageName) {
  const params = new URLSearchParams({
    action: "parse",
    page: pageName,
    format: "json",
    prop: "text",
  });

  const res = await fetch(`${LIQUIPEDIA_API}?${params}`, {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept-Encoding": "gzip",
    },
  });

  if (!res.ok) {
    throw new Error(`Liquipedia API error: ${res.status}`);
  }

  const data = await res.json();
  return data.parse?.text?.["*"] || "";
}

function parsePlayers(html) {
  const $ = cheerio.load(html);
  const players = [];

  $("table.wikitable tr").each((i, row) => {
    if (i === 0) return;
    const cells = $(row).find("td");
    if (cells.length < 7) return;

    const name = $(cells[1]).find(".name a").first().text().trim();
    const earningsText = $(cells[cells.length - 1]).text().trim();
    const earnings = parseInt(earningsText.replace(/[$,]/g, ""), 10);
    const countryImg = $(cells[1]).find(".flag img").first();
    const country = countryImg.attr("alt") || "";

    if (name && !isNaN(earnings) && earnings > 0) {
      players.push({ name, earnings, country, type: "player" });
    }
  });

  return players;
}

function parseTeams(html) {
  const $ = cheerio.load(html);
  const teams = [];

  $("table.wikitable tr").each((i, row) => {
    if (i === 0) return;
    const cells = $(row).find("td");
    if (cells.length < 7) return;

    // Team-Zelle hat Logo-Link (nur img, kein Text) und dann den Teamnamen-Link
    // Finde den ersten <a> mit tatsächlichem Text
    let name = "";
    $(cells[1]).find("a").each((_, a) => {
      const text = $(a).text().trim();
      if (text && !name) {
        name = text;
      }
    });

    const earningsText = $(cells[cells.length - 1]).text().trim();
    const earnings = parseInt(earningsText.replace(/[$,]/g, ""), 10);

    if (name && !isNaN(earnings) && earnings > 0) {
      teams.push({ name, earnings, type: "team" });
    }
  });

  return teams;
}

export default async function handler(req, res) {
  const allowedOrigin = process.env.FRONTEND_URL || "";
  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // Auth: Firebase ID Token prüfen + Admin-Check
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Nicht autorisiert" });
  }

  const idToken = authHeader.split("Bearer ")[1];

  let uid;
  try {
    const fb = getFirebaseAdmin();
    const decoded = await fb.auth().verifyIdToken(idToken);
    uid = decoded.uid;
  } catch {
    return res.status(401).json({ error: "Nicht autorisiert" });
  }

  // Admin-Prüfung in Firestore
  const fb = getFirebaseAdmin();
  const dbRef = fb.firestore();

  const userDoc = await dbRef.doc(`users/${uid}`).get();
  if (!userDoc.exists || !userDoc.data().isAdmin) {
    return res.status(403).json({ error: "Keine Admin-Berechtigung" });
  }

  // type=players oder type=teams (ein Request pro Aufruf wegen 10s Timeout)
  const type = req.query.type || "players";

  try {

    if (type === "players") {
      const html = await fetchPage("Portal:Statistics/Player_earnings");
      const players = parsePlayers(html);

      await dbRef.doc("earnings/players").set({
        data: players,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        count: players.length,
      });

      return res.json({ success: true, count: players.length, message: `${players.length} Spieler aktualisiert` });
    }

    if (type === "teams") {
      const html = await fetchPage("Portal:Statistics/Organization_Winnings");
      const teams = parseTeams(html);

      await dbRef.doc("earnings/teams").set({
        data: teams,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        count: teams.length,
      });

      return res.json({ success: true, count: teams.length, message: `${teams.length} Teams aktualisiert` });
    }

    return res.status(400).json({ error: "type muss 'players' oder 'teams' sein" });
  } catch (err) {
    console.error("Scrape error:", err);
    res.status(500).json({ error: "Interner Serverfehler beim Scraping" });
  }
}
