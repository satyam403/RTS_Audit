import 'dotenv/config';
import nodemailer from 'nodemailer';

const REQUIRED = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'ALERT_TO'];

/** Which SMTP vars are missing — used to warn early instead of only at alert time. */
export function missingMailConfig() {
  return REQUIRED.filter((k) => !process.env[k]);
}

/**
 * Best-effort alert email. Never throws: a broken mailbox must not take the
 * nightly run down with it — the failure is logged and the caller carries on.
 */
export async function sendAlert(subject, body) {
  const missing = missingMailConfig();
  if (missing.length) {
    console.warn(`[notify] Email not configured (missing: ${missing.join(', ')}) — alert not sent.`);
    console.warn(`[notify] Would have sent: ${subject}`);
    return false;
  }

  const port = Number(process.env.SMTP_PORT || 587);

  try {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465, // 465 = implicit TLS, 587 = STARTTLS
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });

    await transporter.sendMail({
      from: process.env.ALERT_FROM || process.env.SMTP_USER,
      to: process.env.ALERT_TO,
      subject,
      text: body,
    });

    console.log(`[notify] Alert emailed to ${process.env.ALERT_TO}`);
    return true;
  } catch (err) {
    console.error(`[notify] Failed to send alert: ${err.message}`);
    return false;
  }
}
