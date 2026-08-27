export interface VerificationEmail {
  email: string;
  displayName: string;
  token: string;
  expiresAt: Date;
}

/**
 * Delivery is an infrastructure boundary: production must provide an adapter
 * backed by a real email provider. The auth module never reports a verification
 * email as accepted until this promise resolves.
 */
export interface VerificationEmailSender {
  sendVerificationEmail(message: VerificationEmail): Promise<void>;
}
