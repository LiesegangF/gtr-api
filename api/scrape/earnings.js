import admin from "firebase-admin";
import * as cheerio from "cheerio";
import { requireAdmin, setCorsHeaders, checkRateLimit, getFirebaseAdmin } from "../middleware/auth.js";

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
  // CORS Headers setzen
  setCorsHeaders(res);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // Admin-Authentifizierung (kombiniert Token-Check + Admin-Status)
  const user = await requireAdmin(req, res);
  if (!user) return; // Response wurde bereits gesendet

  // Rate Limiting: Max 5 Requests pro Minute pro Admin
  if (!checkRateLimit(user.uid, 5, 60000)) {
    return res.status(429).json({
      success: false,
      error: "Rate limit erreicht. Bitte warten Sie eine Minute."
    });
  }

  // type=players oder type=teams (ein Request pro Aufruf wegen 10s Timeout)
  const type = req.query.type || "players";

  try {
    const fb = getFirebaseAdmin();
    const dbRef = fb.firestore();

    if (type === "players") {
      console.log("[Earnings] Fetching player data from Liquipedia...");
      const html = await fetchPage("Portal:Statistics/Player_earnings");
      const players = parsePlayers(html);

      await dbRef.doc("earnings/players").set({
        data: players,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        count: players.length,
      });

      console.log(`[Earnings] Successfully updated ${players.length} players`);
      return res.json({
        success: true,
        count: players.length,
        message: `${players.length} Spieler aktualisiert`
      });
    }

    if (type === "teams") {
      console.log("[Earnings] Fetching team data from Liquipedia...");
      const html = await fetchPage("Portal:Statistics/Organization_Winnings");
      const teams = parseTeams(html);

      await dbRef.doc("earnings/teams").set({
        data: teams,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        count: teams.length,
      });

      console.log(`[Earnings] Successfully updated ${teams.length} teams`);
      return res.json({
        success: true,
        count: teams.length,
        message: `${teams.length} Teams aktualisiert`
      });
    }

    return res.status(400).json({
      success: false,
      error: "type muss 'players' oder 'teams' sein"
    });

  } catch (err) {
    console.error("[Earnings] Scrape error:", err);

    // Generische Error-Message für Production
    const isDev = process.env.NODE_ENV === "development";
    const errorMessage = isDev
      ? `Scraping fehlgeschlagen: ${err.message}`
      : "Interner Serverfehler beim Scraping";

    return res.status(500).json({
      success: false,
      error: errorMessage
    });
  }
}
