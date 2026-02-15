import admin from "firebase-admin";
import * as cheerio from "cheerio";
import { requireAdmin, setCorsHeaders, checkRateLimit, getFirebaseAdmin } from "../middleware/auth.js";

const USER_AGENT = "GTR-GuessPlayer/1.0 (guess-the-rank project; contact via Discord @feliiiiix)";
const LIQUIPEDIA_API = "https://liquipedia.net/valorant/api.php";
const REQUEST_DELAY = 1200; // 1.2s between requests (Liquipedia rate limit)

const VCT_TEAMS = {
  Americas: [
    "Sentinels", "Cloud9", "100_Thieves", "NRG_Esports",
    "Evil_Geniuses", "LOUD", "FURIA_Esports", "MIBR",
    "Leviat%C3%A1n", "KR%C3%9C_Esports",
  ],
  EMEA: [
    "Fnatic", "Team_Liquid", "Team_Heretics", "Karmine_Corp",
    "Team_Vitality", "Natus_Vincere", "BBL_Esports",
    "Gentle_Mates", "FUT_Esports", "Giants_Gaming",
  ],
  Pacific: [
    "DRX", "T1", "Gen.G", "Paper_Rex",
    "Team_Secret", "Talon_Esports", "Global_Esports",
    "Rex_Regum_Qeon", "DetonatioN_FocusMe", "ZETA_DIVISION",
  ],
  China: [
    "EDward_Gaming", "Bilibili_Gaming", "FunPlus_Phoenix",
    "JDG_Gaming", "Nova_Esports", "All_Gamers",
    "Trace_Esports", "TYLOO", "Wolves_Esports",
    "Dragon_Ranger_Gaming",
  ],
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
    throw new Error(`Liquipedia API error: ${res.status} for ${pageName}`);
  }

  const data = await res.json();
  if (data.error) {
    throw new Error(`Liquipedia API error: ${data.error.info || data.error.code}`);
  }
  return data.parse?.text?.["*"] || "";
}

function parseRoster(html, teamName, region) {
  const $ = cheerio.load(html);
  const players = [];

  // Find active roster table - look for roster-card tables
  $("table.roster-card, table.wikitable").each((_, table) => {
    $(table).find("tr").each((_, row) => {
      const $row = $(row);

      // Look for player rows - they contain player links
      const playerLink = $row.find("td .inline-player a, td.ID a, td a[href*='/valorant/']").first();
      if (!playerLink.length) return;

      // Get player name from the link text
      const name = playerLink.text().trim();
      if (!name || name.length < 2) return;

      // Get player slug from href
      const href = playerLink.attr("href") || "";
      const slug = href.replace("/valorant/", "");
      if (!slug) return;

      // Skip non-player links (like team links, etc)
      if (slug.includes(":") || slug.includes("Category")) return;

      // Get country from flag image
      const flagImg = $row.find("span.flag img, .flag img").first();
      const country = flagImg.attr("alt") || "";

      // Check for IGL/Captain (crown icon)
      const isIGL = $row.find("i.fa-crown, .fa-crown").length > 0;

      // Avoid duplicates
      if (players.some((p) => p.slug === slug)) return;

      players.push({
        slug,
        name,
        country,
        team: teamName.replace(/_/g, " "),
        region,
        isIGL,
        role: "",
        transferHistory: [],
        manuallyEdited: false,
      });
    });
  });

  return players;
}

function parsePlayerDetails(html) {
  const $ = cheerio.load(html);
  const details = { role: "", transferHistory: [] };

  // Parse role from infobox
  $("div.fo-nttax-infobox > div").each((_, div) => {
    const label = $(div).find("div.infobox-description").text().trim();
    if (label === "Role:") {
      const value = $(div).find("div.infobox-description").next("div").text().trim();
      if (value) details.role = value;
    }
  });

  // Parse transfer history from infobox History section
  const historyHeader = $("div.infobox-header").filter(function () {
    return $(this).text().trim() === "History";
  });

  if (historyHeader.length) {
    // The history table is in the next sibling's infobox-center
    const historyContainer = historyHeader.parent().next();
    const historyTable = historyContainer.find("table");

    if (historyTable.length) {
      historyTable.find("tr").each((_, row) => {
        const cells = $(row).find("td");
        if (cells.length < 2) return;

        // Left cell: date range
        const dateText = $(cells[0]).text().trim();
        const dates = dateText.split("\u2014").map((d) => d.trim()); // em-dash

        // Right cell: team info
        const teamCell = $(cells[1]);
        const teamLink = teamCell.find("a").first();
        const teamName = teamLink.attr("title") || teamLink.text().trim();

        // Skip empty entries
        if (!teamName) return;

        // Check for loan/status indicator
        const statusSpan = teamCell.find("span[style*='font-style:italic']");
        const status = statusSpan.length
          ? statusSpan.text().trim().replace(/[()]/g, "")
          : null;

        // Skip loan/inactive/content creator entries
        if (status === "Loan" || status === "Inactive" || status === "Content Creator" || status === "Streamer") {
          return;
        }

        details.transferHistory.push({
          team: teamName,
          from: dates[0] || "",
          to: dates[1] || null,
        });
      });
    }
  }

  return details;
}

