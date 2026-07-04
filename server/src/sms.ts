/**
 * Stub SMS sender. Swap this out for Twilio/SNS/etc. in production — the
 * rest of the auth flow only depends on this function's signature.
 */
export async function sendOtpSms(phoneNumber: string, code: string): Promise<void> {
  console.log(`[sms stub] OTP for ${phoneNumber}: ${code}`);
}
