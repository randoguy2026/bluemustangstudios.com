const admin = require("firebase-admin");

const MAX_TESTERS = 20;

function formatPrivateKey(key) {
  // Remove surrounding quotes if present
  key = key.replace(/^["']|["']$/g, "");
  // Replace literal \n with actual newlines
  key = key.replace(/\\n/g, "\n");
  return key;
}

// Lazy-init Firebase (cached across warm invocations)
let db;
function getFirestore() {
  if (!db) {
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: formatPrivateKey(process.env.FIREBASE_PRIVATE_KEY || ""),
        }),
      });
    }
    db = admin.firestore();
  }
  return db;
}

module.exports = async function handler(req, res) {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { email } = req.body || {};

    if (!email || typeof email !== "string") {
      return res.status(400).json({ error: "Email is required" });
    }

    const normalizedEmail = email.trim().toLowerCase();

    if (!normalizedEmail.endsWith("@gmail.com")) {
      return res.status(400).json({
        error: "Please enter a Gmail address. Android beta testing requires a Google account.",
      });
    }

    const firestore = getFirestore();
    const signupsRef = firestore.collection("signups");

    // Check for duplicate
    const existing = await signupsRef
      .where("email", "==", normalizedEmail)
      .limit(1)
      .get();

    if (!existing.empty) {
      const doc = existing.docs[0].data();
      return res.status(409).json({
        error: "This email is already signed up!",
        status: doc.status,
      });
    }

    // Count current testers
    const testerCount = await signupsRef
      .where("status", "==", "tester")
      .count()
      .get();

    const currentTesters = testerCount.data().count;
    const status = currentTesters < MAX_TESTERS ? "tester" : "standby";

    // Calculate position (for standby, show their place in line)
    const totalCount = await signupsRef.count().get();
    const position = totalCount.data().count + 1;

    // Save to Firestore
    await signupsRef.add({
      email: normalizedEmail,
      status,
      position,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.status(200).json({
      status,
      position,
      message:
        status === "tester"
          ? "You're in! Check your Gmail for an invite from Google Play."
          : `You're on the standby list (position #${position - MAX_TESTERS}). We'll let you know if a spot opens up.`,
    });
  } catch (error) {
    console.error("Signup error:", error);
    return res.status(500).json({
      error: "Something went wrong. Please try again.",
    });
  }
};