async function scrapeRosters() {
  const allPlayers = [];
  const errors = [];

  for (const [region, teams] of Object.entries(VCT_TEAMS)) {
    for (const teamSlug of teams) {
      try {
        console.log(`[Players] Scraping ${teamSlug} (${region})...`);
        const html = await fetchPage(teamSlug);
        const decodedTeamName = decodeURIComponent(teamSlug);
        const players = parseRoster(html, decodedTeamName, region);
        allPlayers.push(...players);
        console.log(`[Players] Found ${players.length} players for ${decodedTeamName}`);
      } catch (err) {
        console.error(`[Players] Error scraping ${teamSlug}: ${err.message}`);
        errors.push(`${teamSlug}: ${err.message}`);
      }
      await sleep(REQUEST_DELAY);
    }
  }

  return { players: allPlayers, errors };
}

async function scrapeDetails(existingPlayers, offset = 0, batchSize = 25) {
  const players = [...existingPlayers];
  const batch = players.slice(offset, offset + batchSize);
  const errors = [];
  let updated = 0;

  for (const player of batch) {
    // Skip manually edited players
    if (player.manuallyEdited) continue;

    try {
      console.log(`[Players] Fetching details for ${player.name}...`);
      const html = await fetchPage(player.slug);
      const details = parsePlayerDetails(html);

      // Find and update the player in the array
      const idx = players.findIndex((p) => p.slug === player.slug);
      if (idx !== -1) {
        if (details.role) players[idx].role = details.role;
        if (details.transferHistory.length > 0) {
          players[idx].transferHistory = details.transferHistory;
        }
        updated++;
      }
    } catch (err) {
      console.error(`[Players] Error fetching details for ${player.name}: ${err.message}`);
      errors.push(`${player.name}: ${err.message}`);
    }
    await sleep(REQUEST_DELAY);
  }

  return { players, updated, errors };
}

export default async function handler(req, res) {
  setCorsHeaders(res);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method === "PUT") {
    // Admin update endpoint
    const user = await requireAdmin(req, res);
    if (!user) return;

    try {
      const fb = getFirebaseAdmin();
      const dbRef = fb.firestore();
      const { players } = req.body;

      if (!Array.isArray(players)) {
        return res.status(400).json({ success: false, error: "players muss ein Array sein" });
      }

      await dbRef.doc("vctPlayers/current").set({
        players,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        count: players.length,
      });

      return res.json({
        success: true,
        message: `${players.length} Spieler gespeichert`,
      });
    } catch (err) {
      console.error("[Players] Update error:", err);
      return res.status(500).json({ success: false, error: "Speichern fehlgeschlagen" });
    }
  }

  // GET requests - scraping
  const user = await requireAdmin(req, res);
  if (!user) return;

  if (!checkRateLimit(user.uid, 3, 60000)) {
    return res.status(429).json({
      success: false,
      error: "Rate limit erreicht. Bitte warten Sie eine Minute.",
    });
  }

  const type = req.query.type || "rosters";

  try {
    const fb = getFirebaseAdmin();
    const dbRef = fb.firestore();

    if (type === "rosters") {
      console.log("[Players] Starting roster scrape...");
      const { players, errors } = await scrapeRosters();

      // Merge with existing data (preserve details + manual edits)
      const existingDoc = await dbRef.doc("vctPlayers/current").get();
      const existingPlayers = existingDoc.exists ? existingDoc.data().players || [] : [];

      const mergedPlayers = players.map((newPlayer) => {
        const existing = existingPlayers.find((p) => p.slug === newPlayer.slug);
        if (existing) {
          return {
            ...newPlayer,
            role: existing.manuallyEdited ? existing.role : (existing.role || newPlayer.role),
            transferHistory: existing.manuallyEdited ? existing.transferHistory : (existing.transferHistory?.length > 0 ? existing.transferHistory : newPlayer.transferHistory),
            manuallyEdited: existing.manuallyEdited || false,
          };
        }
        return newPlayer;
      });

      await dbRef.doc("vctPlayers/current").set({
        players: mergedPlayers,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        count: mergedPlayers.length,
      });

      return res.json({
        success: true,
        count: mergedPlayers.length,
        errors: errors.length > 0 ? errors : undefined,
        message: `${mergedPlayers.length} Spieler aus ${Object.keys(VCT_TEAMS).length} Regionen aktualisiert`,
      });
    }

    if (type === "details") {
      const offset = parseInt(req.query.offset || "0", 10);
      const batchSize = 25;

      const existingDoc = await dbRef.doc("vctPlayers/current").get();
      if (!existingDoc.exists) {
        return res.status(400).json({
          success: false,
          error: "Keine Spielerdaten vorhanden. Bitte zuerst Rosters synchronisieren.",
        });
      }

      const existingPlayers = existingDoc.data().players || [];
      console.log(`[Players] Fetching details batch at offset ${offset} (${batchSize} players)...`);

      const { players: updatedPlayers, updated, errors } = await scrapeDetails(existingPlayers, offset, batchSize);

      await dbRef.doc("vctPlayers/current").set({
        players: updatedPlayers,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        count: updatedPlayers.length,
      });

      const remaining = Math.max(0, existingPlayers.length - (offset + batchSize));
      return res.json({
        success: true,
        updated,
        remaining,
        nextOffset: remaining > 0 ? offset + batchSize : null,
        errors: errors.length > 0 ? errors : undefined,
        message: `${updated} Spieler-Details aktualisiert. ${remaining > 0 ? `Noch ${remaining} übrig.` : "Alle Details geladen!"}`,
      });
    }

    return res.status(400).json({
      success: false,
      error: "type muss 'rosters' oder 'details' sein",
    });
  } catch (err) {
    console.error("[Players] Scrape error:", err);
    const isDev = process.env.NODE_ENV === "development";
    return res.status(500).json({
      success: false,
      error: isDev ? `Scraping fehlgeschlagen: ${err.message}` : "Interner Serverfehler beim Scraping",
    });
  }
}
