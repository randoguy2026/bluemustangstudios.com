const admin = require("firebase-admin");
const { google } = require("googleapis");

const MAX_TESTERS = 20;

// Lazy-init Firebase (cached across warm invocations)
let db;
function getFirestore() {
  if (!db) {
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
        }),
      });
    }
    db = admin.firestore();
  }
  return db;
}

// Get authenticated Google Play Developer API client
async function getPlayClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.FIREBASE_CLIENT_EMAIL,
      private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    },
    scopes: ["https://www.googleapis.com/auth/androidpublisher"],
  });
  return google.androidpublisher({ version: "v3", auth });
}

// Sync all tester emails to the Google Play closed testing track
async function syncTestersToPlayConsole(testerEmails) {
  const play = await getPlayClient();
  const packageName = process.env.GOOGLE_PLAY_PACKAGE_NAME;
  const track = process.env.GOOGLE_PLAY_TRACK || "closed";

  // Create an edit
  const { data: edit } = await play.edits.insert({ packageName });

  // Set the full tester list
  await play.edits.testers.patch({
    packageName,
    editId: edit.id,
    track,
    requestBody: {
      googleGroups: [],
      googlePlusCommunities: [],
      testers: testerEmails.map((email) => ({ email })),
    },
  });

  // Commit the edit
  await play.edits.commit({ packageName, editId: edit.id });
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

    // If tester, sync to Google Play Console
    if (status === "tester") {
      try {
        // Get all tester emails to sync the full list
        const allTesters = await signupsRef
          .where("status", "==", "tester")
          .get();
        const testerEmails = allTesters.docs.map((doc) => doc.data().email);
        await syncTestersToPlayConsole(testerEmails);
      } catch (playError) {
        // Log but don't fail the signup — they're saved in Firestore
        // You can manually sync later if the Play API call fails
        console.error("Google Play API sync failed:", playError.message);
      }
    }

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
    return res.status(500).json({ error: "Something went wrong. Please try again." });
  }
};
