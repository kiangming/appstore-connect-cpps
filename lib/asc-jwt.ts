import { SignJWT, importPKCS8 } from "jose";

export async function generateAscToken(): Promise<string> {
  const keyId = process.env.ASC_KEY_ID;
  const issuerId = process.env.ASC_ISSUER_ID;
  const privateKeyPem = process.env.ASC_PRIVATE_KEY;

  if (!keyId || !issuerId || !privateKeyPem) {
    throw new Error(
      "Missing ASC credentials: ASC_KEY_ID, ASC_ISSUER_ID, ASC_PRIVATE_KEY must be set"
    );
  }

  // ASC private key is a PKCS#8 .p8 file content (may need newline normalization)
  const normalizedKey = privateKeyPem.replace(/\\n/g, "\n");

  const privateKey = await importPKCS8(normalizedKey, "ES256");

  const now = Math.floor(Date.now() / 1000);

  const token = await new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: keyId, typ: "JWT" })
    .setIssuer(issuerId)
    .setAudience("appstoreconnect-v1")
    .setIssuedAt(now)
    .setExpirationTime(now + 20 * 60) // 20 minutes max per ASC docs
    .sign(privateKey);

  return token;
}
