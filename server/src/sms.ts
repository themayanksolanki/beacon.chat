const { MSG91_AUTH_KEY, MSG91_SENDER_ID, MSG91_TEMPLATE_ID } = process.env;

/**
 * Sends via MSG91's Flow (template) API when fully configured; otherwise
 * logs, same fallback shape as email.ts's sendMail so local dev needs no SMS
 * account. Unlike Brevo's plain send API, MSG91's Flow API expects a
 * pre-approved DLT template id — its own OTP widget (which generates and
 * verifies the code on MSG91's side) is deliberately not used here, since
 * this app already owns OTP generation/hashing/expiry/attempts (see
 * otp.ts/otpChallenge.ts) exactly the way it owns email OTPs; MSG91 is only
 * ever the SMS transport for a code this server already generated.
 */
async function sendSms(to: string, templateVars: Record<string, string>): Promise<void> {
  if (!MSG91_AUTH_KEY || !MSG91_SENDER_ID || !MSG91_TEMPLATE_ID) {
    console.log(`[sms stub] To: ${to}\n${JSON.stringify(templateVars)}`);
    return;
  }

  // MSG91 wants the mobile number without the leading '+' (e.g. "919876543210").
  const mobile = to.replace(/^\+/, "");

  const res = await fetch("https://control.msg91.com/api/v5/flow/", {
    method: "POST",
    headers: {
      authkey: MSG91_AUTH_KEY,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      flow_id: MSG91_TEMPLATE_ID,
      sender: MSG91_SENDER_ID,
      mobiles: mobile,
      ...templateVars,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`msg91_failed_${res.status}: ${body}`);
  }
}

export async function sendOtpSms(phoneNumber: string, code: string): Promise<void> {
  // VAR1 is the conventional placeholder name for the first variable slot in
  // an MSG91 DLT template ("Your OTP is ##VAR1##..."); adjust to match
  // whatever variable names the real approved template actually uses once
  // MSG91_TEMPLATE_ID is set.
  await sendSms(phoneNumber, { VAR1: code });
}
