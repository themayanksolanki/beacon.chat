const { BREVO_API_KEY, BREVO_FROM, BREVO_FROM_NAME, APP_DOWNLOAD_URL } = process.env;

const FROM_ADDRESS = BREVO_FROM ?? "no-reply@beaconchat.app";
const FROM_NAME = BREVO_FROM_NAME ?? "Beacon";

/** Sends via Brevo's HTTP API when configured; otherwise logs, so local dev needs no email account. */
async function sendMail(to: string, subject: string, text: string): Promise<void> {
  if (!BREVO_API_KEY) {
    console.log(`[email stub] To: ${to}\nSubject: ${subject}\n\n${text}`);
    return;
  }

  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "api-key": BREVO_API_KEY,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      sender: { email: FROM_ADDRESS, name: FROM_NAME },
      to: [{ email: to }],
      subject,
      textContent: text,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`brevo_failed_${res.status}: ${body}`);
  }
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
