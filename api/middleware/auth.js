/**
 * Authentication & Authorization Middleware für Vercel API
 *
 * Verwendung:
 * import { requireAdmin } from '../middleware/auth.js';
 *
 * export default async function handler(req, res) {
 *   const user = await requireAdmin(req, res);
 *   if (!user) return; // Response wurde bereits gesendet
 *
 *   // Hier der geschützte Code
 * }
 */

import admin from "firebase-admin";

/**
 * Initialisiert Firebase Admin SDK
 */
export function getFirebaseAdmin() {
  if (!admin.apps.length) {
    try {
      const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
    } catch (error) {
      console.error("[Firebase Admin] Initialization error:", error.message);
      throw new Error("Firebase Admin konnte nicht initialisiert werden");
    }
  }
  return admin;
}

/**
 * Verifiziert Firebase ID Token aus Authorization Header
 * @param {Request} req
 * @returns {Promise<{uid: string, email?: string}>} Decoded token
 * @throws {Error} Wenn Token ungültig oder fehlt
 */
export async function verifyFirebaseToken(req) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new Error("Authorization header fehlt oder ist ungültig");
  }

  const idToken = authHeader.split("Bearer ")[1];

  if (!idToken || idToken.length === 0) {
    throw new Error("Token ist leer");
  }

  try {
    const fb = getFirebaseAdmin();
    const decodedToken = await fb.auth().verifyIdToken(idToken);
    return decodedToken;
  } catch (error) {
    console.error("[Auth] Token verification failed:", error.code);
    throw new Error("Token-Verifizierung fehlgeschlagen");
  }
}

/**
 * Prüft ob ein User Admin-Rechte hat
 * @param {string} uid - User ID
 * @returns {Promise<boolean>}
 */
export async function isUserAdmin(uid) {
  try {
    const fb = getFirebaseAdmin();
    const userDoc = await fb.firestore().doc(`users/${uid}`).get();

    if (!userDoc.exists) {
      return false;
    }

    const userData = userDoc.data();
    return userData.isAdmin === true;
  } catch (error) {
    console.error("[Auth] Admin check error:", error);
    return false;
  }
}

/**
 * Middleware: Verifiziert dass der Request von einem Admin kommt
 * Sendet automatisch Error-Responses bei Fehlern
 *
 * @param {Request} req
 * @param {Response} res
 * @returns {Promise<{uid: string, email?: string} | null>} User-Daten oder null bei Fehler
 */
export async function requireAdmin(req, res) {
  try {
    // Token verifizieren
    const decodedToken = await verifyFirebaseToken(req);

    // Admin-Status prüfen
    const isAdmin = await isUserAdmin(decodedToken.uid);

    if (!isAdmin) {
      res.status(403).json({
        success: false,
        error: "Keine Admin-Berechtigung"
      });
      return null;
    }

    // User ist authentifiziert und Admin
    return decodedToken;

  } catch (error) {
    console.error("[Auth] requireAdmin error:", error.message);

    // Generische Error-Messages für Production
    const isDev = process.env.NODE_ENV === "development";
    const errorMessage = isDev
      ? error.message
      : "Authentifizierung fehlgeschlagen";

    res.status(401).json({
      success: false,
      error: errorMessage
    });

    return null;
  }
}

/**
 * Middleware: Verifiziert dass der Request authentifiziert ist (kein Admin erforderlich)
 *
 * @param {Request} req
 * @param {Response} res
 * @returns {Promise<{uid: string, email?: string} | null>} User-Daten oder null bei Fehler
 */
export async function requireAuth(req, res) {
  try {
    const decodedToken = await verifyFirebaseToken(req);
    return decodedToken;
  } catch (error) {
    console.error("[Auth] requireAuth error:", error.message);

    const isDev = process.env.NODE_ENV === "development";
    const errorMessage = isDev
      ? error.message
      : "Authentifizierung fehlgeschlagen";

    res.status(401).json({
      success: false,
      error: errorMessage
    });

    return null;
  }
}

/**
 * CORS Helper für Vercel API Routes
 * @param {Response} res
 */
export function setCorsHeaders(res) {
  const allowedOrigin = process.env.FRONTEND_URL || "";
  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

/**
 * Rate Limiting Helper (einfache In-Memory Implementierung)
 * Für Production: Redis oder externe Rate-Limiting Service nutzen
 */
const rateLimitMap = new Map();

export function checkRateLimit(uid, maxRequests = 10, windowMs = 60000) {
  const now = Date.now();
  const userRequests = rateLimitMap.get(uid) || [];

  // Entferne alte Requests außerhalb des Zeitfensters
  const recentRequests = userRequests.filter(timestamp => now - timestamp < windowMs);

  if (recentRequests.length >= maxRequests) {
    return false; // Rate limit exceeded
  }

  // Füge aktuellen Request hinzu
  recentRequests.push(now);
  rateLimitMap.set(uid, recentRequests);

  return true; // Request erlaubt
}
