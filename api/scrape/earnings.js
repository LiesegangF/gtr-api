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
    if (i === 0) return; // Header überspringen

    const cells = $(row).find("td");
    if (cells.length < 7) return;

    const name = $(cells[1]).find(".name a").first().text().trim();
    const earningsText = $(cells[cells.length - 1]).text().trim();
    const earnings = parseInt(earningsText.replace(/[$,]/g, ""), 10);

    // Land aus Flag-Image alt-Text
    const countryImg = $(cells[1]).find(".flag img").first();
    const country = countryImg.attr("alt") || "";

    if (name && !isNaN(earnings) && earnings > 0) {
      players.push({
        name,
        earnings,
        country,
        type: "player",
      });
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

    const name = $(cells[1]).find("a").first().text().trim();
    const earningsText = $(cells[cells.length - 1]).text().trim();
    const earnings = parseInt(earningsText.replace(/[$,]/g, ""), 10);

    if (name && !isNaN(earnings) && earnings > 0) {
      teams.push({
        name,
        earnings,
        type: "team",
      });
    }
  });

  return teams;
}

export default async function handler(req, res) {
  // CORS Headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-scrape-secret");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // Einfacher Auth-Check: nur mit Secret aufrufbar
  const secret = req.headers["x-scrape-secret"] || req.query.secret;
  if (secret !== process.env.SCRAPE_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    // 1. Spieler-Daten holen
    console.log("Fetching player earnings...");
    const playersHtml = await fetchPage("Portal:Statistics/Player_earnings");
    const players = parsePlayers(playersHtml);
    console.log(`Parsed ${players.length} players`);

    // Rate Limit: 30s zwischen Parse-Requests
    await new Promise((r) => setTimeout(r, 31000));

    // 2. Team-Daten holen
    console.log("Fetching team earnings...");
    const teamsHtml = await fetchPage("Portal:Statistics/Organization_Winnings");
    const teams = parseTeams(teamsHtml);
    console.log(`Parsed ${teams.length} teams`);

    // 3. In Firestore speichern
    const fb = getFirebaseAdmin();
    const db = fb.firestore();

    // Spieler speichern (als ein Dokument mit Array - effizienter)
    await db.doc("earnings/players").set({
      data: players,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      count: players.length,
    });

    // Teams speichern
    await db.doc("earnings/teams").set({
      data: teams,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      count: teams.length,
    });

    res.json({
      success: true,
      players: players.length,
      teams: teams.length,
      message: `${players.length} Spieler und ${teams.length} Teams aktualisiert`,
    });
  } catch (err) {
    console.error("Scrape error:", err);
    res.status(500).json({ error: err.message });
  }
}
