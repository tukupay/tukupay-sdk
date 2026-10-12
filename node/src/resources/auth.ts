import type { Transport } from "../transport.js";
import type { LoginRequest, Message, PhoneVerification, RegisterRequest, Tokens } from "../types.js";

/** Registering and signing in. These need the API key but no user yet. */
export class AuthResource {
  constructor(private readonly transport: Transport) {}

  /**
   * Registers a user under this key's app. Leave `app_id` out: the app comes
   * from the key. The user receives an OTP by SMS; pass it to `verifyPhone()`.
   */
  register(user: RegisterRequest): Promise<Message> {
    return this.transport.request("POST", "/sdk/auth/register", { body: user });
  }

  /**
   * Confirms a new user's phone with the OTP they received after registering.
   * A user cannot sign in until this is done.
   */
  verifyPhone(verification: PhoneVerification): Promise<Message> {
    return this.transport.request("POST", "/sdk/auth/verify-phone", { body: verification });
  }

  /** Sends the phone verification OTP again, for a user who did not get it. */
  sendPhoneVerification(phoneNumber: string): Promise<Message> {
    return this.transport.request("POST", "/sdk/auth/send-phone-verification", {
      body: { phone_number: phoneNumber },
    });
  }

  /** Signs a user in. Their phone must be verified. Pass the result to `tuku.asUser()`. */
  login(credentials: LoginRequest): Promise<Tokens> {
    return this.transport.request("POST", "/sdk/auth/login", { body: credentials });
  }

  /** Exchanges a refresh token for a new pair. The old refresh token stops working. */
  refresh(refreshToken: string): Promise<Tokens> {
    return this.transport.request("POST", "/sdk/auth/refresh", {
      headers: { Authorization: `Bearer ${refreshToken}` },
    });
  }
}
