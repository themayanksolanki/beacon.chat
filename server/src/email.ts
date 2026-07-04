import nodemailer from "nodemailer";

const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM, APP_DOWNLOAD_URL } = process.env;

const transporter =
  SMTP_HOST && SMTP_USER && SMTP_PASS
    ? nodemailer.createTransport({
        host: SMTP_HOST,
        port: SMTP_PORT ? Number(SMTP_PORT) : 587,
        secure: Number(SMTP_PORT) === 465,
        auth: { user: SMTP_USER, pass: SMTP_PASS },
      })
    : null;

const FROM_ADDRESS = SMTP_FROM ?? SMTP_USER ?? "no-reply@beaconchat.app";

/** Sends via SMTP when configured; otherwise logs, so local dev needs no email account. */
async function sendMail(to: string, subject: string, text: string): Promise<void> {
  if (!transporter) {
    console.log(`[email stub] To: ${to}\nSubject: ${subject}\n\n${text}`);
    return;
  }

  await transporter.sendMail({ from: FROM_ADDRESS, to, subject, text });
}

export async function sendOtpEmail(email: string, code: string): Promise<void> {
  await sendMail(
    email,
    "Your Beacon verification code",
    `Your Beacon verification code is ${code}. It expires in 5 minutes.`
  );
}

/** Invites someone who isn't on Beacon yet, via a real email with a join link. */
export async function sendInviteEmail(toEmail: string, inviterName: string): Promise<void> {
  const downloadUrl = APP_DOWNLOAD_URL ?? "https://beaconchat.app/download";
  await sendMail(
    toEmail,
    `${inviterName} invited you to Beacon`,
    `${inviterName} is using Beacon to chat and wants you to join.\n\nGet the app: ${downloadUrl}`
  );
}
