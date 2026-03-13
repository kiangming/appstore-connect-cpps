import { SignJWT, importPKCS8 } from "jose";
import type { AscCredentials } from "@/lib/asc-accounts";

export type { AscCredentials };

export async function generateAscToken(creds: AscCredentials): Promise<string> {
  // ASC private key is a PKCS#8 .p8 file content (may need newline normalization)
  const normalizedKey = creds.privateKey.replace(/\\n/g, "\n");

  const privateKey = await importPKCS8(normalizedKey, "ES256");

  const now = Math.floor(Date.now() / 1000);

  const token = await new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: creds.keyId, typ: "JWT" })
    .setIssuer(creds.issuerId)
    .setAudience("appstoreconnect-v1")
    .setIssuedAt(now)
    .setExpirationTime(now + 20 * 60) // 20 minutes max per ASC docs
    .sign(privateKey);

  return token;
}
