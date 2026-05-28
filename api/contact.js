const { Resend } = require("resend");

// Where submissions are delivered.
const TO_ADDRESS = "info@bluemustangstudios.com";
// Sender must be on a domain verified in Resend (see setup notes).
const FROM_ADDRESS = "Blue Mustang Studios <info@bluemustangstudios.com>";

// Lazy-init Resend (cached across warm invocations).
let resend;
function getResend() {
  if (!resend) {
    resend = new Resend(process.env.RESEND_API_KEY);
  }
  return resend;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

module.exports = async function handler(req, res) {
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
    const { name, email, website, message, _honey } = req.body || {};

    // Honeypot: a bot filled the hidden field. Pretend success so it doesn't retry.
    if (_honey) {
      return res.status(200).json({ ok: true });
    }

    if (!name || !email || !message) {
      return res
        .status(400)
        .json({ error: "Name, email, and message are required." });
    }

    const trimmedEmail = String(email).trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      return res.status(400).json({ error: "Please enter a valid email address." });
    }

    const safeName = escapeHtml(name).slice(0, 200);
    const safeEmail = escapeHtml(trimmedEmail).slice(0, 200);
    const safeWebsite = website ? escapeHtml(website).slice(0, 300) : "(not provided)";
    const safeMessage = escapeHtml(message).slice(0, 5000).replace(/\n/g, "<br>");

    const { error } = await getResend().emails.send({
      from: FROM_ADDRESS,
      to: [TO_ADDRESS],
      replyTo: trimmedEmail,
      subject: `New contact form submission from ${safeName}`,
      html: `
        <h2>New contact form submission</h2>
        <p><strong>Name:</strong> ${safeName}</p>
        <p><strong>Email:</strong> ${safeEmail}</p>
        <p><strong>Website:</strong> ${safeWebsite}</p>
        <p><strong>Message:</strong></p>
        <p>${safeMessage}</p>
      `,
      text:
        `New contact form submission\n\n` +
        `Name: ${name}\n` +
        `Email: ${trimmedEmail}\n` +
        `Website: ${website || "(not provided)"}\n\n` +
        `Message:\n${message}`,
    });

    if (error) {
      console.error("Resend error:", error);
      return res.status(502).json({ error: "Could not send right now." });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Contact error:", err);
    return res.status(500).json({ error: "Something went wrong. Please try again." });
  }
};
